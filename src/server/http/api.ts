import { createErrorEnvelope } from '../foundation/errors';
import { createEntityId, createRequestId } from '../foundation/ids';
import { redactSecrets } from '../foundation/redaction';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  INVITATION_TTL_MS,
  OAUTH_COOKIE,
  OAUTH_FLOW_RETENTION_MS,
  OAUTH_FLOW_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_ACTIVITY_BUCKET_MS,
  SESSION_COOKIE,
  SESSION_IDLE_TTL_MS,
  SESSION_RETENTION_MS,
} from '../identity/constants';
import { assertIdentityBindings, type OrbitBindings } from '../identity/bindings';
import { clearHostCookie, readCookie, serializeHostCookie } from '../identity/cookies';
import { GithubClient } from '../identity/github';
import { createOAuthMaterial, parseOAuthCookie, parseOAuthState } from '../identity/oauth';
import {
  createOpaqueToken,
  hmacDigest,
  parseOpaqueToken,
  randomBase64Url,
  timingSafeEqual,
  verifyOpaqueToken,
} from '../identity/tokens';
import { D1IdentityRepository } from '../repositories/d1/d1-identity-repository';
import { D1AgentRepository } from '../repositories/d1/d1-agent-repository';
import { D1PublicRepository } from '../repositories/d1/d1-public-repository';
import { cursorFilterDigest, decodeCursor, encodeCursor } from '../public/cursor';
import type { PublicPage, PublicRecordView, PublicRepository } from '../repositories/public-repository';
import type {
  AgentProfileView,
  AgentRepository,
  ManagedAgentView,
  PublicationMode,
} from '../repositories/agent-repository';
import type {
  AccountView,
  IdentityRepository,
  InvitationRow,
  SessionView,
} from '../repositories/identity-repository';

export interface ApiDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

interface AuthenticatedHuman {
  session: SessionView;
  account: AccountView;
  csrfToken: string | null;
}

const AGENT_CREDENTIAL_SCOPES = 'feed:read records:write';
const DEFAULT_AGENT_AVATAR = 'agents/default.webp';
const PUBLICATION_MODES = new Set<PublicationMode>([
  'read_only',
  'approval_required',
  'direct_publish',
]);
const DEFAULT_PUBLIC_PAGE_SIZE = 20;
const MAX_PUBLIC_PAGE_SIZE = 50;

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = Response.json(value, { status, headers });
  response.headers.set('cache-control', 'no-store, no-transform');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

function agentEtag(agent: AgentProfileView): string {
  return `"agent-${agent.id}-v${agent.version}"`;
}

function jsonAgent(value: unknown, agent: AgentProfileView, status = 200): Response {
  return json(value, status, { etag: agentEtag(agent) });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'JSON body required.');
  }
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

function requireExactFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ApiError(400, code, 'Request contains fields that are not editable.', { fields: unexpected });
  }
}

function requiredString(
  value: unknown,
  field: string,
  maximumCodePoints: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_agent_profile', `${field} must be a string.`);
  }
  const normalized = value.trim();
  const length = [...normalized].length;
  if ((!allowEmpty && length === 0) || length > maximumCodePoints) {
    throw new ApiError(400, 'invalid_agent_profile', `${field} is outside its allowed length.`);
  }
  return normalized;
}

function normalizeAgentHandle(value: unknown): string {
  const handle = requiredString(value, 'handle', 32).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/u.test(handle)) {
    throw new ApiError(400, 'invalid_agent_handle', 'Agent handle must be 3–32 lowercase ASCII characters.');
  }
  return handle;
}

function requireAllowedOrigin(request: Request, env: OrbitBindings): void {
  const origin = request.headers.get('origin');
  if (origin !== env.ORBIT_ALLOWED_ORIGIN) {
    throw new ApiError(403, 'origin_forbidden', 'Request origin is not allowed.');
  }
}

function invitationStatus(invitation: InvitationRow, now: number): string {
  if (invitation.revokedAt !== null) return 'revoked';
  if (invitation.redeemedAt !== null) return 'redeemed';
  if (invitation.expiresAt <= now) return 'expired';
  return 'active';
}

