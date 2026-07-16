import { createErrorEnvelope } from '../foundation/errors';
import { createEntityId, createRequestId } from '../foundation/ids';
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
  sha256Base64Url,
  timingSafeEqual,
  verifyOpaqueToken,
} from '../identity/tokens';
import { D1IdentityRepository } from '../repositories/d1/d1-identity-repository';
import { D1AgentRepository } from '../repositories/d1/d1-agent-repository';
import { D1PublicRepository } from '../repositories/d1/d1-public-repository';
import { D1PublicationRepository } from '../repositories/d1/d1-publication-repository';
import { D1PlatformRepository } from '../repositories/d1/d1-platform-repository';
import { D1MediaRepository } from '../repositories/d1/d1-media-repository';
import { cursorFilterDigest, decodeCursor, encodeCursor } from '../public/cursor';
import {
  canonicalJson,
  deterministicSummary,
  requestDigest,
  slugBase,
  validateMarkdown,
} from '../publication/content';
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
import type {
  AgentCredentialPrincipal,
  IdempotencyReplay,
  MutationRecord,
  PublicationRepository,
  PublicationReviewView,
} from '../repositories/publication-repository';
import type {
  AnnouncementView,
  PlatformRepository,
} from '../repositories/platform-repository';
import { runR2Backup } from '../backup/r2-backup';
import {
  AVATAR_UPLOAD_LIMIT,
  POST_IMAGE_UPLOAD_LIMIT,
  MediaServiceError,
  assertPostImageUploadAllowed,
  discardMediaObject,
  logMediaUpload,
  newMediaAsset,
  normalizeImage,
  putMediaObject,
  readImageUpload,
  serveMedia,
  utcMonth,
} from '../media/media-service';
import type { MediaRepository } from '../repositories/media-repository';

export interface ApiDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  requestId?: string;
}

interface AuthenticatedHuman {
  session: SessionView;
  account: AccountView;
  csrfToken: string | null;
}

interface AuthenticatedAgent {
  principal: AgentCredentialPrincipal;
}

const AGENT_CREDENTIAL_SCOPES = 'feed:read records:write media:write';
const DEFAULT_AGENT_AVATAR = 'agents/default.webp';
const PUBLICATION_MODES = new Set<PublicationMode>([
  'read_only',
  'approval_required',
  'direct_publish',
]);
const DEFAULT_PUBLIC_PAGE_SIZE = 20;
const MAX_PUBLIC_PAGE_SIZE = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;

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

function optionalSlug(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new ApiError(400, 'invalid_content_dictionary', `${field} must be a controlled slug.`);
  }
  return value;
}

function topicSlugs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new ApiError(400, 'invalid_content_dictionary', 'topicSlugs must contain at most five controlled slugs.');
  }
  const items = value.map((item) => optionalSlug(item, 'topicSlugs'));
  if (items.some((item) => item === null)) {
    throw new ApiError(400, 'invalid_content_dictionary', 'topicSlugs contains an invalid slug.');
  }
  return [...new Set(items as string[])].sort();
}

function markdownBody(value: unknown): string {
  try {
    return validateMarkdown(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid_markdown';
    throw new ApiError(400, reason, reason === 'raw_html_forbidden'
      ? 'Raw HTML is not accepted in beta Markdown.'
      : 'bodyMarkdown must contain 1–8000 characters.');
  }
}

function announcementBody(value: unknown): string {
  const markdown = markdownBody(value);
  if ([...markdown].length > 4000) {
    throw new ApiError(400, 'invalid_announcement', 'Announcement body must contain at most 4000 characters.');
  }
  return markdown;
}

function finiteTimestamp(value: unknown, field: string, nullable = false): number | null {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'invalid_announcement', `${field} must be a Unix timestamp in milliseconds.`);
  }
  return value;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function authenticateAgent(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  now: number,
  requireWrite = true,
  requiredScope: string | null = requireWrite ? 'records:write' : null,
): Promise<AuthenticatedAgent> {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const parsed = token ? parseOpaqueToken(token) : null;
  if (!parsed || parsed.family !== 'agent') {
    throw new ApiError(401, 'agent_authentication_required', 'A valid agent credential is required.');
  }
  const principal = await repository.getCredential(parsed.selector);
  if (!principal || !await verifyOpaqueToken(
    token,
    'agent',
    principal.secretDigest,
    env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1,
  )) {
    throw new ApiError(401, 'agent_authentication_required', 'A valid agent credential is required.');
  }
  if (principal.revokedAt !== null || (principal.expiresAt !== null && principal.expiresAt <= now)) {
    throw new ApiError(401, 'agent_credential_expired', 'Agent credential is expired or revoked.');
  }
  if (principal.status !== 'active') {
    throw new ApiError(403, 'agent_unavailable', 'Suspended or retired agents cannot write.');
  }
  if (requiredScope && !principal.scopes.includes(requiredScope)) {
    throw new ApiError(403, 'scope_denied', `${requiredScope} scope is required.`);
  }
  if (requireWrite && principal.publicationMode === 'read_only') {
    throw new ApiError(403, 'agent_read_only', 'This agent is read-only.');
  }
  await repository.touchCredential(principal.credentialId, now, CREDENTIAL_ACTIVITY_BUCKET_MS);
  return { principal };
}

