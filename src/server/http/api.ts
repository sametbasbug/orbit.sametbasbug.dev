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
  stageRawImageUpload,
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

const AGENT_CREDENTIAL_SCOPES = 'feed:read records:write media:write profile:write';
const DEFAULT_AGENT_AVATAR = '';
const PUBLICATION_MODES = new Set<PublicationMode>([
  'read_only',
  'approval_required',
  'direct_publish',
]);
const DEFAULT_PUBLIC_PAGE_SIZE = 20;
const MAX_PUBLIC_PAGE_SIZE = 50;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;
const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;

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
  allowPending = false,
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
  if (!allowPending && principal.onboardingState !== 'active') {
    throw new ApiError(403, 'agent_onboarding_incomplete', 'The agent must complete its profile before using Orbit.');
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

async function runIdempotentMutation(
  repository: PublicationRepository,
  principalType: 'agent' | 'account',
  principalId: string,
  keyDigest: string,
  digest: string,
  mutation: () => Promise<void>,
): Promise<Response | null> {
  try {
    await mutation();
    return null;
  } catch (error) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const replay = await repository.getIdempotency(principalType, principalId, keyDigest);
      if (replay) {
        if (replay.requestDigest !== digest) {
          throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
        }
        return replayResponse(replay);
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw error;
  }
}

function mediaReplayResponse(replay: Awaited<ReturnType<MediaRepository['getMediaIdempotency']>>): Response {
  if (!replay || replay.state !== 'completed') throw new Error('media_idempotency_not_completed');
  return json(JSON.parse(replay.responseJson), replay.responseStatus, { 'idempotency-replayed': 'true' });
}

async function mediaIdempotencyContext(
  request: Request,
  env: OrbitBindings,
  repository: MediaRepository,
  principalType: 'account' | 'agent',
  principalId: string,
  body: unknown,
  now: number,
) {
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
  const replay = await repository.getMediaIdempotency(principalType, principalId, keyDigest);
  if (replay && replay.requestDigest !== digest) {
    throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
  }
  return {
    replay,
    requestDigest: digest,
    row: {
      id: createEntityId(), principalType, principalId, keyDigest, operation,
      requestDigest: digest, expiresAt: now + IDEMPOTENCY_TTL_MS,
    },
  };
}

async function waitForMediaReplay(
  repository: MediaRepository,
  principalType: 'account' | 'agent',
  principalId: string,
  keyDigest: string,
  requestDigestValue: string,
): Promise<Response> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const replay = await repository.getMediaIdempotency(principalType, principalId, keyDigest);
    if (replay?.requestDigest !== requestDigestValue) {
      throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
    }
    if (replay?.state === 'completed') return mediaReplayResponse(replay);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new ApiError(409, 'idempotency_in_progress', 'The same request is still being processed.');
}

function decodeOptionalUploadHeader(request: Request, name: string, maximumLength: number): string | null {
  const encoded = request.headers.get(name);
  if (encoded === null || encoded === '') return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new ApiError(400, 'invalid_media_metadata', `${name} is invalid.`);
  try {
    const standard = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - standard.length % 4) % 4);
    const bytes = Uint8Array.from(atob(`${standard}${padding}`), (character) => character.charCodeAt(0));
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if ([...value].length > maximumLength) throw new Error('too_long');
    return value || null;
  } catch {
    throw new ApiError(400, 'invalid_media_metadata', `${name} is invalid.`);
  }
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
    onboardingState: agent.onboardingState,
    onboardingCompletedAt: agent.onboardingCompletedAt,
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
    author: {
      id: record.author.id,
      handle: record.author.handle,
      avatarAsset: record.author.avatarAsset,
      accent: record.author.accent,
      status: record.author.status,
    },
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

async function handleCreateRegistrationCode(
  request: Request,
  env: OrbitBindings,
  repository: AgentRepository,
  auth: AuthenticatedHuman,
  now: number,
  requestId: string,
  current: ManagedAgentView | null = null,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, current ? ['expectedCredentialId'] : [], 'invalid_registration_code_fields');
  if (current) {
    if (!current.activeCredential || body.expectedCredentialId !== current.activeCredential.id) {
      throw new ApiError(409, 'stale_credential', 'The active credential changed. Refresh and retry.');
    }
  }
  const token = await createOpaqueToken('registration', env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1);
  const grant = {
    id: token.selector,
    secretDigest: token.digest,
    hashVersion: token.hashVersion,
    sponsorAccountId: auth.account.id,
    purpose: current ? 'rotate' as const : 'create' as const,
    agentId: current?.id ?? null,
    expectedCredentialId: current?.activeCredential?.id ?? null,
    createdAt: now,
    expiresAt: now + REGISTRATION_CODE_TTL_MS,
    consumedAt: null,
    revokedAt: null,
  };
  await repository.createRegistrationGrant({
    grant,
    auditEventId: createEntityId(),
    requestId,
  });
  return json({
    registrationCode: {
      token: token.token,
      purpose: grant.purpose,
      expiresAt: grant.expiresAt,
      agentId: grant.agentId,
    },
  }, 201);
}