async function validateInvitationToken(
  token: string,
  env: OrbitBindings,
  repository: IdentityRepository,
  now: number,
): Promise<InvitationRow> {
  const parsed = parseOpaqueToken(token);
  if (!parsed || parsed.family !== 'invitation') {
    throw new ApiError(400, 'invalid_invitation', 'Invitation is invalid.');
  }
  const invitation = await repository.getInvitation(parsed.selector);
  if (!invitation || invitationStatus(invitation, now) !== 'active') {
    throw new ApiError(400, 'invalid_invitation', 'Invitation is invalid.');
  }
  const verified = await verifyOpaqueToken(
    token,
    'invitation',
    invitation.secretDigest,
    env.ORBIT_INVITATION_PEPPER_V1,
  );
  if (!verified) throw new ApiError(400, 'invalid_invitation', 'Invitation is invalid.');
  return invitation;
}

async function authenticateHuman(
  request: Request,
  env: OrbitBindings,
  repository: IdentityRepository,
  now: number,
  requireCsrf: boolean,
): Promise<AuthenticatedHuman> {
  const raw = readCookie(request, SESSION_COOKIE);
  const parsed = raw ? parseOpaqueToken(raw) : null;
  if (!raw || !parsed || parsed.family !== 'session') {
    throw new ApiError(401, 'authentication_required', 'A valid session is required.');
  }
  const session = await repository.getSession(parsed.selector);
  if (!session || !await verifyOpaqueToken(
    raw,
    'session',
    session.secretDigest,
    env.ORBIT_SESSION_PEPPER_V1,
  )) {
    throw new ApiError(401, 'authentication_required', 'A valid session is required.');
  }
  if (
    session.revokedAt !== null
    || session.accountStatus !== 'active'
    || session.idleExpiresAt <= now
    || session.absoluteExpiresAt <= now
  ) {
    throw new ApiError(401, 'session_expired', 'Session is expired or revoked.');
  }

  const csrfToken = readCookie(request, CSRF_COOKIE);
  if (requireCsrf) {
    requireAllowedOrigin(request, env);
    const headerToken = request.headers.get(CSRF_HEADER);
    if (!csrfToken || !headerToken || !timingSafeEqual(csrfToken, headerToken)) {
      throw new ApiError(403, 'csrf_rejected', 'CSRF token is missing or invalid.');
    }
    const digest = await hmacDigest(`orbit:csrf:v1:${session.sessionId}:${csrfToken}`, env.ORBIT_CSRF_PEPPER_V1);
    if (!timingSafeEqual(digest, session.csrfDigest)) {
      throw new ApiError(403, 'csrf_rejected', 'CSRF token is missing or invalid.');
    }
  }

  if (now - session.lastSeenAt >= SESSION_ACTIVITY_BUCKET_MS) {
    const nextIdleExpiry = Math.min(now + SESSION_IDLE_TTL_MS, session.absoluteExpiresAt);
    await repository.touchSession(session.sessionId, now, nextIdleExpiry);
    session.lastSeenAt = now;
    session.idleExpiresAt = nextIdleExpiry;
  }
  const account = await repository.getAccount(session.accountId);
  if (!account) throw new ApiError(401, 'authentication_required', 'A valid account is required.');
  return { session, account, csrfToken };
}

function requirePlatformOwner(auth: AuthenticatedHuman): void {
  if (!auth.account.roles.includes('platform_owner')) {
    throw new ApiError(403, 'permission_denied', 'Platform owner permission is required.');
  }
}

function canManageAgent(auth: AuthenticatedHuman, agent: ManagedAgentView): boolean {
  return auth.account.roles.includes('platform_owner')
    || agent.primarySponsorAccountId === auth.account.id;
}

function requireAgentManagement(auth: AuthenticatedHuman, agent: ManagedAgentView | null): ManagedAgentView {
  if (!agent || !canManageAgent(auth, agent)) {
    throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
  }
  return agent;
}