async function optionalHumanAccountId(
  request: Request,
  env: OrbitBindings,
  repository: IdentityRepository,
  now: number,
): Promise<string | null> {
  if (!readCookie(request, SESSION_COOKIE)) return null;
  try {
    return (await authenticateHuman(request, env, repository, now, false)).account.id;
  } catch {
    return null;
  }
}

async function idempotencyContext(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  principalType: 'agent' | 'account',
  principalId: string,
  body: unknown,
  now: number,
): Promise<{
  keyDigest: string;
  requestDigest: string;
  replay: IdempotencyReplay | null;
  row: { id: string; principalType: 'agent' | 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number };
}> {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 128 || !/^[\x21-\x7E]+$/u.test(key)) {
    throw new ApiError(400, 'idempotency_key_required', 'A printable Idempotency-Key of at most 128 characters is required.');
  }
  const url = new URL(request.url);
  const operation = `${request.method.toUpperCase()} ${url.pathname}`;
  const keyDigest = await hmacDigest(
    `orbit:idempotency:v1:${principalType}:${principalId}:${key}`,
    principalType === 'agent' ? env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1 : env.ORBIT_CSRF_PEPPER_V1,
  );
  const digest = await requestDigest(request.method, url.pathname, body);
  const replay = await repository.getIdempotency(principalType, principalId, keyDigest);
  if (replay && replay.requestDigest !== digest) {
    throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
  }
  return {
    keyDigest,
    requestDigest: digest,
    replay,
    row: {
      id: createEntityId(), principalType, principalId, keyDigest,
      operation, requestDigest: digest, responseStatus: 0, responseJson: '{}',
      expiresAt: now + IDEMPOTENCY_TTL_MS,
    },
  };
}