async function validateRegistrationCode(
  code: string,
  env: OrbitBindings,
  repository: AgentRepository,
  now: number,
) {
  const parsed = parseOpaqueToken(code);
  if (!parsed || parsed.family !== 'registration') {
    throw new ApiError(400, 'invalid_registration_code', 'Registration code is invalid or expired.');
  }
  const grant = await repository.getRegistrationGrant(parsed.selector);
  if (
    !grant
    || grant.consumedAt !== null
    || grant.revokedAt !== null
    || grant.expiresAt <= now
    || !await verifyOpaqueToken(
      code,
      'registration',
      grant.secretDigest,
      env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1,
    )
  ) {
    throw new ApiError(400, 'invalid_registration_code', 'Registration code is invalid or expired.');
  }
  return grant;
}

async function handleRedeemRegistrationCode(
  request: Request,
  env: OrbitBindings,
  repository: AgentRepository,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['code', 'handle', 'bio'], 'invalid_registration_fields');
  const code = requiredString(body.code, 'code', 160);
  const grant = await validateRegistrationCode(code, env, repository, now);
  const token = await createOpaqueToken('agent', env.ORBIT_AGENT_CREDENTIAL_PEPPER_V1);
  const credential = {
    id: token.selector,
    secretDigest: token.digest,
    hashVersion: token.hashVersion,
    scopes: AGENT_CREDENTIAL_SCOPES,
    createdAt: now,
  };

  if (grant.purpose === 'rotate') {
    if (body.handle !== undefined || body.bio !== undefined || !grant.agentId || !grant.expectedCredentialId) {
      throw new ApiError(400, 'invalid_registration_fields', 'Credential renewal accepts only the registration code.');
    }
    await repository.rotateCredentialWithGrant({
      grantId: grant.id,
      agentId: grant.agentId,
      sponsorAccountId: grant.sponsorAccountId,
      expectedCredentialId: grant.expectedCredentialId,
      credential,
      auditEventId: createEntityId(),
      requestId,
      now,
    });
    return json({
      agent: { id: grant.agentId },
      credential: {
        id: token.selector,
        token: token.token,
        scopes: AGENT_CREDENTIAL_SCOPES.split(' '),
        createdAt: now,
      },
    }, 201);
  }

  const handle = normalizeAgentHandle(body.handle);
  const bio = requiredString(body.bio, 'bio', 500);
  const agentId = createEntityId();
  const agent: AgentProfileView = {
    id: agentId,
    handle,
    displayName: handle,
    bio,
    avatarAsset: DEFAULT_AGENT_AVATAR,
    role: '',
    shortBio: '',
    motto: '',
    accent: '#6f63e8',
    responsibility: '',
    links: [],
    publicationMode: 'direct_publish',
    status: 'active',
    onboardingState: 'active',
    onboardingCompletedAt: now,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await repository.registerAgent({
    grantId: grant.id,
    agent,
    membershipId: createEntityId(),
    sponsorAccountId: grant.sponsorAccountId,
    credential,
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  return jsonAgent({
    agent: publicAgent(agent),
    credential: {
      id: token.selector,
      token: token.token,
      scopes: AGENT_CREDENTIAL_SCOPES.split(' '),
      createdAt: now,
    },
    avatar: {
      optional: true,
      endpoint: '/v1/agent/avatar',
      prompt: 'Kayıt tamamlandı. İstersen şimdi bir avatar yükleyebilirsin.',
    },
  }, agent, 201);
}

async function handlePatchOwnAgent(
  request: Request,
  env: OrbitBindings,
  repository: AgentRepository,
  publicationRepository: PublicationRepository,
  now: number,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, publicationRepository, now, true, 'profile:write', true);
  const current = await repository.getManagedAgent(auth.principal.agentId);
  if (!current) throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
  const body = await readJson(request);
  requireExactFields(body, ['bio'], 'invalid_agent_fields');
  if (Object.keys(body).length !== 1) throw new ApiError(400, 'invalid_agent_profile', 'bio is required.');
  const ifMatch = request.headers.get('if-match');
  if (!ifMatch) {
    throw new ApiError(428, 'precondition_required', 'If-Match is required for agent profile updates.');
  }
  if (ifMatch !== agentEtag(current)) {
    throw new ApiError(409, 'version_conflict', 'Agent profile changed. Refresh and retry.');
  }
  const bio = requiredString(body.bio, 'bio', 500);
  await repository.updateOwnProfile({
    agentId: current.id,
    credentialId: auth.principal.credentialId,
    displayName: current.handle,
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

async function handleUpdateAvatarPolicy(
  request: Request,
  repository: MediaRepository,
  auth: AuthenticatedHuman,
  subjectType: 'account' | 'agent',
  subjectId: string,
  now: number,
  requestId: string,
): Promise<Response> {
  requirePlatformOwner(auth);
  const body = await readJson(request);
  requireExactFields(body, ['dailyLimit'], 'invalid_avatar_policy_fields');
  if (!Number.isSafeInteger(body.dailyLimit) || Number(body.dailyLimit) < 0 || Number(body.dailyLimit) > 50) {
    throw new ApiError(400, 'invalid_avatar_policy', 'dailyLimit must be between 0 and 50.');
  }
  await repository.setAvatarPolicy({
    subjectType,
    subjectId,
    dailyLimit: Number(body.dailyLimit),
    actorAccountId: auth.account.id,
    auditEventId: createEntityId(),
    requestId,
    now,
  });
  return json({ avatarPolicy: await repository.getAvatarPolicy(subjectType, subjectId, utcDay(now)) });
}

function mediaServerTiming(
  phases: Partial<Record<'quarantine' | 'inspect' | 'images' | 'finalR2' | 'd1', number>>,
): string {
  return Object.entries(phases)
    .map(([name, duration]) => `${name};dur=${Math.max(0, Number(duration)).toFixed(2)}`)
    .join(', ');
}

async function handleAvatarUpload(
  request: Request,
  env: OrbitBindings,
  repository: MediaRepository,
  actor: { type: 'account' | 'agent'; id: string },
  targetType: 'account' | 'agent',
  targetId: string,
  now: number,
  requestId: string,
): Promise<Response> {
  const started = performance.now();
  const usageDay = utcDay(now);
  const contentDigest = request.headers.get('x-orbit-content-sha256') ?? '';
  const contentType = request.headers.get('content-type') ?? '';
  const contentLength = request.headers.get('content-length') ?? '';
  const idem = await mediaIdempotencyContext(
    request, env, repository, actor.type, actor.id,
    { contentDigest, contentType, contentLength, targetType, targetId }, now,
  );
  if (idem.replay?.state === 'completed') return mediaReplayResponse(idem.replay);
  if (idem.replay?.state === 'in_progress') {
    return waitForMediaReplay(repository, actor.type, actor.id, idem.row.keyDigest, idem.requestDigest);
  }
  let objectKey: string | null = null;
  let quarantineKey: string | null = null;
  let claimId: string | null = null;
  let reserved = false;
  let sourceBytes = 0;
  const phases: Partial<Record<'quarantine' | 'inspect' | 'images' | 'finalR2' | 'd1', number>> = {};
  try {
    const upload = await stageRawImageUpload(request, env, AVATAR_UPLOAD_LIMIT);
    quarantineKey = upload.quarantineKey;
    sourceBytes = upload.byteSize;
    phases.quarantine = upload.timings.quarantineMs;
    phases.inspect = upload.timings.inspectMs;
    claimId = createEntityId();
    try {
      await repository.reserveMediaUpload({
        claimId,
        monthUtc: utcMonth(now),
        usageDay,
        profile: 'avatar',
        actorType: actor.type,
        actorId: actor.id,
        targetType,
        targetId,
        sourceContentType: upload.contentType,
        sourceByteSize: upload.byteSize,
        idempotency: idem.row,
        now,
      });
      reserved = true;
    } catch (error) {
      const replay = await repository.getMediaIdempotency(actor.type, actor.id, idem.row.keyDigest);
      if (replay?.requestDigest !== undefined && replay.requestDigest !== idem.requestDigest) {
        throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
      }
      if (replay?.state === 'completed') return mediaReplayResponse(replay);
      if (replay?.state === 'in_progress') {
        return await waitForMediaReplay(repository, actor.type, actor.id, idem.row.keyDigest, idem.requestDigest);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/avatar_media_quota_exceeded/u.test(message)) {
        throw new ApiError(429, 'daily_avatar_quota_exceeded', 'The daily avatar transformation quota is exhausted.');
      }
      if (/media_transform_budget_exhausted/u.test(message)) {
        throw new MediaServiceError(503, 'media_transform_unavailable');
      }
      throw error;
    }
    const processed = await normalizeImage(env, upload, 'avatar');
    phases.images = processed.processingMs;
    const finalR2Started = performance.now();
    const asset = await putMediaObject(env, newMediaAsset({
      kind: targetType === 'account' ? 'account_avatar' : 'agent_avatar',
      ...(targetType === 'account' ? { ownerAccountId: targetId } : { ownerAgentId: targetId }),
      processed,
      now,
    }), processed.stream);
    phases.finalR2 = performance.now() - finalR2Started;
    objectKey = asset.objectKey;
    const responseBody = { media: { id: asset.id, url: `/v1/media/${asset.id}`, width: asset.width, height: asset.height } };
    await repository.completeTransform({ claimId, status: 'succeeded', errorCategory: null, outputByteSize: asset.byteSize, now });
    const d1Started = performance.now();
    await repository.createAvatar({
      asset,
      targetType,
      targetId,
      actorType: actor.type,
      actorId: actor.id,
      idempotencyId: idem.row.id,
      responseStatus: 201,
      responseJson: canonicalJson(responseBody),
      completedAt: now,
      auditEventId: createEntityId(),
      requestId,
    });
    phases.d1 = performance.now() - d1Started;
    logMediaUpload({
      kind: asset.mediaKind,
      actorType: actor.type,
      sourceBytes,
      outputBytes: asset.byteSize,
      processingMs: performance.now() - started,
      status: 'succeeded',
      phases,
    });
    return json(responseBody, 201, { 'server-timing': mediaServerTiming(phases) });
  } catch (error) {
    if (objectKey) await discardMediaObject(env, objectKey);
    if (reserved && claimId) {
      const category = (error as { transformCategory?: string }).transformCategory ?? 'images_output';
      await repository.completeTransform({ claimId, status: 'failed', errorCategory: category as 'images_output', outputByteSize: null, now }).catch(() => undefined);
      const status = error instanceof MediaServiceError || error instanceof ApiError ? error.status : 500;
      const code = error instanceof MediaServiceError || error instanceof ApiError ? error.code : 'internal_error';
      await repository.completeMediaFailure({
        idempotencyId: idem.row.id,
        responseStatus: status,
        responseJson: canonicalJson(createErrorEnvelope(code, 'The media request could not be completed.', requestId)),
        now,
      }).catch(() => undefined);
    }
    logMediaUpload({ kind: targetType === 'account' ? 'account_avatar' : 'agent_avatar', actorType: actor.type, sourceBytes, outputBytes: 0, processingMs: performance.now() - started, status: 'failed', phases });
    throw error;
  } finally {
    if (quarantineKey) await discardMediaObject(env, quarantineKey);
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
  const usageDay = utcDay(now);
  await assertPostImageUploadAllowed(mediaRepository, auth.principal.agentId, usageDay, false);
  const altText = decodeOptionalUploadHeader(request, 'x-orbit-alt-text-b64', 500);
  if (!altText || [...altText].length < 5) throw new ApiError(400, 'invalid_media_alt_text', 'altText must contain at least five characters.');
  const caption = decodeOptionalUploadHeader(request, 'x-orbit-caption-b64', 500);
  const idem = await mediaIdempotencyContext(
    request, env, mediaRepository, 'agent', auth.principal.agentId,
    {
      imageDigest: request.headers.get('x-orbit-content-sha256') ?? '',
      contentType: request.headers.get('content-type') ?? '',
      contentLength: request.headers.get('content-length') ?? '',
      altText,
      caption,
    },
    now,
  );
  if (idem.replay?.state === 'completed') return mediaReplayResponse(idem.replay);
  if (idem.replay?.state === 'in_progress') {
    return waitForMediaReplay(mediaRepository, 'agent', auth.principal.agentId, idem.row.keyDigest, idem.requestDigest);
  }
  let objectKey: string | null = null;
  let quarantineKey: string | null = null;
  let claimId: string | null = null;
  let reserved = false;
  let sourceBytes = 0;
  const phases: Partial<Record<'quarantine' | 'inspect' | 'images' | 'finalR2' | 'd1', number>> = {};
  try {
    const upload = await stageRawImageUpload(request, env, POST_IMAGE_UPLOAD_LIMIT);
    quarantineKey = upload.quarantineKey;
    sourceBytes = upload.byteSize;
    phases.quarantine = upload.timings.quarantineMs;
    phases.inspect = upload.timings.inspectMs;
    claimId = createEntityId();
    try {
      await mediaRepository.reserveMediaUpload({
        claimId,
        monthUtc: utcMonth(now),
        usageDay,
        profile: 'post',
        actorType: 'agent',
        actorId: auth.principal.agentId,
        targetType: 'agent',
        targetId: auth.principal.agentId,
        sourceContentType: upload.contentType,
        sourceByteSize: upload.byteSize,
        idempotency: idem.row,
        now,
      });
      reserved = true;
    } catch (error) {
      const replay = await mediaRepository.getMediaIdempotency('agent', auth.principal.agentId, idem.row.keyDigest);
      if (replay?.requestDigest !== undefined && replay.requestDigest !== idem.requestDigest) {
        throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request.');
      }
      if (replay?.state === 'completed') return mediaReplayResponse(replay);
      if (replay?.state === 'in_progress') {
        return await waitForMediaReplay(mediaRepository, 'agent', auth.principal.agentId, idem.row.keyDigest, idem.requestDigest);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/agent_media_quota_exceeded/u.test(message)) throw new ApiError(429, 'daily_media_quota_exceeded', 'The daily media quota is exhausted.');
      if (/agent_media_disabled/u.test(message)) throw new ApiError(403, 'media_not_allowed', 'Media uploads are not enabled for this agent.');
      if (/media_transform_budget_exhausted/u.test(message)) throw new MediaServiceError(503, 'media_transform_unavailable');
      throw error;
    }
    const processed = await normalizeImage(env, upload, 'post');
    phases.images = processed.processingMs;
    const finalR2Started = performance.now();
    const asset = await putMediaObject(env, newMediaAsset({
      kind: 'post_image',
      ownerAgentId: auth.principal.agentId,
      altText,
      caption,
      processed,
      now,
    }), processed.stream);
    phases.finalR2 = performance.now() - finalR2Started;
    objectKey = asset.objectKey;
    const responseBody = { media: { id: asset.id, width: asset.width, height: asset.height, altText, caption } };
    await mediaRepository.completeTransform({ claimId, status: 'succeeded', errorCategory: null, outputByteSize: asset.byteSize, now });
    const d1Started = performance.now();
    await mediaRepository.createStagedPostImage({
      asset,
      usageId: createEntityId(),
      usageDay,
      auditEventId: createEntityId(),
      requestId,
      idempotency: {
        id: idem.row.id,
        responseStatus: 201,
        responseJson: canonicalJson(responseBody),
        completedAt: now,
      },
    });
    phases.d1 = performance.now() - d1Started;
    logMediaUpload({ kind: 'post_image', actorType: 'agent', sourceBytes, outputBytes: asset.byteSize, processingMs: performance.now() - started, status: 'succeeded', phases });
    return json(responseBody, 201, { 'server-timing': mediaServerTiming(phases) });
  } catch (error) {
    if (objectKey) await discardMediaObject(env, objectKey);
    if (reserved && claimId) {
      const category = (error as { transformCategory?: string }).transformCategory ?? 'images_output';
      await mediaRepository.completeTransform({ claimId, status: 'failed', errorCategory: category as 'images_output', outputByteSize: null, now }).catch(() => undefined);
      const status = error instanceof MediaServiceError || error instanceof ApiError ? error.status : 500;
      const code = error instanceof MediaServiceError || error instanceof ApiError ? error.code : 'internal_error';
      await mediaRepository.completeMediaFailure({
        idempotencyId: idem.row.id,
        responseStatus: status,
        responseJson: canonicalJson(createErrorEnvelope(code, 'The media request could not be completed.', requestId)),
        now,
      }).catch(() => undefined);
    }
    logMediaUpload({ kind: 'post_image', actorType: 'agent', sourceBytes, outputBytes: 0, processingMs: performance.now() - started, status: 'failed', phases });
    throw error;
  } finally {
    if (quarantineKey) await discardMediaObject(env, quarantineKey);
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
  return `${base}-${recordId.replaceAll('-', '').slice(-12)}`;
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
  const baseSlug = slugBase(markdown);
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
  let responseBody = mutationResponse(record, revisionId, record.lifecycleState, record.publishedAt);
  const idempotency = {
    ...idem.row,
    principalType: 'agent' as const,
    principalId: auth.principal.agentId,
    responseStatus: status,
    responseJson: canonicalJson(responseBody),
  };
  const create = () => repository.createRecord({
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
  let concurrentReplay: Response | null;
  try {
    concurrentReplay = await runIdempotentMutation(
      repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest, create,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (record.slug !== baseSlug || !/unique|record_slug_reservations|records\.slug/iu.test(message)) throw error;
    record.slug = `${baseSlug}-${recordId.replaceAll('-', '').slice(-12)}`;
    responseBody = mutationResponse(record, revisionId, record.lifecycleState, record.publishedAt);
    idempotency.responseJson = canonicalJson(responseBody);
    concurrentReplay = await runIdempotentMutation(
      repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest, create,
    );
  }
  if (concurrentReplay) return concurrentReplay;
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
  const body = await readJson(request);
  requireExactFields(body, ['bodyMarkdown', 'mediaId'], 'invalid_content_fields');
  if (record.kind === 'reply' && body.mediaId !== undefined && body.mediaId !== null && body.mediaId !== '') {
    throw new ApiError(400, 'reply_media_not_supported', 'Replies cannot contain media in the first beta.');
  }
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  if (record.lifecycleState !== 'published' || !record.currentRevisionId || record.pendingRevisionId) {
    throw new ApiError(409, 'record_not_editable', 'Only a published record without a pending revision can be edited.');
  }
  const markdown = markdownBody(body.bodyMarkdown);
  const mediaId = await validateStagedMedia(mediaRepository, body.mediaId, auth.principal.agentId);
  const direct = auth.principal.publicationMode === 'direct_publish';
  const revisionId = createEntityId();
  const responseBody = mutationResponse(record, revisionId, 'published', direct ? now : null);
  const status = direct ? 200 : 202;
  const concurrentReplay = await runIdempotentMutation(
    repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest,
    () => repository.createRevision({
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
    }),
  );
  if (concurrentReplay) return concurrentReplay;
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
  const concurrentReplay = await runIdempotentMutation(
    repository, 'account', auth.account.id, idem.keyDigest, idem.requestDigest,
    () => repository.decideReview({
    review, decision, actorAccountId: auth.account.id, note,
    transitionId: createEntityId(), auditEventId: createEntityId(), requestId, now,
    idempotency: {
      ...idem.row, principalType: 'account', principalId: auth.account.id,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
    }),
  );
  if (concurrentReplay) return concurrentReplay;
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
  if (record.authorAgentId !== auth.principal.agentId) {
    throw new ApiError(404, 'pending_record_not_found', 'Pending record or revision was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, [], 'invalid_withdraw_fields');
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  if (!record.pendingRevisionId) {
    throw new ApiError(404, 'pending_record_not_found', 'Pending record or revision was not found.');
  }
  const review = await repository.getPendingReviewForRecord(record.id);
  if (!review) throw new ApiError(409, 'publication_review_not_pending', 'Pending review was not found.');
  const responseBody = { record: { id: record.id, status: record.currentRevisionId ? 'published' : 'withdrawn' } };
  const concurrentReplay = await runIdempotentMutation(
    repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest,
    () => repository.withdrawPending({
    review, agentId: auth.principal.agentId,
    transitionId: createEntityId(), auditEventId: createEntityId(), requestId, now,
    idempotency: {
      ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
    }),
  );
  if (concurrentReplay) return concurrentReplay;
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
  if (record.authorAgentId !== auth.principal.agentId) {
    throw new ApiError(404, 'record_not_found', 'Record was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['reason'], 'invalid_delete_fields');
  const reason = requiredString(body.reason ?? 'author_deleted', 'reason', 280);
  const idem = await idempotencyContext(request, env, repository, 'agent', auth.principal.agentId, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  if (record.deletedAt !== null) throw new ApiError(404, 'record_not_found', 'Record was not found.');
  const responseBody = { record: { id: record.id, status: 'deleted' } };
  const concurrentReplay = await runIdempotentMutation(
    repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest,
    () => repository.softDelete({
    record, actorType: 'agent', actorId: auth.principal.agentId, reason,
    transitionId: createEntityId(), auditEventId: createEntityId(), moderationActionId: null,
    requestId, now,
    idempotency: {
      ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
    }),
  );
  if (concurrentReplay) return concurrentReplay;
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
  if (!allowed) {
    throw new ApiError(404, 'record_not_found', 'Record was not found.');
  }
  const body = await readJson(request);
  requireExactFields(body, ['reason'], 'invalid_delete_fields');
  const reason = requiredString(body.reason, 'reason', 280);
  const idem = await idempotencyContext(request, env, repository, 'account', auth.account.id, body, now);
  if (idem.replay) return replayResponse(idem.replay);
  if (record.deletedAt !== null) throw new ApiError(404, 'record_not_found', 'Record was not found.');
  const responseBody = { record: { id: record.id, status: 'deleted' } };
  const concurrentReplay = await runIdempotentMutation(
    repository, 'account', auth.account.id, idem.keyDigest, idem.requestDigest,
    () => repository.softDelete({
    record, actorType: 'account', actorId: auth.account.id, reason,
    transitionId: createEntityId(), auditEventId: createEntityId(), moderationActionId: createEntityId(),
    requestId, now,
    idempotency: {
      ...idem.row, principalType: 'account', principalId: auth.account.id,
      responseStatus: 200, responseJson: canonicalJson(responseBody),
    },
    }),
  );
  if (concurrentReplay) return concurrentReplay;
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

    if (request.method === 'GET' && path === '/v1/agent/profile') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false, 'profile:write', true);
      const current = await agentRepository.getManagedAgent(auth.principal.agentId);
      if (!current) throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
      return jsonAgent({ agent: publicAgent(current) }, current);
    }
    if (request.method === 'PATCH' && path === '/v1/agent/profile') {
      return await handlePatchOwnAgent(request, env, agentRepository, publicationRepository, now, requestId);
    }
    if (request.method === 'POST' && path === '/v1/agent/avatar') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, true, 'profile:write', true);
      return await handleAvatarUpload(
        request, env, mediaRepository,
        { type: 'agent', id: auth.principal.agentId },
        'agent', auth.principal.agentId, now, requestId,
      );
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
      requirePlatformOwner(auth);
      const reviews = await publicationRepository.listPendingReviews(
        auth.account.id,
        true,
      );
      return json({ reviews: reviews.map(reviewResponse) });
    }

    const approvalDecisionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/u.exec(path);
    if (request.method === 'POST' && approvalDecisionMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePlatformOwner(auth);
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
      requirePlatformOwner(auth);
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
      requirePlatformOwner(auth);
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
    if (request.method === 'POST' && path === '/v1/agent/register') {
      return await handleRedeemRegistrationCode(request, env, agentRepository, now, requestId);
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

    if (request.method === 'POST' && path === '/v1/agent-registration-codes') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleCreateRegistrationCode(request, env, agentRepository, auth, now, requestId);
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

    const renewalCodeMatch = /^\/v1\/agents\/([^/]+)\/credentials\/registration-code$/u.exec(path);
    if (request.method === 'POST' && renewalCodeMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const current = requireAgentManagement(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(renewalCodeMatch[1])),
      );
      return await handleCreateRegistrationCode(request, env, agentRepository, auth, now, requestId, current);
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

    const avatarPolicyMatch = /^\/v1\/admin\/media\/avatar-policies\/(account|agent)\/([^/]+)$/u.exec(path);
    if (request.method === 'PATCH' && avatarPolicyMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      return await handleUpdateAvatarPolicy(
        request,
        mediaRepository,
        auth,
        avatarPolicyMatch[1] as 'account' | 'agent',
        decodeURIComponent(avatarPolicyMatch[2]),
        now,
        requestId,
      );
    }

    const agentMatch = /^\/v1\/agents\/([^/]+)$/u.exec(path);
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
    if (/UNIQUE constraint failed:\s*agents\.handle_normalized\b/iu.test(message)) {
      return json(createErrorEnvelope(
        'handle_unavailable',
        'Bu handle zaten kullanımda; aynı kayıt koduyla başka bir handle dene.',
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
    const isConflict = /constraint|invalid_invitation|invalid_oauth_flow|invalid_registration|registration_rotation|not_revocable|agent_quota|credential_/iu.test(message);
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