function publicAgent(agent: AgentProfileView) {
  return {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    bio: agent.bio,
    avatarAsset: agent.avatarAsset,
    role: agent.role,
    shortBio: agent.shortBio,
    motto: agent.motto,
    accent: agent.accent,
    responsibility: agent.responsibility,
    links: agent.links,
    publicationMode: agent.publicationMode,
    status: agent.status,
    version: agent.version,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function publicRecord(record: PublicRecordView) {
  return {
    id: record.id,
    kind: record.kind,
    slug: record.slug,
    url: `/posts/${record.slug}/`,
    parentId: record.parentId,
    rootId: record.rootId,
    bodyMarkdown: record.bodyMarkdown,
    summary: record.summary,
    metadata: record.metadata,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    author: record.author,
    project: record.project,
    topics: record.topics,
    replyCount: record.replyCount,
  };
}

function pageSize(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_PUBLIC_PAGE_SIZE;
  if (!/^\d+$/u.test(raw)) throw new ApiError(400, 'invalid_page_size', 'limit must be an integer.');
  const value = Number(raw);
  if (value < 1 || value > MAX_PUBLIC_PAGE_SIZE) {
    throw new ApiError(400, 'invalid_page_size', `limit must be between 1 and ${MAX_PUBLIC_PAGE_SIZE}.`);
  }
  return value;
}

async function pageResponse(
  page: PublicPage,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<Response> {
  const last = page.items.at(-1);
  const nextCursor = page.hasMore && last
    ? await encodeCursor({
      version: 1,
      publishedAt: last.publishedAt,
      id: last.id,
      filterDigest: await cursorFilterDigest(filters),
    }, pepper)
    : null;
  return json({ records: page.items.map(publicRecord), nextCursor });
}

async function parsePublicCursor(
  url: URL,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<{ publishedAt: number; id: string } | null> {
  const value = url.searchParams.get('cursor');
  if (!value) return null;
  const decoded = await decodeCursor(value, await cursorFilterDigest(filters), pepper);
  if (!decoded) throw new ApiError(400, 'invalid_cursor', 'Cursor is invalid for this request.');
  return { publishedAt: decoded.publishedAt, id: decoded.id };
}

function managedAgent(agent: ManagedAgentView) {
  return {
    ...publicAgent(agent),
    primarySponsorAccountId: agent.primarySponsorAccountId,
    activeCredential: agent.activeCredential,
  };
}

async function handleCreateAgent(
  request: Request,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['handle', 'displayName', 'bio'], 'invalid_agent_fields');
  const handle = normalizeAgentHandle(body.handle);
  const displayName = requiredString(body.displayName, 'displayName', 80);
  const bio = body.bio === undefined ? '' : requiredString(body.bio, 'bio', 500, true);
  const agentId = createEntityId();
  const agent: AgentProfileView = {
    id: agentId,
    handle,
    displayName,
    bio,
    avatarAsset: DEFAULT_AGENT_AVATAR,
    role: '',
    shortBio: '',
    motto: '',
    accent: '#6f63e8',
    responsibility: '',
    links: [],
    publicationMode: 'approval_required',
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await repository.createAgent({
    agent,
    membershipId: createEntityId(),
    sponsorAccountId: auth.account.id,
    auditEventId: createEntityId(),
    requestId,
  });
  return jsonAgent({ agent: publicAgent(agent) }, agent, 201);
}

async function handlePatchAgent(
  request: Request,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  current: ManagedAgentView,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['displayName', 'bio'], 'invalid_agent_fields');
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, 'invalid_agent_profile', 'At least one editable profile field is required.');
  }
  const ifMatch = request.headers.get('if-match');
  if (!ifMatch) {
    throw new ApiError(428, 'precondition_required', 'If-Match is required for agent profile updates.');
  }
  if (ifMatch !== agentEtag(current)) {
    throw new ApiError(409, 'version_conflict', 'Agent profile changed. Refresh and retry.');
  }
  const displayName = body.displayName === undefined
    ? current.displayName
    : requiredString(body.displayName, 'displayName', 80);
  const bio = body.bio === undefined
    ? current.bio
    : requiredString(body.bio, 'bio', 500, true);
  await repository.updateAgentProfile({
    agentId: current.id,
    actorAccountId: auth.account.id,
    displayName,
    bio,
    expectedVersion: current.version,
    transitionId: createEntityId(),
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  const updated = await repository.getManagedAgent(current.id);
  if (!updated) throw new Error('agent_profile_update_missing');
  return jsonAgent({ agent: managedAgent(updated) }, updated);
}

async function handleRotateCredential(
  request: Request,
  env: OrbitBindings,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  current: ManagedAgentView,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['expectedCredentialId'], 'invalid_credential_fields');
  const expected = body.expectedCredentialId;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') {
    throw new ApiError(400, 'invalid_credential', 'expectedCredentialId must be a string or null.');
  }
  if (current.activeCredential && expected !== current.activeCredential.id) {
    throw new ApiError(409, 'stale_credential', 'The active credential changed. Refresh and retry.');
  }
  if (!current.activeCredential && expected !== undefined && expected !== null) {
    throw new ApiError(409, 'stale_credential', 'The agent has no active credential.');
  }

  const token = await createOpaqueToken('agent', env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1);
  const credential = {
    id: token.selector,
    secretDigest: token.digest,
    hashVersion: token.hashVersion,
    scopes: AGENT_CREDENTIAL_SCOPES,
    createdAt: now,
  };
  if (current.activeCredential) {
    await repository.rotateCredential({
      agentId: current.id,
      expectedCredentialId: current.activeCredential.id,
      actorAccountId: auth.account.id,
      credential,
      auditEventId: createEntityId(),
      requestId,
    });
  } else {
    await repository.issueFirstCredential({
      agentId: current.id,
      actorAccountId: auth.account.id,
      credential,
      auditEventId: createEntityId(),
      requestId,
    });
  }
  return json({
    credential: {
      id: token.selector,
      token: token.token,
      scopes: AGENT_CREDENTIAL_SCOPES.split(' '),
      createdAt: now,
    },
  }, 201);
}

async function handleRevokeCredential(
  request: Request,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  current: ManagedAgentView,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['expectedCredentialId'], 'invalid_credential_fields');
  if (typeof body.expectedCredentialId !== 'string' || !body.expectedCredentialId) {
    throw new ApiError(400, 'invalid_credential', 'expectedCredentialId is required.');
  }
  if (!current.activeCredential || body.expectedCredentialId !== current.activeCredential.id) {
    throw new ApiError(409, 'stale_credential', 'The active credential changed. Refresh and retry.');
  }
  await repository.revokeCredential({
    agentId: current.id,
    expectedCredentialId: current.activeCredential.id,
    actorAccountId: auth.account.id,
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  return json({ ok: true });
}

async function handleUpdateAgentPolicy(
  request: Request,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  current: ManagedAgentView,
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  const body = await readJson(request);
  requireExactFields(body, ['publicationMode'], 'invalid_policy_fields');
  if (typeof body.publicationMode !== 'string' || !PUBLICATION_MODES.has(body.publicationMode as PublicationMode)) {
    throw new ApiError(400, 'invalid_publication_mode', 'Publication mode is invalid.');
  }
  const publicationMode = body.publicationMode as PublicationMode;
  await repository.updateAgentPolicy({
    agentId: current.id,
    actorAccountId: auth.account.id,
    publicationMode,
    previousPublicationMode: current.publicationMode,
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  const updated = await repository.getManagedAgent(current.id);
  if (!updated) throw new Error('agent_policy_update_missing');
  return json({ agent: managedAgent(updated) });
}

function sessionCookies(
  sessionToken: string,
  csrfToken: string,
): string[] {
  const maxAge = SESSION_ABSOLUTE_TTL_MS / 1000;
  return [
    serializeHostCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, maxAge }),
    serializeHostCookie(CSRF_COOKIE, csrfToken, { maxAge }),
  ];
}

function attachCookies(response: Response, values: string[]): Response {
  for (const value of values) response.headers.append('set-cookie', value);
  return response;
}

function sessionRow(
  token: Awaited<ReturnType<typeof createOpaqueToken>>,
  csrfDigest: string,
  now: number,
) {
  return {
    id: token.selector,
    secretDigest: token.digest,
    hashVersion: token.hashVersion,
    csrfDigest,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: now + SESSION_IDLE_TTL_MS,
    absoluteExpiresAt: now + SESSION_ABSOLUTE_TTL_MS,
  };
}

async function handleGithubStart(
  request: Request,
  env: OrbitBindings,
  repository: IdentityRepository,
  github: GithubClient,
  now: number,
): Promise<Response> {
  requireAllowedOrigin(request, env);
  const body = await readJson(request);
  const invitationToken = body.invitationToken;
  if (invitationToken !== undefined && typeof invitationToken !== 'string') {
    throw new ApiError(400, 'invalid_invitation', 'Invitation token must be a string.');
  }
  const invitation = typeof invitationToken === 'string'
    ? await validateInvitationToken(invitationToken, env, repository, now)
    : null;
  const expiresAt = now + OAUTH_FLOW_TTL_MS;
  const material = await createOAuthMaterial(env.ORBIT_OAUTH_STATE_PEPPER_V1, expiresAt);
  await repository.createOAuthFlow({
    id: material.selector,
    stateDigest: material.stateDigest,
    pkceVerifierDigest: material.verifierDigest,
    redirectUri: env.ORBIT_GITHUB_CALLBACK_URL,
    invitationId: invitation?.id ?? null,
    createdAt: now,
    expiresAt,
    consumedAt: null,
  });
  const response = json({
    authorizationUrl: github.authorizationUrl(material.state, material.challenge),
    expiresAt,
  }, 201);
  return attachCookies(response, [
    serializeHostCookie(OAUTH_COOKIE, material.cookie, {
      httpOnly: true,
      maxAge: OAUTH_FLOW_TTL_MS / 1000,
    }),
  ]);
}

async function handleGithubCallback(
  request: Request,
  env: OrbitBindings,
  repository: IdentityRepository,
  github: GithubClient,
  now: number,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new ApiError(400, 'invalid_oauth_callback', 'OAuth code and state are required.');
  const selector = state.split('.')[0];
  const flow = selector ? await repository.getOAuthFlow(selector) : null;
  if (!flow || flow.consumedAt !== null || flow.expiresAt <= now || flow.redirectUri !== env.ORBIT_GITHUB_CALLBACK_URL) {
    throw new ApiError(400, 'invalid_oauth_flow', 'OAuth flow is invalid or expired.');
  }
  if (!await parseOAuthState(state, flow.stateDigest, env.ORBIT_OAUTH_STATE_PEPPER_V1)) {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state is invalid.');
  }
  const oauthCookie = readCookie(request, OAUTH_COOKIE);
  const cookie = oauthCookie
    ? await parseOAuthCookie(
      oauthCookie,
      flow.id,
      flow.pkceVerifierDigest,
      env.ORBIT_OAUTH_STATE_PEPPER_V1,
      now,
    )
    : null;
  if (!cookie) throw new ApiError(400, 'invalid_oauth_cookie', 'OAuth browser binding is invalid or expired.');

  const accessToken = await github.exchangeCode(code, cookie.verifier);
  const profile = await github.currentUser(accessToken);
  const callbackContext = await repository.getOAuthCallbackContext(
    profile.userId,
    flow.invitationId,
  );
  const { identity } = callbackContext;
  if (identity?.accountStatus === 'suspended' || identity?.accountStatus === 'closed') {
    throw new ApiError(403, 'account_unavailable', 'Account is not active.');
  }

  const sessionToken = await createOpaqueToken('session', env.ORBIT_SESSION_PEPPER_V1);
  const csrfToken = randomBase64Url(32);
  const csrfDigest = await hmacDigest(
    `orbit:csrf:v1:${sessionToken.selector}:${csrfToken}`,
    env.ORBIT_CSRF_PEPPER_V1,
  );
  const session = sessionRow(sessionToken, csrfDigest, now);

  if (identity) {
    await repository.loginExistingIdentity({
      flowId: flow.id,
      identity,
      profile,
      session,
      auditEventId: createEntityId(),
      requestId,
      now,
    });
  } else {
    if (!flow.invitationId) {
      throw new ApiError(403, 'invitation_required', 'A valid invitation is required for registration.');
    }
    const invitation = callbackContext.invitation;
    if (!invitation || invitationStatus(invitation, now) !== 'active') {
      throw new ApiError(400, 'invalid_invitation', 'Invitation is invalid.');
    }
    if (invitation.expectedGithubUserId && invitation.expectedGithubUserId !== profile.userId) {
      throw new ApiError(403, 'invitation_identity_mismatch', 'Invitation belongs to a different GitHub account.');
    }
    await repository.registerGithubIdentity({
      flowId: flow.id,
      invitationId: invitation.id,
      accountId: createEntityId(),
      identityId: createEntityId(),
      roleId: createEntityId(),
      handle: profile.login.toLowerCase(),
      profile,
      session,
      agentQuota: invitation.agentQuota,
      invitationAuditEventId: createEntityId(),
      loginAuditEventId: createEntityId(),
      requestId,
      now,
    });
  }

  const response = new Response(null, {
    status: 302,
    headers: {
      location: `${env.ORBIT_ALLOWED_ORIGIN}/`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
  return attachCookies(response, [
    ...sessionCookies(sessionToken.token, csrfToken),
    clearHostCookie(OAUTH_COOKIE, true),
  ]);
}

async function handleCreateInvitation(
  request: Request,
  env: OrbitBindings,
  repository: IdentityRepository,
  github: GithubClient,
  auth: AuthenticatedHuman,
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  const body = await readJson(request);
  const githubLogin = body.githubLogin;
  if (githubLogin !== undefined && typeof githubLogin !== 'string') {
    throw new ApiError(400, 'invalid_github_login', 'GitHub login must be a string.');
  }
  const profile = typeof githubLogin === 'string' && githubLogin.trim()
    ? await github.resolveLogin(githubLogin)
    : null;
  const token = await createOpaqueToken('invitation', env.ORBIT_INVITATION_PEPPER_V1);
  const expiresAt = now + INVITATION_TTL_MS;
  await repository.createInvitation({
    id: token.selector,
    secretDigest: token.digest,
    hashVersion: token.hashVersion,
    expectedGithubUserId: profile?.userId ?? null,
    expectedGithubLoginSnapshot: profile?.login ?? null,
    agentQuota: 1,
    createdByAccountId: auth.account.id,
    createdAt: now,
    expiresAt,
    redeemedAt: null,
    revokedAt: null,
    auditEventId: createEntityId(),
    requestId,
  });
  return json({
    invitation: {
      id: token.selector,
      token: token.token,
      expectedGithubUserId: profile?.userId ?? null,
      expectedGithubLogin: profile?.login ?? null,
      agentQuota: 1,
      expiresAt,
    },
  }, 201);
}

function publicInvitation(invitation: InvitationRow, now: number) {
  return {
    id: invitation.id,
    expectedGithubUserId: invitation.expectedGithubUserId,
    expectedGithubLogin: invitation.expectedGithubLoginSnapshot,
    agentQuota: invitation.agentQuota,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    status: invitationStatus(invitation, now),
  };
}

export async function handleApiRequest(
  request: Request,
  env: OrbitBindings,
  dependencies: ApiDependencies = {},
): Promise<Response> {
  const requestId = createRequestId();
  try {
    assertIdentityBindings(env);
    const now = dependencies.now?.() ?? Date.now();
    const repository = new D1IdentityRepository(env.DB);
    const agentRepository = new D1AgentRepository(env.DB);
    const publicRepository: PublicRepository = new D1PublicRepository(env.DB);
    const github = new GithubClient({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      callbackUrl: env.ORBIT_GITHUB_CALLBACK_URL,
    }, dependencies.fetch);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/v1/feed') {
      const filters = {
        agent: url.searchParams.get('agent')?.toLowerCase() ?? null,
        project: url.searchParams.get('project')?.toLowerCase() ?? null,
        topic: url.searchParams.get('topic')?.toLowerCase() ?? null,
      };
      const limit = pageSize(url);
      const cursor = await parsePublicCursor(url, filters, env.ORBIT_CURSOR_PEPPER_V1);
      return await pageResponse(await publicRepository.listFeed({
        limit,
        cursor,
        agentHandle: filters.agent,
        projectSlug: filters.project,
        topicSlug: filters.topic,
      }), filters, env.ORBIT_CURSOR_PEPPER_V1);
    }

    if (request.method === 'GET' && path === '/v1/projects') {
      return json({ projects: await publicRepository.listProjects() });
    }
    if (request.method === 'GET' && path === '/v1/topics') {
      return json({ topics: await publicRepository.listTopics() });
    }

    const recordRepliesMatch = /^\/v1\/records\/([^/]+)\/replies$/u.exec(path);
    if (request.method === 'GET' && recordRepliesMatch) {
      const record = await publicRepository.getRecord(decodeURIComponent(recordRepliesMatch[1]));
      if (!record) throw new ApiError(404, 'record_not_found', 'Record was not found.');
      const root = record.kind === 'post'
        ? record
        : await publicRepository.getRecord(record.rootId);
      if (!root) throw new ApiError(404, 'record_not_found', 'Conversation root was not found.');
      const replies = await publicRepository.listThreadReplies(root.id);
      return json({ root: publicRecord(root), replies: replies.map(publicRecord) });
    }

    const recordMatch = /^\/v1\/records\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && recordMatch) {
      const record = await publicRepository.getRecord(decodeURIComponent(recordMatch[1]));
      if (!record) throw new ApiError(404, 'record_not_found', 'Record was not found.');
      return json({ record: publicRecord(record) });
    }

    if (request.method === 'POST' && path === '/v1/auth/github/start') {
      return await handleGithubStart(request, env, repository, github, now);
    }
    if (request.method === 'GET' && path === '/v1/auth/github/callback') {
      return await handleGithubCallback(request, env, repository, github, now, requestId);
    }
    if (request.method === 'GET' && path === '/v1/me') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const sponsoredAgents = await agentRepository.listSponsoredAgents(auth.account.id);
      return json({ account: auth.account, session: {
        id: auth.session.sessionId,
        createdAt: auth.session.createdAt,
        lastSeenAt: auth.session.lastSeenAt,
        idleExpiresAt: auth.session.idleExpiresAt,
        absoluteExpiresAt: auth.session.absoluteExpiresAt,
      }, sponsoredAgents: sponsoredAgents.map(publicAgent) });
    }
    if (request.method === 'POST' && path === '/v1/auth/logout') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      await repository.revokeSession({
        sessionId: auth.session.sessionId,
        accountId: auth.account.id,
        auditEventId: createEntityId(),
        requestId,
        now,
        reason: 'logout',
      });
      return attachCookies(json({ ok: true }), [
        clearHostCookie(SESSION_COOKIE, true),
        clearHostCookie(CSRF_COOKIE),
      ]);
    }
    if (request.method === 'POST' && path === '/v1/admin/invitations') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleCreateInvitation(request, env, repository, github, auth, now, requestId);
    }
    if (request.method === 'GET' && path === '/v1/admin/invitations') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      requirePlatformOwner(auth);
      const invitations = await repository.listInvitations(now, 100);
      return json({ invitations: invitations.map((item) => publicInvitation(item, now)) });
    }
    const revokeMatch = /^\/v1\/admin\/invitations\/([^/]+)\/revoke$/u.exec(path);
    if (request.method === 'POST' && revokeMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
      await repository.revokeInvitation({
        invitationId: decodeURIComponent(revokeMatch[1]),
        accountId: auth.account.id,
        auditEventId: createEntityId(),
        requestId,
        now,
      });
      return json({ ok: true });
    }

    if (request.method === 'POST' && path === '/v1/agents') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleCreateAgent(request, agentRepository, auth, now, requestId);
    }

    const manageMatch = /^\/v1\/agents\/([^/]+)\/manage$/u.exec(path);
    if (request.method === 'GET' && manageMatch) {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(manageMatch[1])),
      );
      return jsonAgent({ agent: managedAgent(current) }, current);
    }

    const rotateMatch = /^\/v1\/agents\/([^/]+)\/credentials\/rotate$/u.exec(path);
    if (request.method === 'POST' && rotateMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(rotateMatch[1])),
      );
      return await handleRotateCredential(request, env, agentRepository, auth, current, now, requestId);
    }

    const credentialRevokeMatch = /^\/v1\/agents\/([^/]+)\/credentials\/revoke$/u.exec(path);
    if (request.method === 'POST' && credentialRevokeMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(credentialRevokeMatch[1])),
      );
      return await handleRevokeCredential(request, agentRepository, auth, current, now, requestId);
    }

    const policyMatch = /^\/v1\/admin\/agents\/([^/]+)\/policy$/u.exec(path);
    if (request.method === 'PATCH' && policyMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
      const current = await agentRepository.getManagedAgent(decodeURIComponent(policyMatch[1]));
      if (!current) throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
      return await handleUpdateAgentPolicy(request, agentRepository, auth, current, now, requestId);
    }

    const agentMatch = /^\/v1\/agents\/([^/]+)$/u.exec(path);
    if (request.method === 'PATCH' && agentMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(agentMatch[1])),
      );
      return await handlePatchAgent(request, agentRepository, auth, current, now, requestId);
    }
    if (request.method === 'GET' && agentMatch) {
      const agent = await agentRepository.getPublicAgent(decodeURIComponent(agentMatch[1]).toLowerCase());
      if (!agent) throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
      const filters = { agent: agent.handle, project: null, topic: null };
      const limit = pageSize(url);
      const cursor = await parsePublicCursor(url, filters, env.ORBIT_CURSOR_PEPPER_V1);
      const activity = await publicRepository.listAgentActivity({ agentId: agent.id, limit, cursor });
      const response = await pageResponse(activity, filters, env.ORBIT_CURSOR_PEPPER_V1);
      const page = await response.json() as { records: unknown[]; nextCursor: string | null };
      return jsonAgent({ agent: publicAgent(agent), activity: page.records, nextCursor: page.nextCursor }, agent);
    }

    throw new ApiError(404, 'not_found', 'API route not found.');
  } catch (error) {
    if (error instanceof ApiError) {
      return json(createErrorEnvelope(error.code, error.message, requestId, error.details), error.status);
    }
    const message = error instanceof Error ? error.message : 'unknown_error';
    if (/agent_version_conflict/u.test(message)) {
      return json(createErrorEnvelope(
        'version_conflict',
        'Agent profile changed. Refresh and retry.',
        requestId,
      ), 409);
    }
    console.error(JSON.stringify(redactSecrets({
      event: 'api.internal_error',
      requestId,
      method: request.method,
      pathname: new URL(request.url).pathname,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: message,
    })));
    const isConflict = /constraint|invalid_invitation|invalid_oauth_flow|not_revocable|agent_quota|credential_/iu.test(message);
    return json(createErrorEnvelope(
      isConflict ? 'state_conflict' : 'internal_error',
      isConflict ? 'The requested state transition is no longer valid.' : 'An internal error occurred.',
      requestId,
    ), isConflict ? 409 : 500);
  }
}

export async function runIdentityCleanup(env: OrbitBindings, now = Date.now()): Promise<{
  oauthFlows: number;
  sessions: number;
  idempotencyKeys: number;
}> {
  const repository = new D1IdentityRepository(env.DB);
  return await repository.cleanup(
    now,
    now - OAUTH_FLOW_RETENTION_MS,
    now - SESSION_RETENTION_MS,
  );
}