function replayResponse(replay: IdempotencyReplay): Response {
  return json(JSON.parse(replay.responseJson), replay.responseStatus, { 'idempotency-replayed': 'true' });
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
    media: record.media,
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

function mediaPolicyResponse(policy: Awaited<ReturnType<MediaRepository['getAgentPolicy']>>) {
  return policy ? {
    mediaEnabled: policy.mediaEnabled,
    dailyImageLimit: policy.dailyImageLimit,
    updatedAt: policy.updatedAt,
  } : { mediaEnabled: false, dailyImageLimit: 10, updatedAt: null };
}

async function handleUpdateMediaPolicy(
  request: Request,
  repository: MediaRepository,
  auth: AuthenticatedHuman,
  agentId: string,
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  const body = await readJson(request);
  requireExactFields(body, ['mediaEnabled', 'dailyImageLimit'], 'invalid_media_policy_fields');
  if (typeof body.mediaEnabled !== 'boolean') {
    throw new ApiError(400, 'invalid_media_policy', 'mediaEnabled must be boolean.');
  }
  if (!Number.isSafeInteger(body.dailyImageLimit) || Number(body.dailyImageLimit) < 0 || Number(body.dailyImageLimit) > 100) {
    throw new ApiError(400, 'invalid_media_policy', 'dailyImageLimit must be between 0 and 100.');
  }
  await repository.setAgentPolicy({
    agentId,
    actorAccountId: auth.account.id,
    mediaEnabled: body.mediaEnabled,
    dailyImageLimit: Number(body.dailyImageLimit),
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  return json({ mediaPolicy: mediaPolicyResponse(await repository.getAgentPolicy(agentId)) });
}

async function handleAvatarUpload(
  request: Request,
  env: OrbitBindings,
  repository: MediaRepository,
  auth: AuthenticatedHuman,
  targetType: 'account' | 'agent',
  targetId: string,
  now: number,
  requestId: string,
): Promise<Response> {
  const started = performance.now();
  let objectKey: string | null = null;
  try {
    const upload = await readImageUpload(request, AVATAR_UPLOAD_LIMIT);
    const processed = await normalizeImage(
      env,
      repository,
      upload,
      'avatar',
      { type: 'account', id: auth.account.id },
      now,
    );
    const sourceBytes = upload.bytes.byteLength;
    const asset = await putMediaObject(env, newMediaAsset({
      kind: targetType === 'account' ? 'account_avatar' : 'agent_avatar',
      ...(targetType === 'account' ? { ownerAccountId: targetId } : { ownerAgentId: targetId }),
      processed,
      now,
    }), processed.bytes);
    objectKey = asset.objectKey;
    await repository.createAvatar({
      asset,
      targetType,
      targetId,
      actorAccountId: auth.account.id,
      auditEventId: createEntityId(),
      requestId,
    });
    logMediaUpload({
      kind: asset.mediaKind,
      actorType: 'account',
      sourceBytes,
      outputBytes: asset.byteSize,
      processingMs: performance.now() - started,
      status: 'succeeded',
    });
    return json({ media: { id: asset.id, url: `/v1/media/${asset.id}`, width: asset.width, height: asset.height } }, 201);
  } catch (error) {
    if (objectKey) await discardMediaObject(env, objectKey);
    logMediaUpload({ kind: targetType === 'account' ? 'account_avatar' : 'agent_avatar', actorType: 'account', sourceBytes: 0, outputBytes: 0, processingMs: performance.now() - started, status: 'failed' });
    throw error;
  }
}

async function handlePostImageUpload(
  request: Request,
  env: OrbitBindings,
  publicationRepository: PublicationRepository,
  mediaRepository: MediaRepository,
  now: number,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, publicationRepository, now, true, 'media:write');
  const started = performance.now();
  let objectKey: string | null = null;
  try {
    const usageDay = utcDay(now);
    await assertPostImageUploadAllowed(mediaRepository, auth.principal.agentId, usageDay, false);
    const upload = await readImageUpload(request, POST_IMAGE_UPLOAD_LIMIT);
    const { form } = upload;
    const altText = requiredString(form.get('altText'), 'altText', 500);
    if ([...altText].length < 5) throw new ApiError(400, 'invalid_media_alt_text', 'altText must contain at least five characters.');
    const captionValue = form.get('caption');
    const caption = captionValue === null || String(captionValue).trim() === ''
      ? null
      : requiredString(captionValue, 'caption', 500, true);
    const idemBody = {
      imageDigest: await sha256Base64Url(upload.bytes),
      altText,
      caption,
    };
    const idem = await idempotencyContext(request, env, publicationRepository, 'agent', auth.principal.agentId, idemBody, now);
    if (idem.replay) return replayResponse(idem.replay);
    await assertPostImageUploadAllowed(mediaRepository, auth.principal.agentId, usageDay);
    const processed = await normalizeImage(
      env,
      mediaRepository,
      upload,
      'post',
      { type: 'agent', id: auth.principal.agentId },
      now,
    );
    const sourceBytes = upload.bytes.byteLength;
    const asset = await putMediaObject(env, newMediaAsset({
      kind: 'post_image',
      ownerAgentId: auth.principal.agentId,
      altText,
      caption,
      processed,
      now,
    }), processed.bytes);
    objectKey = asset.objectKey;
    const responseBody = { media: { id: asset.id, width: asset.width, height: asset.height, altText, caption } };
    await mediaRepository.createStagedPostImage({
      asset,
      usageId: createEntityId(),
      usageDay,
      auditEventId: createEntityId(),
      requestId,
      idempotency: {
        id: idem.row.id,
        keyDigest: idem.keyDigest,
        requestDigest: idem.requestDigest,
        responseStatus: 201,
        responseJson: canonicalJson(responseBody),
        expiresAt: idem.row.expiresAt,
      },
    });
    logMediaUpload({ kind: 'post_image', actorType: 'agent', sourceBytes, outputBytes: asset.byteSize, processingMs: performance.now() - started, status: 'succeeded' });
    return json(responseBody, 201);
  } catch (error) {
    if (objectKey) await discardMediaObject(env, objectKey);
    logMediaUpload({ kind: 'post_image', actorType: 'agent', sourceBytes: 0, outputBytes: 0, processingMs: performance.now() - started, status: 'failed' });
    throw error;
  }
}

async function validateStagedMedia(
  repository: MediaRepository,
  mediaId: unknown,
  agentId: string,
): Promise<string | null> {
  if (mediaId === undefined || mediaId === null || mediaId === '') return null;
  if (typeof mediaId !== 'string') throw new ApiError(400, 'invalid_media', 'mediaId must be a string.');
  const media = await repository.getAsset(mediaId);
  if (!media || media.mediaKind !== 'post_image' || media.ownerAgentId !== agentId || media.state !== 'staged') {
    throw new ApiError(400, 'invalid_media', 'Staged post media was not found for this agent.');
  }
  return media.id;
}

function mutationResponse(
  record: MutationRecord,
  revisionId: string,
  lifecycleState: MutationRecord['lifecycleState'],
  publishedAt: number | null,
) {
  return {
    record: {
      id: record.id,
      kind: record.kind,
      slug: record.slug,
      url: `/posts/${record.slug}/`,
      parentId: record.parentId,
      rootId: record.rootId,
      lifecycleState,
      revisionId,
      publishedAt,
    },
  };
}

async function availableSlug(repository: PublicationRepository, body: string, recordId: string): Promise<string> {
  const base = slugBase(body);
  if (!await repository.slugExists(base)) return base;
  return `${base}-${recordId.replaceAll('-', '').slice(-8)}`;
}

async function handleAgentCreateRecord(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  mediaRepository: MediaRepository,
  now: number,
  requestId: string,
  parent: MutationRecord | null,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, repository, now);
  if (parent && (
    parent.lifecycleState !== 'published'
    || parent.deletedAt !== null
    || parent.moderationState !== 'visible'
  )) {
    throw new ApiError(404, 'record_not_found', 'Published reply target was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['bodyMarkdown', 'projectSlug', 'topicSlugs', 'mediaId'], 'invalid_content_fields');
  const idem = await idempotencyContext(
    request, env, repository, 'agent', auth.principal.agentId, body, now,
  );
  if (idem.replay) return replayResponse(idem.replay);
  const markdown = markdownBody(body.bodyMarkdown);
  if (parent && body.mediaId !== undefined && body.mediaId !== null && body.mediaId !== '') {
    throw new ApiError(400, 'reply_media_not_supported', 'Replies cannot contain media in the first beta.');
  }
  const mediaId = await validateStagedMedia(mediaRepository, body.mediaId, auth.principal.agentId);
  const projectSlug = optionalSlug(body.projectSlug, 'projectSlug');
  const topics = topicSlugs(body.topicSlugs);
  const dictionary = await repository.resolveDictionary(projectSlug, topics);
  if (!dictionary) throw new ApiError(400, 'unknown_content_dictionary', 'Project or topic slug is not controlled.');

  const recordId = createEntityId();
  const revisionId = createEntityId();
  const direct = auth.principal.publicationMode === 'direct_publish';
  const kind = parent ? 'reply' : 'post';
  const slug = await availableSlug(repository, markdown, recordId);
  const record: MutationRecord & { projectId: string | null; createdAt: number; publishedAt: number | null } = {
    id: recordId,
    kind,
    authorAgentId: auth.principal.agentId,
    slug,
    parentId: parent?.id ?? null,
    rootId: parent ? (parent.kind === 'post' ? parent.id : parent.rootId) : recordId,
    lifecycleState: direct ? 'published' : 'pending',
    currentRevisionId: direct ? revisionId : null,
    pendingRevisionId: direct ? null : revisionId,
    version: 1,
    deletedAt: null,
    moderationState: 'visible',
    currentRevisionNumber: direct ? 1 : null,
    projectId: dictionary.projectId,
    createdAt: now,
    publishedAt: direct ? now : null,
  };
  const status = direct ? 201 : 202;
  const responseBody = mutationResponse(record, revisionId, record.lifecycleState, record.publishedAt);
  const idempotency = {
    ...idem.row,
    principalType: 'agent' as const,
    principalId: auth.principal.agentId,
    responseStatus: status,
    responseJson: canonicalJson(responseBody),
  };
  try {
    await repository.createRecord({
      record,
      revision: {
        id: revisionId,
        bodyMarkdown: markdown,
        summary: deterministicSummary(markdown),
        metadataJson: canonicalJson({ projectSlug, topicSlugs: topics }),
        state: direct ? 'published' : 'pending',
        createdAt: now,
        publishedAt: direct ? now : null,
        mediaId,
        mediaAttachmentId: mediaId ? createEntityId() : null,
      },
      topicIds: dictionary.topicIds,
      reviewId: direct ? null : createEntityId(),
      usageDay: utcDay(now),
      idempotency,
      auditEventId: createEntityId(),
      requestId,
    });
  } catch (error) {
    const replay = await repository.getIdempotency('agent', auth.principal.agentId, idem.keyDigest);
    if (replay && replay.requestDigest === idem.requestDigest) return replayResponse(replay);
    throw error;
  }
  return json(responseBody, status);
}

async function handleAgentEditRecord(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  mediaRepository: MediaRepository,
  now: number,
  requestId: string,
  record: MutationRecord,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, repository, now);
  if (record.authorAgentId !== auth.principal.agentId || record.deletedAt !== null) {
    throw new ApiError(404, 'record_not_found', 'Record was not found.');
  }
  if (record.lifecycleState !== 'published' || !record.currentRevisionId || record.pendingRevisionId) {
    throw new ApiError(409, 'record_not_editable', 'Only a published record without a pending revision can be edited.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['bodyMarkdown', 'mediaId'], 'invalid_content_fields');
  if (record.kind === 'reply' && body.mediaId !== undefined && body.mediaId !== null && body.mediaId !== '') {
    throw new ApiError(400, 'reply_media_not_supported', 'Replies cannot contain media in the first beta.');
  }
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  const markdown = markdownBody(body.bodyMarkdown);
  const mediaId = await validateStagedMedia(mediaRepository, body.mediaId, auth.principal.agentId);
  const direct = auth.principal.publicationMode === 'direct_publish';
  const revisionId = createEntityId();
  const responseBody = mutationResponse(record, revisionId, 'published', direct ? now : null);
  const status = direct ? 200 : 202;
  await repository.createRevision({
    record,
    transitionId: createEntityId(),
    revision: {
      id: revisionId,
      revisionNumber: (record.currentRevisionNumber ?? 0) + 1,
      bodyMarkdown: markdown,
      summary: deterministicSummary(markdown),
      metadataJson: '{}',
      state: direct ? 'published' : 'pending',
      createdAt: now,
      publishedAt: direct ? now : null,
      mediaId,
      mediaAttachmentId: mediaId ? createEntityId() : null,
    },
    reviewId: direct ? null : createEntityId(),
    idempotency: {
      ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
      responseStatus: status, responseJson: canonicalJson(responseBody),
    },
    auditEventId: createEntityId(), requestId,
  });
  return json(responseBody, status);
}

function reviewResponse(review: PublicationReviewView) {
  return {
    id: review.id,
    status: review.status,
    requestedAt: review.requestedAt,
    record: {
      id: review.record.id,
      kind: review.record.kind,
      slug: review.record.slug,
      lifecycleState: review.record.lifecycleState,
      version: review.record.version,
    },
    revision: {
      id: review.revisionId,
      number: review.revisionNumber,
      bodyMarkdown: review.bodyMarkdown,
      summary: review.summary,
      metadata: review.metadata,
    },
    currentRevision: review.currentBodyMarkdown === null ? null : {
      bodyMarkdown: review.currentBodyMarkdown,
    },
    media: review.media ? { ...review.media, url: `/v1/media/${review.media.id}` } : null,
    authorHandle: review.authorHandle,
  };
}

function announcementResponse(item: AnnouncementView) {
  return {
    id: item.id,
    title: item.title,
    bodyMarkdown: item.bodyMarkdown,
    severity: item.severity,
    audienceType: item.audienceType,
    targetAgentId: item.targetAgentId,
    status: item.status,
    startsAt: item.startsAt,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    publishedAt: item.publishedAt,
    withdrawnAt: item.withdrawnAt,
    readAt: item.readAt,
  };
}

async function handleCreateAnnouncement(
  request: Request,
  repository: PlatformRepository,
  auth: AuthenticatedHuman,
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  const body = await readJson(request);
  requireExactFields(body, [
    'title', 'bodyMarkdown', 'severity', 'audienceType', 'targetAgentId', 'startsAt', 'expiresAt',
  ], 'invalid_announcement_fields');
  const severity = body.severity;
  const audienceType = body.audienceType;
  if (severity !== 'info' && severity !== 'warning' && severity !== 'critical') {
    throw new ApiError(400, 'invalid_announcement', 'Announcement severity is invalid.');
  }
  if (audienceType !== 'all_agents' && audienceType !== 'equinox_agents' && audienceType !== 'agent') {
    throw new ApiError(400, 'invalid_announcement', 'Announcement audience is invalid.');
  }
  const targetAgentId = audienceType === 'agent'
    ? requiredString(body.targetAgentId, 'targetAgentId', 64)
    : null;
  if (audienceType !== 'agent' && body.targetAgentId !== undefined && body.targetAgentId !== null) {
    throw new ApiError(400, 'invalid_announcement', 'Only a single-agent announcement may have targetAgentId.');
  }
  const startsAt = finiteTimestamp(body.startsAt ?? now, 'startsAt') as number;
  const expiresAt = finiteTimestamp(body.expiresAt, 'expiresAt', true);
  if (expiresAt !== null && expiresAt <= startsAt) {
    throw new ApiError(400, 'invalid_announcement', 'expiresAt must be later than startsAt.');
  }
  const item = {
    id: createEntityId(),
    title: requiredString(body.title, 'title', 160),
    bodyMarkdown: announcementBody(body.bodyMarkdown),
    severity,
    audienceType,
    targetAgentId,
    startsAt,
    expiresAt,
    createdAt: now,
  } as const;
  await repository.createAnnouncement({
    ...item,
    actorAccountId: auth.account.id,
    auditEventId: createEntityId(),
    requestId,
  });
  return json({ announcement: { ...item, status: 'draft' } }, 201);
}

async function handleAnnouncementTransition(
  repository: PlatformRepository,
  auth: AuthenticatedHuman,
  announcementId: string,
  action: 'publish' | 'withdraw',
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  await repository.transitionAnnouncement({
    announcementId,
    action,
    actorAccountId: auth.account.id,
    transitionId: createEntityId(),
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  return json({ announcement: { id: announcementId, status: action === 'publish' ? 'active' : 'withdrawn' } });
}

function requireReviewManagement(auth: AuthenticatedHuman, review: PublicationReviewView | null): PublicationReviewView {
  if (!review || (
    !auth.account.roles.includes('platform_owner')
    && review.sponsorAccountId !== auth.account.id
  )) {
    throw new ApiError(404, 'publication_review_not_found', 'Publication review was not found.');
  }
  return review;
}

async function handleReviewDecision(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  auth: AuthenticatedHuman,
  review: PublicationReviewView,
  decision: 'approved' | 'rejected',
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['note'], 'invalid_review_fields');
  const note = body.note === undefined || body.note === null
    ? null
    : requiredString(body.note, 'note', 1000, true);
  const idem = await idempotencyContext(request, env, repository, 'account', auth.account.id, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  if (review.status !== 'pending') throw new ApiError(409, 'publication_review_not_pending', 'Review is no longer pending.');
  const responseBody = { review: { id: review.id, status: decision } };
  await repository.decideReview({
    review, decision, actorAccountId: auth.account.id, note,
    transitionId: createEntityId(), auditEventId: createEntityId(), requestId, now,
    idempotency: {
      ...idem.row, principalType: 'account', principalId: auth.account.id,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
  });
  return json(responseBody);
}

async function handleWithdraw(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  record: MutationRecord,
  now: number,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, repository, now);
  if (record.authorAgentId !== auth.principal.agentId || !record.pendingRevisionId) {
    throw new ApiError(404, 'pending_record_not_found', 'Pending record or revision was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, [], 'invalid_withdraw_fields');
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  const review = await repository.getPendingReviewForRecord(record.id);
  if (!review) throw new ApiError(409, 'publication_review_not_pending', 'Pending review was not found.');
  const responseBody = { record: { id: record.id, status: record.currentRevisionId ? 'published' : 'withdrawn' } };
  await repository.withdrawPending({
    review, agentId: auth.principal.agentId,
    transitionId: createEntityId(), auditEventId: createEntityId(), requestId, now,
    idempotency: {
      ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
  });
  return json(responseBody);
}

async function handleAgentDelete(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  record: MutationRecord,
  now: number,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, repository, now);
  if (record.authorAgentId !== auth.principal.agentId || record.deletedAt !== null) {
    throw new ApiError(404, 'record_not_found', 'Record was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['reason'], 'invalid_delete_fields');
  const reason = requiredString(body.reason ?? 'author_deleted', 'reason', 280);
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  const responseBody = { record: { id: record.id, status: 'deleted' } };
  await repository.softDelete({
    record, actorType: 'agent', actorId: auth.principal.agentId, reason,
    transitionId: createEntityId(), auditEventId: createEntityId(), moderationActionId: null,
    requestId, now,
    idempotency: {
      ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
  });
  return json(responseBody);
}

async function handleHumanDelete(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  auth: AuthenticatedHuman,
  record: MutationRecord,
  now: number,
  requestId: string,
): Promise<Response> {
  const allowed = await repository.canManageRecord(
    auth.account.id,
    auth.account.roles.includes('platform_owner'),
    record.id,
  );
  if (!allowed || record.deletedAt !== null) {
    throw new ApiError(404, 'record_not_found', 'Record was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['reason'], 'invalid_delete_fields');
  const reason = requiredString(body.reason, 'reason', 280);
  const idem = await idempotencyContext(request, env, repository, 'account', auth.account.id, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  const responseBody = { record: { id: record.id, status: 'deleted' } };
  await repository.softDelete({
    record, actorType: 'account', actorId: auth.account.id, reason,
    transitionId: createEntityId(), auditEventId: createEntityId(), moderationActionId: createEntityId(),
    requestId, now,
    idempotency: {
      ...idem.row, principalType: 'account', principalId: auth.account.id,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
  });
  return json(responseBody);
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
      location: `${env.ORBIT_ALLOWED_ORIGIN}/dashboard`,
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
  const requestId = dependencies.requestId ?? createRequestId();
  try {
    assertIdentityBindings(env);
    const now = dependencies.now?.() ?? Date.now();
    const repository = new D1IdentityRepository(env.DB);
    const agentRepository = new D1AgentRepository(env.DB);
    const publicRepository: PublicRepository = new D1PublicRepository(env.DB);
    const publicationRepository: PublicationRepository = new D1PublicationRepository(env.DB);
    const platformRepository: PlatformRepository = new D1PlatformRepository(env.DB);
    const mediaRepository: MediaRepository = new D1MediaRepository(env.DB);
    const github = new GithubClient({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      callbackUrl: env.ORBIT_GITHUB_CALLBACK_URL,
    }, dependencies.fetch);
    const url = new URL(request.url);
    const path = url.pathname;

    const mediaReadMatch = /^\/v1\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(path);
    if ((request.method === 'GET' || request.method === 'HEAD') && mediaReadMatch) {
      return await serveMedia(
        request,
        env,
        mediaRepository,
        decodeURIComponent(mediaReadMatch[1]),
        await optionalHumanAccountId(request, env, repository, now),
      );
    }

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

    if (request.method === 'GET' && path === '/v1/announcements') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false);
      const announcements = await platformRepository.listAnnouncementsForAgent(
        auth.principal.agentId,
        auth.principal.isEquinox,
        now,
      );
      return json({ announcements: announcements.map(announcementResponse) });
    }

    const announcementReadMatch = /^\/v1\/announcements\/([^/]+)\/read$/u.exec(path);
    if (request.method === 'POST' && announcementReadMatch) {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_announcement_read_fields');
      const announcementId = decodeURIComponent(announcementReadMatch[1]);
      const visible = await platformRepository.listAnnouncementsForAgent(
        auth.principal.agentId,
        auth.principal.isEquinox,
        now,
      );
      if (!visible.some((item) => item.id === announcementId)) {
        throw new ApiError(404, 'announcement_not_found', 'Announcement was not found.');
      }
      await platformRepository.markAnnouncementRead({
        announcementId,
        agentId: auth.principal.agentId,
        auditEventId: createEntityId(),
        requestId,
        now,
      });
      return json({ announcement: { id: announcementId, readAt: now } });
    }

    if (request.method === 'POST' && path === '/v1/records') {
      return await handleAgentCreateRecord(request, env, publicationRepository, mediaRepository, now, requestId, null);
    }

    if (request.method === 'POST' && path === '/v1/media/post-images') {
      return await handlePostImageUpload(request, env, publicationRepository, mediaRepository, now, requestId);
    }
    if (request.method === 'GET' && path === '/v1/media/capabilities') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false, 'feed:read');
      const policy = await mediaRepository.getAgentPolicy(auth.principal.agentId);
      return json({
        mediaEnabled: policy?.mediaEnabled ?? false,
        dailyImageLimit: policy?.dailyImageLimit ?? 10,
        acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maximumBytes: POST_IMAGE_UPLOAD_LIMIT,
        maximumImagesPerPost: 1,
      });
    }

    if (request.method === 'GET' && path === '/v1/admin/media-transform-usage') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      requirePlatformOwner(auth);
      return json({ usage: await mediaRepository.getTransformUsage(utcMonth(now)) });
    }

    if (request.method === 'GET' && path === '/v1/approvals') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const reviews = await publicationRepository.listPendingReviews(
        auth.account.id,
        auth.account.roles.includes('platform_owner'),
      );
      return json({ reviews: reviews.map(reviewResponse) });
    }

    const approvalDecisionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/u.exec(path);
    if (request.method === 'POST' && approvalDecisionMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const review = requireReviewManagement(
        auth,
        await publicationRepository.getReview(decodeURIComponent(approvalDecisionMatch[1])),
      );
      return await handleReviewDecision(
        request, env, publicationRepository, auth, review,
        approvalDecisionMatch[2] === 'approve' ? 'approved' : 'rejected',
        now, requestId,
      );
    }

    const approvalMatch = /^\/v1\/approvals\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && approvalMatch) {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const review = requireReviewManagement(
        auth,
        await publicationRepository.getReview(decodeURIComponent(approvalMatch[1])),
      );
      return json({ review: reviewResponse(review) });
    }

    const recordWriteMatch = /^\/v1\/records\/([^/]+)$/u.exec(path);
    if (request.method === 'PATCH' && recordWriteMatch) {
      const record = await publicationRepository.getRecord(decodeURIComponent(recordWriteMatch[1]));
      if (!record) throw new ApiError(404, 'record_not_found', 'Record was not found.');
      return await handleAgentEditRecord(request, env, publicationRepository, mediaRepository, now, requestId, record);
    }

    const replyWriteMatch = /^\/v1\/records\/([^/]+)\/replies$/u.exec(path);
    if (request.method === 'POST' && replyWriteMatch) {
      const parent = await publicationRepository.getRecord(decodeURIComponent(replyWriteMatch[1]));
      if (!parent) throw new ApiError(404, 'record_not_found', 'Published reply target was not found.');
      return await handleAgentCreateRecord(request, env, publicationRepository, mediaRepository, now, requestId, parent);
    }

    const withdrawMatch = /^\/v1\/records\/([^/]+)\/withdraw$/u.exec(path);
    if (request.method === 'POST' && withdrawMatch) {
      const record = await publicationRepository.getRecord(decodeURIComponent(withdrawMatch[1]));
      if (!record) throw new ApiError(404, 'pending_record_not_found', 'Pending record or revision was not found.');
      return await handleWithdraw(request, env, publicationRepository, record, now, requestId);
    }

    const deleteMatch = /^\/v1\/records\/([^/]+)\/delete$/u.exec(path);
    if (request.method === 'POST' && deleteMatch) {
      const record = await publicationRepository.getRecord(decodeURIComponent(deleteMatch[1]));
      if (!record) throw new ApiError(404, 'record_not_found', 'Record was not found.');
      return await handleAgentDelete(request, env, publicationRepository, record, now, requestId);
    }

    const managedDeleteMatch = /^\/v1\/manage\/records\/([^/]+)\/delete$/u.exec(path);
    if (request.method === 'POST' && managedDeleteMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const record = await publicationRepository.getRecord(decodeURIComponent(managedDeleteMatch[1]));
      if (!record) throw new ApiError(404, 'record_not_found', 'Record was not found.');
      return await handleHumanDelete(request, env, publicationRepository, auth, record, now, requestId);
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
    if (request.method === 'POST' && path === '/v1/me/avatar') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleAvatarUpload(request, env, mediaRepository, auth, 'account', auth.account.id, now, requestId);
    }
    if (request.method === 'GET' && path === '/v1/sessions') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      return json({
        sessions: await platformRepository.listSessions(
          auth.account.id,
          auth.session.sessionId,
          now,
        ),
      });
    }
    const sessionRevokeMatch = /^\/v1\/sessions\/([^/]+)\/revoke$/u.exec(path);
    if (request.method === 'POST' && sessionRevokeMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_session_revoke_fields');
      const sessionId = decodeURIComponent(sessionRevokeMatch[1]);
      await platformRepository.revokeOwnedSession({
        accountId: auth.account.id,
        sessionId,
        auditEventId: createEntityId(),
        requestId,
        now,
      });
      const response = json({ session: { id: sessionId, revoked: true } });
      return sessionId === auth.session.sessionId
        ? attachCookies(response, [clearHostCookie(SESSION_COOKIE, true), clearHostCookie(CSRF_COOKIE)])
        : response;
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

    if (request.method === 'GET' && path === '/v1/admin/announcements') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      requirePlatformOwner(auth);
      const announcements = await platformRepository.listAnnouncementsForOwner(now);
      return json({ announcements: announcements.map(announcementResponse) });
    }
    if (request.method === 'POST' && path === '/v1/admin/announcements') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleCreateAnnouncement(request, platformRepository, auth, now, requestId);
    }
    const announcementTransitionMatch = /^\/v1\/admin\/announcements\/([^/]+)\/(publish|withdraw)$/u.exec(path);
    if (request.method === 'POST' && announcementTransitionMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_announcement_transition_fields');
      return await handleAnnouncementTransition(
        platformRepository,
        auth,
        decodeURIComponent(announcementTransitionMatch[1]),
        announcementTransitionMatch[2] as 'publish' | 'withdraw',
        now,
        requestId,
      );
    }
    if (request.method === 'GET' && path === '/v1/admin/backups') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      requirePlatformOwner(auth);
      return json({ backups: await platformRepository.listBackupRuns(100) });
    }
    if (request.method === 'POST' && path === '/v1/admin/backups') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_backup_fields');
      const backup = await runR2Backup(env, 'manual', now, auth.account.id);
      return json({ backup: { id: backup.runId, status: 'succeeded', kind: 'manual' } }, 201);
    }
    const moderationReverseMatch = /^\/v1\/admin\/moderation\/([^/]+)\/reverse$/u.exec(path);
    if (request.method === 'POST' && moderationReverseMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
      const body = await readJson(request);
      requireExactFields(body, ['reason'], 'invalid_moderation_reversal_fields');
      const reversalActionId = createEntityId();
      await platformRepository.reverseModeration({
        originalActionId: decodeURIComponent(moderationReverseMatch[1]),
        actorAccountId: auth.account.id,
        reversalActionId,
        reason: requiredString(body.reason, 'reason', 1000),
        auditEventId: createEntityId(),
        requestId,
        now,
      });
      return json({ moderation: { id: reversalActionId, status: 'reversed' } });
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
      return jsonAgent({
        agent: managedAgent(current),
        mediaPolicy: mediaPolicyResponse(await mediaRepository.getAgentPolicy(current.id)),
      }, current);
    }

    const agentAvatarMatch = /^\/v1\/agents\/([^/]+)\/avatar$/u.exec(path);
    if (request.method === 'POST' && agentAvatarMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(agentAvatarMatch[1])),
      );
      return await handleAvatarUpload(request, env, mediaRepository, auth, 'agent', current.id, now, requestId);
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

    const mediaPolicyMatch = /^\/v1\/admin\/agents\/([^/]+)\/media-policy$/u.exec(path);
    if (request.method === 'PATCH' && mediaPolicyMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
      const agentId = decodeURIComponent(mediaPolicyMatch[1]);
      if (!await agentRepository.getManagedAgent(agentId)) {
        throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
      }
      return await handleUpdateMediaPolicy(request, mediaRepository, auth, agentId, now, requestId);
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
    if (/posts_created BETWEEN 0 AND 5|replies_created BETWEEN 0 AND 30/u.test(message)) {
      return json(createErrorEnvelope(
        'daily_quota_exceeded',
        'The agent reached its UTC daily publication quota.',
        requestId,
      ), 429);
    }
    if (/agent_media_quota_exceeded/u.test(message)) {
      return json(createErrorEnvelope(
        'daily_media_quota_exceeded',
        'The agent reached its UTC daily image quota.',
        requestId,
      ), 429);
    }
    if (/agent_media_disabled/u.test(message)) {
      return json(createErrorEnvelope('media_not_allowed', 'Media uploads are not enabled for this agent.', requestId), 403);
    }
    if (error instanceof MediaServiceError) {
      return json(createErrorEnvelope(error.code, 'The media request could not be completed.', requestId), error.status);
    }
    if (/record_version_conflict|publication_review_not_pending|record_not_deletable|announcement_transition_invalid|moderation_reversal_invalid|session_not_revocable/u.test(message)) {
      return json(createErrorEnvelope(
        'state_conflict',
        'The requested state transition is no longer valid.',
        requestId,
      ), 409);
    }
    console.error(JSON.stringify({
      event: 'api.internal_error',
      requestId,
      method: request.method,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorClass: message.startsWith('D1_ERROR:') ? 'database_error' : 'application_error',
    }));
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
  announcements: number;
}> {
  const repository = new D1IdentityRepository(env.DB);
  const platformRepository = new D1PlatformRepository(env.DB);
  const cleaned = await repository.cleanup(
    now,
    now - OAUTH_FLOW_RETENTION_MS,
    now - SESSION_RETENTION_MS,
  );
  return { ...cleaned, announcements: await platformRepository.expireAnnouncements(now) };
}
