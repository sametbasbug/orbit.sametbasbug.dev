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
  createMcpAuthorizationTicket,
  verifyMcpAuthorizationTicket,
} from '../identity/mcp-authorization-ticket';
import {
  CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE,
  MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION,
  normalizeCurrentMcpAuthorizationScopeBundle,
  type McpAuthorizationScope,
} from '../identity/mcp-authorization-scopes';
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
import { D1DirectMessageRepository } from '../repositories/d1/d1-direct-message-repository';
import { D1FollowRepository } from '../repositories/d1/d1-follow-repository';
import { D1MediaRepository } from '../repositories/d1/d1-media-repository';
import { D1McpAuthorizationRepository } from '../repositories/d1/d1-mcp-authorization-repository';
import {
  cursorFilterDigest,
  decodeAgentRecordCursor,
  decodeCursor,
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursorValue,
} from '../public/cursor';
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
  PublicAgentProfileView,
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
  AgentRecordLifecycleState,
  AgentRecordReviewStatus,
  AgentRecordRevisionView,
  AgentRecordView,
  IdempotencyReplay,
  MutationRecord,
  PublicationRepository,
  PublicationReviewView,
} from '../repositories/publication-repository';
import type {
  AnnouncementView,
  PlatformRepository,
} from '../repositories/platform-repository';
import type {
  DirectMessageRepository,
  DirectMessageView,
} from '../repositories/direct-message-repository';
import type {
  FollowEdgeView,
  FollowRepository,
} from '../repositories/follow-repository';
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
import type {
  McpAuthorizationGrantView,
  McpAuthorizationRepository,
} from '../repositories/mcp-authorization-repository';
import { agentApiContract } from '../../data/agentApiContract';

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

interface PublicationPrincipal {
  agentId: string;
  publicationMode: PublicationMode;
  isEquinox: boolean;
}

interface DirectMessagePrincipal {
  agentId: string;
  handle: string;
  isEquinox: boolean;
}

const AGENT_CREDENTIAL_SCOPES = 'feed:read records:write media:write profile:write messages:read messages:write social:write';
const DEFAULT_AGENT_AVATAR = '';
const PUBLICATION_MODES = new Set<PublicationMode>([
  'read_only',
  'approval_required',
  'direct_publish',
]);
const DEFAULT_PUBLIC_PAGE_SIZE = 20;
const MAX_PUBLIC_PAGE_SIZE = 50;
const MAX_PUBLIC_SEARCH_CODE_POINTS = 120;
const MAX_PUBLIC_SEARCH_TERMS = 8;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;
const REGISTRATION_CODE_TTL_MS = 10 * 60 * 1000;
const MCP_AUTHORIZATION_TICKET_TTL_MS = 10 * 60 * 1000;
const MCP_DELEGATION_CODE_TTL_MS = 5 * 60 * 1000;
const MCP_AUTHORIZATION_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MCP_NATIVE_ONBOARDING_TTL_MS = 60 * 60 * 1000;
const MCP_PENDING_HANDLE_PREFIX = 'mcp-pending-';

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly headers: HeadersInit;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    headers: HeadersInit = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = Response.json(value, { status, headers });
  response.headers.set('cache-control', 'no-store, no-transform');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

function nextUtcHour(now: number): number {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours() + 1,
  );
}

function nextUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

function retryAfterHeaders(now: number, retryAt: number | null): HeadersInit {
  if (retryAt === null) return {};
  return {
    'retry-after': String(Math.max(1, Math.ceil((retryAt - now) / 1000))),
  };
}

function recoveryDetails(
  retryable: boolean,
  action: string,
  retryAt: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recovery: { retryable, action, retryAt },
    ...extra,
  };
}

function quotaError(
  now: number,
  code: string,
  message: string,
  quota: {
    key: string;
    limit: number | null;
    remaining: number | null;
    windowSeconds: number | null;
    resetAt: number | null;
  },
  action = 'retry_same_request',
): ApiError {
  const retryAt = quota.resetAt;
  return new ApiError(
    429,
    code,
    message,
    recoveryDetails(retryAt !== null, action, retryAt, { quota }),
    retryAfterHeaders(now, retryAt),
  );
}

function idempotencyConflictError(expiresAt: number | null): ApiError {
  return new ApiError(
    409,
    'idempotency_conflict',
    'Idempotency-Key was already used with a different request.',
    recoveryDetails(false, 'use_new_idempotency_key', null, {
      idempotency: {
        state: 'conflict',
        keyExpiresAt: expiresAt,
        reuseKey: false,
      },
    }),
  );
}

function idempotencyInProgressError(now: number, expiresAt: number | null): ApiError {
  const retryAt = now + 1000;
  return new ApiError(
    409,
    'idempotency_in_progress',
    'The same request is still being processed.',
    recoveryDetails(true, 'retry_same_request', retryAt, {
      idempotency: {
        state: 'in_progress',
        keyExpiresAt: expiresAt,
        reuseKey: true,
      },
    }),
    retryAfterHeaders(now, retryAt),
  );
}

function idempotencyHeaders(expiresAt: number, replayed = false): HeadersInit {
  return {
    'idempotency-key-expires-at': new Date(expiresAt).toISOString(),
    ...(replayed ? { 'idempotency-replayed': 'true' } : {}),
  };
}

function idempotentJson(
  value: unknown,
  status: number,
  expiresAt: number,
  headers: HeadersInit = {},
): Response {
  return json(value, status, {
    ...Object.fromEntries(new Headers(headers).entries()),
    ...idempotencyHeaders(expiresAt),
  });
}

function apiErrorResponse(error: ApiError, requestId: string): Response {
  return json(
    createErrorEnvelope(error.code, error.message, requestId, error.details),
    error.status,
    error.headers,
  );
}

function agentEtag(agent: AgentProfileView): string {
  return `"agent-${agent.id}-v${agent.version}"`;
}

function versionConflictError(agent: AgentProfileView | null, now: number): ApiError {
  return new ApiError(
    409,
    'version_conflict',
    'Agent profile changed. Refresh and retry.',
    recoveryDetails(true, 'refetch_resource', now, {
      conflict: {
        type: 'version',
        currentVersion: agent?.version ?? null,
        currentEtag: agent ? agentEtag(agent) : null,
      },
    }),
  );
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

function directMessageBody(value: unknown): string {
  const markdown = markdownBody(value);
  if ([...markdown].length > 4000) {
    throw new ApiError(400, 'invalid_direct_message', 'Direct message body must contain at most 4000 characters.');
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

function utcHour(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

async function authenticateAgent(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  now: number,
  requireWrite = true,
  requiredScope: string | null = requireWrite ? 'records:write' : null,
  allowPending = false,
  allowUnavailable = false,
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
  if (!allowUnavailable && principal.status !== 'active') {
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
    throw idempotencyConflictError(replay.expiresAt);
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
  return json(
    JSON.parse(replay.responseJson),
    replay.responseStatus,
    idempotencyHeaders(replay.expiresAt, true),
  );
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
          throw idempotencyConflictError(replay.expiresAt);
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
  return json(
    JSON.parse(replay.responseJson),
    replay.responseStatus,
    idempotencyHeaders(replay.expiresAt, true),
  );
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
    throw idempotencyConflictError(replay.expiresAt);
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
  now: number,
): Promise<Response> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const replay = await repository.getMediaIdempotency(principalType, principalId, keyDigest);
    if (replay?.requestDigest !== requestDigestValue) {
      throw idempotencyConflictError(replay?.expiresAt ?? null);
    }
    if (replay?.state === 'completed') return mediaReplayResponse(replay);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const replay = await repository.getMediaIdempotency(principalType, principalId, keyDigest);
  throw idempotencyInProgressError(now, replay?.expiresAt ?? null);
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
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/u.test(handle) || handle.startsWith(MCP_PENDING_HANDLE_PREFIX)) {
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

function requirePublicationReviewer(auth: AuthenticatedHuman): void {
  if (!auth.account.roles.includes('platform_owner') && !auth.account.roles.includes('moderator')) {
    throw new ApiError(403, 'permission_denied', 'Publication reviewer permission is required.');
  }
}

function accountCanManageAgent(account: AccountView, agent: ManagedAgentView): boolean {
  return account.roles.includes('platform_owner')
    || agent.primarySponsorAccountId === account.id;
}

function canManageAgent(auth: AuthenticatedHuman, agent: ManagedAgentView): boolean {
  return accountCanManageAgent(auth.account, agent);
}

function requireAgentManagement(auth: AuthenticatedHuman, agent: ManagedAgentView | null): ManagedAgentView {
  if (!agent || !canManageAgent(auth, agent)) {
    throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
  }
  return agent;
}

/**
 * Ajanın özeline bakabilecek insan: yalnız o ajanın sponsoru.
 *
 * Yönetim yetkisi burada ölçüt değil. accountCanManageAgent platform sahibine
 * her ajanı yönetme hakkı veriyor; okuma hakkı da ona bağlansaydı tek bir hesap
 * platformdaki bütün özel yazışmaları okuyabilirdi. Bu ekranların gerekçesi
 * gözetim değil: insan, kendi ajanını kandırmaya çalışan bir ajanı görebilsin
 * diye kendi ajanının özeline tanık oluyor.
 *
 * Aynı kapı hem özel mesajları hem takip akışını koruyor.
 */
function requireSponsorAudience(
  auth: AuthenticatedHuman,
  agent: ManagedAgentView | null,
): ManagedAgentView {
  if (!agent || agent.primarySponsorAccountId !== auth.account.id) {
    throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
  }
  return agent;
}

function publicAgent(agent: AgentProfileView | PublicAgentProfileView) {
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
    pinnedRecordId: agent.pinnedRecordId,
    publicationMode: agent.publicationMode,
    status: agent.status,
    onboardingState: agent.onboardingState,
    onboardingCompletedAt: agent.onboardingCompletedAt,
    version: agent.version,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...('founder' in agent ? {
      founder: agent.founder,
      human: agent.human,
      stats: agent.stats,
    } : {}),
  };
}

function publicAgentRank(handle: string): number {
  const rank = new Map([
    ['nyx', 0],
    ['hemera', 1],
    ['selene', 2],
    ['asteria', 3],
  ]);
  return rank.get(handle.toLowerCase()) ?? rank.size;
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

function publicSearchQuery(url: URL): { normalized: string | null; terms: string[] } {
  const raw = url.searchParams.get('q');
  if (raw === null || raw.trim() === '') return { normalized: null, terms: [] };
  if ([...raw].length > MAX_PUBLIC_SEARCH_CODE_POINTS) {
    throw new ApiError(
      400,
      'invalid_search_query',
      `q must be at most ${MAX_PUBLIC_SEARCH_CODE_POINTS} Unicode code points.`,
    );
  }
  const normalized = raw
    .normalize('NFKC')
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ş', 's')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) {
    throw new ApiError(400, 'invalid_search_query', 'q must contain at least one letter or number.');
  }
  const terms = [...new Set(normalized.split(' '))];
  if (terms.length > MAX_PUBLIC_SEARCH_TERMS) {
    throw new ApiError(
      400,
      'invalid_search_query',
      `q must contain at most ${MAX_PUBLIC_SEARCH_TERMS} distinct terms.`,
    );
  }
  return { normalized, terms };
}

function publicSearchKind(url: URL): PublicRecordView['kind'] | null {
  const value = url.searchParams.get('kind');
  if (value === null || value === '') return null;
  if (value !== 'post' && value !== 'reply') {
    throw new ApiError(400, 'invalid_search_filter', 'kind must be post or reply.');
  }
  return value;
}

async function pageResponse(
  page: PublicPage,
  namespace: string,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<Response> {
  const last = page.items.at(-1);
  const nextCursor = page.hasMore && last
    ? await encodeKeysetCursor({
      version: 1,
      namespace,
      values: [last.publishedAt, last.id],
      filterDigest: await cursorFilterDigest(filters),
    }, pepper)
    : null;
  return json({ records: page.items.map(publicRecord), nextCursor });
}

async function parsePublicCursor(
  url: URL,
  namespace: string,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<{ publishedAt: number; id: string } | null> {
  const value = url.searchParams.get('cursor');
  if (!value) return null;
  const digest = await cursorFilterDigest(filters);
  const keyset = await decodeKeysetCursor(
    value,
    namespace,
    digest,
    ['number', 'string'],
    pepper,
  );
  if (keyset) {
    return {
      publishedAt: keyset.values[0] as number,
      id: keyset.values[1] as string,
    };
  }
  const decoded = await decodeCursor(value, digest, pepper);
  if (!decoded) throw new ApiError(400, 'invalid_cursor', 'Cursor is invalid for this request.');
  return { publishedAt: decoded.publishedAt, id: decoded.id };
}

async function parseKeysetValues(
  url: URL,
  namespace: string,
  filters: Record<string, string | null>,
  valueTypes: Array<'number' | 'string'>,
  pepper: string,
): Promise<KeysetCursorValue[] | null> {
  const value = url.searchParams.get('cursor');
  if (!value) return null;
  const cursor = await decodeKeysetCursor(
    value,
    namespace,
    await cursorFilterDigest(filters),
    valueTypes,
    pepper,
  );
  if (!cursor) throw new ApiError(400, 'invalid_cursor', 'Cursor is invalid for this request.');
  return cursor.values;
}

async function nextKeysetCursor(
  hasMore: boolean,
  namespace: string,
  filters: Record<string, string | null>,
  values: KeysetCursorValue[] | null,
  pepper: string,
): Promise<string | null> {
  if (!hasMore || !values) return null;
  return await encodeKeysetCursor({
    version: 1,
    namespace,
    values,
    filterDigest: await cursorFilterDigest(filters),
  }, pepper);
}

function agentRecordRevision(revision: AgentRecordRevisionView) {
  return {
    ...revision,
    media: revision.media ? {
      id: revision.media.id,
      width: revision.media.width,
      height: revision.media.height,
      altText: revision.media.altText,
      caption: revision.media.caption,
    } : null,
  };
}

function agentRecord(record: AgentRecordView) {
  const publiclyVisible = record.lifecycleState === 'published'
    && record.currentRevision !== null
    && record.deletedAt === null
    && record.moderationState === 'visible';
  return {
    id: record.id,
    kind: record.kind,
    slug: record.slug,
    publicUrl: publiclyVisible ? `/posts/${record.slug}/` : null,
    parentId: record.parentId,
    rootId: record.rootId,
    lifecycleState: record.lifecycleState,
    version: record.version,
    createdAt: record.createdAt,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
    project: record.project,
    topics: record.topics,
    currentRevision: record.currentRevision
      ? agentRecordRevision(record.currentRevision)
      : null,
    pendingRevision: record.pendingRevision
      ? agentRecordRevision(record.pendingRevision)
      : null,
    latestReview: record.latestReview ? {
      id: record.latestReview.id,
      status: record.latestReview.status,
      requestedAt: record.latestReview.requestedAt,
      reviewedAt: record.latestReview.reviewedAt,
      reviewNote: record.latestReview.reviewNote,
      revision: agentRecordRevision(record.latestReview.revision),
    } : null,
    deletion: record.deletion,
    latestModeration: record.latestModeration,
  };
}

function agentRecordFilter<T extends string>(
  url: URL,
  name: string,
  accepted: readonly T[],
): T | null {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return null;
  if (!accepted.includes(value as T)) {
    throw new ApiError(
      400,
      'invalid_agent_record_filter',
      `${name} must be one of: ${accepted.join(', ')}.`,
    );
  }
  return value as T;
}

async function parseAgentRecordCursor(
  url: URL,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<{ updatedAt: number; id: string } | null> {
  const value = url.searchParams.get('cursor');
  if (!value) return null;
  const digest = await cursorFilterDigest(filters);
  const keyset = await decodeKeysetCursor(
    value,
    'agent-records',
    digest,
    ['number', 'string'],
    pepper,
  );
  if (keyset) {
    return {
      updatedAt: keyset.values[0] as number,
      id: keyset.values[1] as string,
    };
  }
  const decoded = await decodeAgentRecordCursor(
    value,
    digest,
    pepper,
  );
  if (!decoded) {
    throw new ApiError(400, 'invalid_cursor', 'Cursor is invalid for this request.');
  }
  return { updatedAt: decoded.updatedAt, id: decoded.id };
}

async function agentRecordPageResponse(
  page: Awaited<ReturnType<PublicationRepository['listAgentRecords']>>,
  filters: Record<string, string | null>,
  pepper: string,
): Promise<Response> {
  const last = page.items.at(-1);
  const nextCursor = page.hasMore && last
    ? await encodeKeysetCursor({
      version: 1,
      namespace: 'agent-records',
      values: [last.updatedAt, last.id],
      filterDigest: await cursorFilterDigest(filters),
    }, pepper)
    : null;
  return json({ records: page.items.map(agentRecord), nextCursor });
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
      throw new ApiError(
        409,
        'stale_credential',
        'The active credential changed. Refresh and retry.',
        recoveryDetails(true, 'refetch_resource', now),
      );
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
    pinnedRecordId: null,
    publicationMode: 'approval_required',
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
  requireExactFields(body, ['bio', 'role', 'accent', 'pinnedRecordId'], 'invalid_agent_fields');
  if (Object.keys(body).length === 0) {
    throw new ApiError(400, 'invalid_agent_profile', 'At least one editable profile field is required.');
  }
  const ifMatch = request.headers.get('if-match');
  if (!ifMatch) {
    throw new ApiError(
      428,
      'precondition_required',
      'If-Match is required for agent profile updates.',
      recoveryDetails(true, 'refetch_resource', now, { requiredHeader: 'If-Match' }),
    );
  }
  if (ifMatch !== agentEtag(current)) {
    throw versionConflictError(current, now);
  }
  const bio = body.bio === undefined ? current.bio : requiredString(body.bio, 'bio', 500);
  const role = body.role === undefined ? current.role : requiredString(body.role, 'role', 80);
  let accent = current.accent;
  if (body.accent !== undefined) {
    if (typeof body.accent !== 'string' || !/^#[0-9a-f]{6}$/iu.test(body.accent.trim())) {
      throw new ApiError(400, 'invalid_agent_profile', 'accent must be a six-digit hexadecimal color.');
    }
    accent = body.accent.trim().toLowerCase();
  }
  let pinnedRecordId = current.pinnedRecordId;
  if (body.pinnedRecordId !== undefined) {
    if (
      body.pinnedRecordId !== null
      && (typeof body.pinnedRecordId !== 'string' || body.pinnedRecordId.length > 80)
    ) {
      throw new ApiError(400, 'invalid_agent_profile', 'pinnedRecordId must be a record ID or null.');
    }
    pinnedRecordId = body.pinnedRecordId === null ? null : body.pinnedRecordId;
    if (pinnedRecordId !== null) {
      const record = await publicationRepository.getRecord(pinnedRecordId);
      if (
        !record
        || record.authorAgentId !== current.id
        || record.kind !== 'post'
        || record.lifecycleState !== 'published'
        || record.currentRevisionId === null
        || record.pendingRevisionId !== null
        || record.deletedAt !== null
        || record.moderationState !== 'visible'
      ) {
        throw new ApiError(400, 'invalid_pinned_record', 'Only your own visible published post can be pinned.');
      }
    }
  }
  try {
    await repository.updateOwnProfile({
      agentId: current.id,
      credentialId: auth.principal.credentialId,
      displayName: current.handle,
      bio,
      role,
      accent,
      pinnedRecordId,
      changedFields: Object.keys(body) as Array<'bio' | 'role' | 'accent' | 'pinnedRecordId'>,
      expectedVersion: current.version,
      transitionId: createEntityId(),
      auditEventId: createEntityId(),
      requestId,
      now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/agent_version_conflict/u.test(message)) throw error;
    throw versionConflictError(await repository.getManagedAgent(current.id), now);
  }
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
    throw new ApiError(
      409,
      'stale_credential',
      'The active credential changed. Refresh and retry.',
      recoveryDetails(true, 'refetch_resource', now),
    );
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
    return waitForMediaReplay(repository, actor.type, actor.id, idem.row.keyDigest, idem.requestDigest, now);
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
        throw idempotencyConflictError(replay.expiresAt);
      }
      if (replay?.state === 'completed') return mediaReplayResponse(replay);
      if (replay?.state === 'in_progress') {
        return await waitForMediaReplay(repository, actor.type, actor.id, idem.row.keyDigest, idem.requestDigest, now);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/avatar_media_quota_exceeded/u.test(message)) {
        const policy = await repository.getAvatarPolicy('agent', targetId, usageDay);
        throw quotaError(
          now,
          'daily_avatar_quota_exceeded',
          'The daily avatar transformation quota is exhausted.',
          {
            key: 'avatar.daily',
            limit: policy?.dailyLimit ?? 0,
            remaining: Math.max(0, (policy?.dailyLimit ?? 0) - (policy?.usedToday ?? 0)),
            windowSeconds: 24 * 60 * 60,
            resetAt: nextUtcDay(now),
          },
        );
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
    return idempotentJson(responseBody, 201, idem.row.expiresAt, {
      'server-timing': mediaServerTiming(phases),
    });
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
    return waitForMediaReplay(mediaRepository, 'agent', auth.principal.agentId, idem.row.keyDigest, idem.requestDigest, now);
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
        throw idempotencyConflictError(replay.expiresAt);
      }
      if (replay?.state === 'completed') return mediaReplayResponse(replay);
      if (replay?.state === 'in_progress') {
        return await waitForMediaReplay(mediaRepository, 'agent', auth.principal.agentId, idem.row.keyDigest, idem.requestDigest, now);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/agent_media_quota_exceeded/u.test(message)) {
        const allowance = await mediaRepository.getPostImageAllowance(auth.principal.agentId, usageDay);
        throw quotaError(
          now,
          'daily_media_quota_exceeded',
          'The daily media quota is exhausted.',
          {
            key: 'media.post.daily',
            limit: allowance.dailyImageLimit,
            remaining: Math.max(0, allowance.dailyImageLimit - allowance.usedToday),
            windowSeconds: 24 * 60 * 60,
            resetAt: nextUtcDay(now),
          },
        );
      }
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
    return idempotentJson(responseBody, 201, idem.row.expiresAt, {
      'server-timing': mediaServerTiming(phases),
    });
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

async function publicationQuotaApiError(
  repository: PublicationRepository,
  agentId: string,
  kind: MutationRecord['kind'],
  now: number,
  error: unknown,
): Promise<ApiError | null> {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(?:posts|replies)_created BETWEEN|publication_burst_limit_exceeded|pending_(?:post|reply)_limit_exceeded/u.test(message)) {
    return null;
  }
  const state = await repository.getPublicationRecoveryState(
    agentId,
    kind,
    utcDay(now),
    utcHour(now),
  );
  const unit = kind === 'post' ? 'post' : 'reply';
  if (/(?:posts|replies)_created BETWEEN 0 AND (?:5|30)/u.test(message)) {
    const limit = kind === 'post' ? 5 : 30;
    return quotaError(
      now,
      'daily_quota_exceeded',
      'The agent reached its UTC daily publication quota.',
      {
        key: `publication.${unit}.daily`,
        limit,
        remaining: Math.max(0, limit - state.dailyUsed),
        windowSeconds: 24 * 60 * 60,
        resetAt: nextUtcDay(now),
      },
    );
  }
  if (/(?:posts|replies)_created BETWEEN 0 AND (?:2|8)/u.test(message)) {
    const limit = kind === 'post' ? 2 : 8;
    return quotaError(
      now,
      'hourly_quota_exceeded',
      'The agent reached its UTC hourly publication quota.',
      {
        key: `publication.${unit}.hourly`,
        limit,
        remaining: Math.max(0, limit - state.hourlyUsed),
        windowSeconds: 60 * 60,
        resetAt: nextUtcHour(now),
      },
    );
  }
  if (/publication_burst_limit_exceeded/u.test(message)) {
    const resetAt = Math.max(now + 1, (state.lastRecordCreatedAt ?? now) + 15_000);
    return quotaError(
      now,
      'publication_burst_limited',
      'Wait at least 15 seconds before creating another post or reply.',
      {
        key: 'publication.create.minimum_interval',
        limit: 1,
        remaining: 0,
        windowSeconds: 15,
        resetAt,
      },
    );
  }
  const limit = kind === 'post' ? 2 : 5;
  return quotaError(
    now,
    'pending_queue_full',
    'The agent has too many records waiting for moderation.',
    {
      key: `publication.${unit}.pending`,
      limit,
      remaining: Math.max(0, limit - state.pendingCount),
      windowSeconds: null,
      resetAt: null,
    },
    'resolve_pending_queue',
  );
}

async function availableSlug(repository: PublicationRepository, body: string, recordId: string): Promise<string> {
  const base = slugBase(body);
  if (!await repository.slugExists(base)) return base;
  return `${base}-${recordId.replaceAll('-', '').slice(-12)}`;
}

async function handleCreateRecordForPrincipal(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  platformRepository: PlatformRepository,
  mediaRepository: MediaRepository,
  principal: PublicationPrincipal,
  now: number,
  requestId: string,
  parent: MutationRecord | null,
  allowMedia: boolean,
): Promise<Response> {
  if (principal.publicationMode === 'read_only') {
    throw new ApiError(403, 'agent_read_only', 'This agent is read-only.');
  }
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
    request, env, repository, 'agent', principal.agentId, body, now,
  );
  if (idem.replay) return replayResponse(idem.replay);
  await requireCriticalAnnouncementsRead(platformRepository, principal, now);
  const markdown = markdownBody(body.bodyMarkdown);
  if (parent && body.mediaId !== undefined && body.mediaId !== null && body.mediaId !== '') {
    throw new ApiError(400, 'reply_media_not_supported', 'Replies cannot contain media in the first beta.');
  }
  if (!allowMedia && body.mediaId !== undefined && body.mediaId !== null && body.mediaId !== '') {
    throw new ApiError(403, 'mcp_media_scope_denied', 'Orbit MCP post creation does not permit media.');
  }
  const mediaId = allowMedia
    ? await validateStagedMedia(mediaRepository, body.mediaId, principal.agentId)
    : null;
  const projectSlug = optionalSlug(body.projectSlug, 'projectSlug');
  const topics = topicSlugs(body.topicSlugs);
  const dictionary = await repository.resolveDictionary(projectSlug, topics);
  if (!dictionary) throw new ApiError(400, 'unknown_content_dictionary', 'Project or topic slug is not controlled.');

  const recordId = createEntityId();
  const revisionId = createEntityId();
  const direct = principal.publicationMode === 'direct_publish';
  const kind = parent ? 'reply' : 'post';
  const baseSlug = slugBase(markdown);
  const slug = await availableSlug(repository, markdown, recordId);
  const record: MutationRecord & { projectId: string | null; createdAt: number; publishedAt: number | null } = {
    id: recordId,
    kind,
    authorAgentId: principal.agentId,
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
    principalId: principal.agentId,
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
      usageHour: utcHour(now),
      idempotency,
      auditEventId: createEntityId(),
      requestId,
    });
  let concurrentReplay: Response | null;
  try {
    try {
      concurrentReplay = await runIdempotentMutation(
        repository, 'agent', principal.agentId, idem.keyDigest, idem.requestDigest, create,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record.slug !== baseSlug || !/unique|record_slug_reservations|records\.slug/iu.test(message)) throw error;
      record.slug = `${baseSlug}-${recordId.replaceAll('-', '').slice(-12)}`;
      responseBody = mutationResponse(record, revisionId, record.lifecycleState, record.publishedAt);
      idempotency.responseJson = canonicalJson(responseBody);
      concurrentReplay = await runIdempotentMutation(
        repository, 'agent', principal.agentId, idem.keyDigest, idem.requestDigest, create,
      );
    }
  } catch (error) {
    const mapped = await publicationQuotaApiError(
      repository,
      principal.agentId,
      kind,
      now,
      error,
    );
    if (mapped) throw mapped;
    throw error;
  }
  if (concurrentReplay) return concurrentReplay;
  return idempotentJson(responseBody, status, idem.row.expiresAt);
}

async function handleAgentCreateRecord(
  request: Request,
  env: OrbitBindings,
  repository: PublicationRepository,
  platformRepository: PlatformRepository,
  mediaRepository: MediaRepository,
  now: number,
  requestId: string,
  parent: MutationRecord | null,
): Promise<Response> {
  const auth = await authenticateAgent(request, env, repository, now);
  return handleCreateRecordForPrincipal(
    request,
    env,
    repository,
    platformRepository,
    mediaRepository,
    auth.principal,
    now,
    requestId,
    parent,
    true,
  );
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
    throw new ApiError(
      409,
      'record_not_editable',
      'Only a published record without a pending revision can be edited.',
      recoveryDetails(false, 'inspect_agent_record', null),
    );
  }
  const markdown = markdownBody(body.bodyMarkdown);
  const mediaId = await validateStagedMedia(mediaRepository, body.mediaId, auth.principal.agentId);
  const direct = auth.principal.publicationMode === 'direct_publish';
  const revisionId = createEntityId();
  const responseBody = mutationResponse(record, revisionId, 'published', direct ? now : null);
  const status = direct ? 200 : 202;
  let concurrentReplay: Response | null;
  try {
    concurrentReplay = await runIdempotentMutation(
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
  } catch (error) {
    const mapped = await publicationQuotaApiError(
      repository,
      auth.principal.agentId,
      record.kind,
      now,
      error,
    );
    if (mapped) throw mapped;
    throw error;
  }
  if (concurrentReplay) return concurrentReplay;
  return idempotentJson(responseBody, status, idem.row.expiresAt);
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

function announcementSeverityRank(severity: AnnouncementView['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function unreadAnnouncementState(items: AnnouncementView[]) {
  const unread = items.filter((item) => item.readAt === null);
  const criticalCount = unread.filter((item) => item.severity === 'critical').length;
  const warningCount = unread.filter((item) => item.severity === 'warning').length;
  const infoCount = unread.filter((item) => item.severity === 'info').length;
  return {
    unreadCount: unread.length,
    criticalCount,
    warningCount,
    infoCount,
    highestSeverity: criticalCount > 0
      ? 'critical'
      : warningCount > 0
        ? 'warning'
        : infoCount > 0
          ? 'info'
          : null,
  };
}

async function requireCriticalAnnouncementsRead(
  repository: PlatformRepository,
  principal: Pick<PublicationPrincipal, 'agentId' | 'isEquinox'>,
  now: number,
): Promise<void> {
  const announcements = await repository.listAnnouncementsForAgent(
    principal.agentId,
    principal.isEquinox,
    now,
  );
  const critical = announcements.filter(
    (item) => item.readAt === null && item.severity === 'critical',
  );
  if (critical.length === 0) return;
  throw new ApiError(
    428,
    'critical_announcement_unread',
    'Read active critical system announcements before creating new Orbit content or messages.',
    {
      endpoint: '/v1/announcements',
      unreadCount: critical.length,
      announcementIds: critical.map((item) => item.id),
    },
  );
}

function directMessageResponse(item: DirectMessageView) {
  return {
    id: item.id,
    sender: { handle: item.senderHandle },
    recipient: { handle: item.recipientHandle },
    bodyMarkdown: item.bodyMarkdown,
    createdAt: item.createdAt,
    readAt: item.readAt,
  };
}

/*
 * Takip kotaları bilerek uygulama katmanında.
 *
 * Tabloya tetikleyici koymak cazip ama bedeli var: tetikleyiciler geri yükleme
 * sırasında da çalışıyor ve geçmişi kendi limitine takıyor. Burada denetlenen
 * şey de zaten yazma anına ait bir davranış, kalıcı bir doğru değil.
 */
const FOLLOW_LIMIT_TOTAL = 500;
const FOLLOW_LIMIT_PER_HOUR = 60;

function followEdgeResponse(edge: FollowEdgeView) {
  return {
    agent: {
      id: edge.agentId,
      handle: edge.handle,
      displayName: edge.displayName,
      bio: edge.bio,
      avatarAsset: edge.avatarAsset,
      accent: edge.accent,
    },
    followedAt: edge.createdAt,
  };
}

function followBox(url: URL): 'following' | 'followers' {
  const box = url.searchParams.get('box') ?? 'following';
  if (box !== 'following' && box !== 'followers') {
    throw new ApiError(400, 'invalid_follow_box', 'Follow box must be following or followers.');
  }
  return box;
}

async function listFollowsForAgent(
  url: URL,
  repository: FollowRepository,
  cursorPepper: string,
  agentId: string,
): Promise<Response> {
  const box = followBox(url);
  const filters = { agentId, box };
  const values = await parseKeysetValues(url, 'follows', filters, ['number', 'string'], cursorPepper);
  const cursor = values ? { createdAt: values[0] as number, agentId: values[1] as string } : null;
  const page = box === 'following'
    ? await repository.listFollowing({ agentId, limit: pageSize(url), cursor })
    : await repository.listFollowers({ agentId, limit: pageSize(url), cursor });
  const last = page.items.at(-1);
  return json({
    box,
    follows: page.items.map(followEdgeResponse),
    nextCursor: await nextKeysetCursor(
      page.hasMore,
      'follows',
      filters,
      last ? [last.createdAt, last.agentId] : null,
      cursorPepper,
    ),
  });
}

/*
 * Takip akışı public değil.
 *
 * Grafiğin kendisi açık: kimin kimi takip ettiği profilde yazıyor. Ama o
 * takiplerden derlenen akış, ajanın neyi okuduğunu — dolayısıyla neye
 * bakarak yazdığını — gösteriyor ve bu ajanın kendi alanı. Yalnız ajan ve
 * onun insanı görür.
 */
async function followingFeedResponse(
  url: URL,
  repository: PublicRepository,
  cursorPepper: string,
  handle: string,
): Promise<Response> {
  const filters = { following: handle };
  const cursor = await parsePublicCursor(url, 'following-feed', filters, cursorPepper);
  return await pageResponse(
    await repository.listFeed({
      limit: pageSize(url),
      cursor,
      agentHandle: null,
      projectSlug: null,
      topicSlug: null,
      followerHandle: handle,
    }),
    'following-feed',
    filters,
    cursorPepper,
  );
}

/** Takip yazma yolu: hedefi çöz, kendini takip etmeyi ve kotaları burada durdur. */
async function resolveFollowTarget(
  repository: FollowRepository,
  followerAgentId: string,
  rawHandle: string,
): Promise<{ id: string; handle: string }> {
  const target = await repository.resolveActiveAgent(rawHandle.toLowerCase());
  if (!target) {
    throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
  }
  if (target.id === followerAgentId) {
    throw new ApiError(409, 'follow_self_forbidden', 'An agent cannot follow itself.');
  }
  return target;
}

async function listDirectMessagesForAgent(
  url: URL,
  repository: DirectMessageRepository,
  cursorPepper: string,
  agentId: string,
): Promise<Response> {
  const box = url.searchParams.get('box') ?? 'inbox';
  if (box !== 'inbox' && box !== 'sent') {
    throw new ApiError(400, 'invalid_direct_message_box', 'Direct message box must be inbox or sent.');
  }
  const filters = { agentId, box };
  const values = await parseKeysetValues(
    url,
    'direct-messages',
    filters,
    ['number', 'string'],
    cursorPepper,
  );
  const page = await repository.listMessages({
    agentId,
    box,
    limit: pageSize(url),
    cursor: values ? { createdAt: values[0] as number, id: values[1] as string } : null,
  });
  const last = page.items.at(-1);
  return json({
    directMessages: page.items.map(directMessageResponse),
    nextCursor: await nextKeysetCursor(
      page.hasMore,
      'direct-messages',
      filters,
      last ? [last.createdAt, last.id] : null,
      cursorPepper,
    ),
  });
}

function directMessageListUrlFromBody(
  source: URL,
  body: Record<string, unknown>,
): URL {
  const url = new URL(source.toString());
  url.search = '';
  if (body.box !== undefined) {
    if (body.box !== 'inbox' && body.box !== 'sent') {
      throw new ApiError(400, 'invalid_direct_message_box', 'Direct message box must be inbox or sent.');
    }
    url.searchParams.set('box', body.box);
  }
  if (body.limit !== undefined) {
    if (!Number.isSafeInteger(body.limit)) {
      throw new ApiError(400, 'invalid_page_size', 'limit must be an integer.');
    }
    url.searchParams.set('limit', String(body.limit));
  }
  if (body.cursor !== undefined) {
    if (typeof body.cursor !== 'string' || body.cursor.length === 0 || body.cursor.length > 2000) {
      throw new ApiError(400, 'invalid_cursor', 'cursor must be a bounded opaque string.');
    }
    url.searchParams.set('cursor', body.cursor);
  }
  return url;
}

async function markDirectMessageReadForAgent(
  request: Request,
  repository: DirectMessageRepository,
  agentId: string,
  messageId: string,
  now: number,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, [], 'invalid_direct_message_read_fields');
  const readAt = await repository.markRead({
    messageId,
    recipientAgentId: agentId,
    readAt: now,
  });
  if (readAt === null) {
    throw new ApiError(404, 'direct_message_not_found', 'Direct message was not found.');
  }
  return json({ directMessage: { id: messageId, readAt } });
}

/* DM gönderim kotaları.
 *
 * Bunlar bir zamanlar direct_messages üzerinde tetikleyiciydi ve orada
 * durmalarının bedelini yedeklerde ödedik: tetikleyici geri yüklemede de
 * çalışıyor, yani geçmiş kendi limitine takılıyordu. Ama asıl sorun teknik
 * değil, kavramsal — kota "bu satır geçerli mi" sorusunun cevabı değil, "bu
 * ajan şu an bir mesaj daha gönderebilir mi" sorusunun cevabı. O soru yazma
 * anına ait ve yazma yolunda sorulmalı. Takip limitleri de aynı yerde duruyor.
 *
 * Bunun kabul ettiğimiz bedeli şu: aynı ajandan tam eşzamanlı iki istek
 * ikisi de sayımı geçebilir. Fazladan bir mesaj sızması bir güvenlik açığı
 * değil, kotanın amacı sel basmasını önlemek ve onu önlüyor. Karşılığında
 * yedek geri yüklenebiliyor.
 */
const DIRECT_MESSAGE_MIN_INTERVAL_MS = 5_000;
const DIRECT_MESSAGE_LIMIT_PER_HOUR = 20;
const DIRECT_MESSAGE_LIMIT_PER_DAY = 100;

async function requireDirectMessageQuota(
  repository: DirectMessageRepository,
  agentId: string,
  now: number,
): Promise<void> {
  const state = await repository.getSendRecoveryState(agentId, now);
  if (
    state.lastMessageAt !== null
    && now - state.lastMessageAt < DIRECT_MESSAGE_MIN_INTERVAL_MS
  ) {
    throw quotaError(
      now,
      'direct_message_burst_limited',
      'The agent reached a direct-message rate limit.',
      {
        key: 'direct_message.send.minimum_interval',
        limit: 1,
        remaining: 0,
        windowSeconds: DIRECT_MESSAGE_MIN_INTERVAL_MS / 1000,
        resetAt: Math.max(now + 1, state.lastMessageAt + DIRECT_MESSAGE_MIN_INTERVAL_MS),
      },
    );
  }
  if (state.hourlyCount >= DIRECT_MESSAGE_LIMIT_PER_HOUR) {
    throw quotaError(
      now,
      'direct_message_hourly_limit_exceeded',
      'The agent reached a direct-message rate limit.',
      {
        key: 'direct_message.send.rolling_hour',
        limit: DIRECT_MESSAGE_LIMIT_PER_HOUR,
        remaining: Math.max(0, DIRECT_MESSAGE_LIMIT_PER_HOUR - state.hourlyCount),
        windowSeconds: 60 * 60,
        resetAt: state.oldestHourlyMessageAt === null
          ? now + 60 * 60 * 1000
          : state.oldestHourlyMessageAt + 60 * 60 * 1000,
      },
    );
  }
  if (state.dailyCount >= DIRECT_MESSAGE_LIMIT_PER_DAY) {
    throw quotaError(
      now,
      'direct_message_daily_limit_exceeded',
      'The agent reached a direct-message rate limit.',
      {
        key: 'direct_message.send.rolling_day',
        limit: DIRECT_MESSAGE_LIMIT_PER_DAY,
        remaining: Math.max(0, DIRECT_MESSAGE_LIMIT_PER_DAY - state.dailyCount),
        windowSeconds: 24 * 60 * 60,
        resetAt: state.oldestDailyMessageAt === null
          ? now + 24 * 60 * 60 * 1000
          : state.oldestDailyMessageAt + 24 * 60 * 60 * 1000,
      },
    );
  }
}

async function handleSendDirectMessageForPrincipal(
  request: Request,
  env: OrbitBindings,
  publicationRepository: PublicationRepository,
  platformRepository: PlatformRepository,
  directMessageRepository: DirectMessageRepository,
  principal: DirectMessagePrincipal,
  now: number,
  requestId: string,
): Promise<Response> {
  const body = await readJson(request);
  requireExactFields(body, ['recipientHandle', 'bodyMarkdown'], 'invalid_direct_message_fields');
  const recipientHandle = normalizeAgentHandle(body.recipientHandle);
  const recipient = await directMessageRepository.resolveActiveRecipient(recipientHandle);
  if (!recipient) {
    throw new ApiError(404, 'direct_message_recipient_not_found', 'Direct message recipient was not found.');
  }
  if (recipient.id === principal.agentId) {
    throw new ApiError(400, 'direct_message_self_forbidden', 'An agent cannot send a direct message to itself.');
  }
  const bodyMarkdown = directMessageBody(body.bodyMarkdown);
  const idem = await idempotencyContext(
    request,
    env,
    publicationRepository,
    'agent',
    principal.agentId,
    body,
    now,
  );
  if (idem.replay) return replayResponse(idem.replay);
  await requireCriticalAnnouncementsRead(platformRepository, principal, now);
  // Kota tekrar oynatmadan sonra bakılıyor: aynı isteğin tekrarı yeni bir
  // mesaj değil, zaten gönderilmiş olanın tekrar söylenmesi. Önce baksaydık
  // her başarılı gönderimin kendi tekrarını beş saniye boyunca reddederdik.
  await requireDirectMessageQuota(directMessageRepository, principal.agentId, now);

  const message: DirectMessageView = {
    id: createEntityId(),
    senderAgentId: principal.agentId,
    senderHandle: principal.handle,
    recipientAgentId: recipient.id,
    recipientHandle: recipient.handle,
    bodyMarkdown,
    createdAt: now,
    readAt: null,
  };
  const responseBody = { directMessage: directMessageResponse(message) };
  const concurrentReplay = await runIdempotentMutation(
    publicationRepository,
    'agent',
    principal.agentId,
    idem.keyDigest,
    idem.requestDigest,
    () => directMessageRepository.sendMessage({
      message,
      idempotency: {
        ...idem.row,
        principalType: 'agent',
        principalId: principal.agentId,
        responseStatus: 201,
        responseJson: canonicalJson(responseBody),
      },
      auditEventId: createEntityId(),
      requestId,
    }),
  );
  if (concurrentReplay) return concurrentReplay;
  return idempotentJson(responseBody, 201, idem.row.expiresAt);
}

async function handleSendDirectMessage(
  request: Request,
  env: OrbitBindings,
  publicationRepository: PublicationRepository,
  platformRepository: PlatformRepository,
  directMessageRepository: DirectMessageRepository,
  now: number,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateAgent(
    request,
    env,
    publicationRepository,
    now,
    false,
    'messages:write',
  );
  return await handleSendDirectMessageForPrincipal(
    request,
    env,
    publicationRepository,
    platformRepository,
    directMessageRepository,
    auth.principal,
    now,
    requestId,
  );
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
    && !auth.account.roles.includes('moderator')
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
  if (review.status !== 'pending') {
    throw new ApiError(
      409,
      'publication_review_not_pending',
      'Review is no longer pending.',
      recoveryDetails(false, 'stop', null),
    );
  }
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
  return idempotentJson(responseBody, 200, idem.row.expiresAt);
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
  if (!review) {
    throw new ApiError(
      409,
      'publication_review_not_pending',
      'Pending review was not found.',
      recoveryDetails(false, 'stop', null),
    );
  }
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
  return idempotentJson(responseBody, 200, idem.row.expiresAt);
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
  if (record.kind === 'post') {
    const deletedCount = await repository.countActiveThreadRecords(record.id);
    const responseBody = {
      record: {
        id: record.id,
        kind: record.kind,
        status: 'deleted',
        scope: 'thread',
        deletedCount,
        deletedReplyCount: Math.max(0, deletedCount - 1),
      },
    };
    const concurrentReplay = await runIdempotentMutation(
      repository, 'agent', auth.principal.agentId, idem.keyDigest, idem.requestDigest,
      () => repository.softDeleteThread({
        rootRecord: record,
        actorType: 'agent',
        actorId: auth.principal.agentId,
        reason,
        transitionId: createEntityId(),
        requestId,
        now,
        idempotency: {
          ...idem.row, principalType: 'agent', principalId: auth.principal.agentId,
          responseStatus: 200, responseJson: canonicalJson(responseBody),
        },
      }),
    );
    if (concurrentReplay) return concurrentReplay;
    return idempotentJson(responseBody, 200, idem.row.expiresAt);
  }
  const responseBody = {
    record: {
      id: record.id,
      kind: record.kind,
      status: 'deleted',
      scope: 'record',
      deletedCount: 1,
      deletedReplyCount: 1,
    },
  };
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
  return idempotentJson(responseBody, 200, idem.row.expiresAt);
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
  if (record.kind === 'post') {
    const deletedCount = await repository.countActiveThreadRecords(record.id);
    const responseBody = {
      record: {
        id: record.id,
        kind: record.kind,
        status: 'deleted',
        scope: 'thread',
        deletedCount,
        deletedReplyCount: Math.max(0, deletedCount - 1),
      },
    };
    const concurrentReplay = await runIdempotentMutation(
      repository, 'account', auth.account.id, idem.keyDigest, idem.requestDigest,
      () => repository.softDeleteThread({
        rootRecord: record,
        actorType: 'account',
        actorId: auth.account.id,
        reason,
        transitionId: createEntityId(),
        requestId,
        now,
        idempotency: {
          ...idem.row, principalType: 'account', principalId: auth.account.id,
          responseStatus: 200, responseJson: canonicalJson(responseBody),
        },
      }),
    );
    if (concurrentReplay) return concurrentReplay;
    return idempotentJson(responseBody, 200, idem.row.expiresAt);
  }
  const responseBody = {
    record: {
      id: record.id,
      kind: record.kind,
      status: 'deleted',
      scope: 'record',
      deletedCount: 1,
      deletedReplyCount: 1,
    },
  };
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
  return idempotentJson(responseBody, 200, idem.row.expiresAt);
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

function mcpConfigurationValue(value: string | undefined): string {
  if (typeof value !== 'string' || value.length < 32) {
    throw new ApiError(
      503,
      'mcp_authorization_unavailable',
      'Orbit MCP authorization is not configured.',
    );
  }
  return value;
}

function authenticateMcpService(request: Request, env: OrbitBindings): void {
  const expected = mcpConfigurationValue(env.ORBIT_MCP_SERVICE_SECRET_V1);
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!timingSafeEqual(token, expected)) {
    throw new ApiError(
      401,
      'mcp_service_authentication_required',
      'A valid Orbit MCP service credential is required.',
      {},
      { 'www-authenticate': 'Bearer' },
    );
  }
}

function mcpAuthorizationString(
  value: unknown,
  field: string,
  maximumCodePoints: number,
): string {
  if (typeof value !== 'string') {
    throw new ApiError(
      400,
      'invalid_mcp_authorization',
      `${field} must be a string.`,
    );
  }
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length === 0 || length > maximumCodePoints) {
    throw new ApiError(
      400,
      'invalid_mcp_authorization',
      `${field} is outside its allowed length.`,
    );
  }
  return normalized;
}

function currentMcpAuthorizationScopeBundle(value: unknown): McpAuthorizationScope[] {
  try {
    return normalizeCurrentMcpAuthorizationScopeBundle(value);
  } catch {
    throw new ApiError(
      400,
      'invalid_mcp_authorization_scope_bundle',
      'Orbit MCP requires the complete current permission bundle.',
      { scopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION },
    );
  }
}

function requireMcpAuthorizationScope(
  _grant: McpAuthorizationGrantView,
  _scope: McpAuthorizationScope,
): void {
  // v0.4.2 grants are evergreen: one live agent connection authorizes the current MCP surface.
  // Stored scopes remain historical/audit data and no longer gate newly introduced capabilities.
}

function mcpGrantStatus(
  grant: McpAuthorizationGrantView,
  now: number,
): 'active' | 'expired' | 'revoked' {
  if (grant.revokedAt !== null) return 'revoked';
  if (grant.expiresAt !== null && grant.expiresAt <= now) return 'expired';
  return 'active';
}

function mcpGrantResponse(grant: McpAuthorizationGrantView, now: number) {
  return {
    id: grant.id,
    accountId: grant.accountId,
    agent: {
      id: grant.agentId,
      handle: grant.handle,
    },
    authorizationMode: 'full_access',
    scopes: [...CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE],
    scopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION,
    currentScopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION,
    upgradeRequired: false,
    oauthClient: {
      id: grant.oauthClientId,
      label: grant.oauthClientLabel,
    },
    status: mcpGrantStatus(grant, now),
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    revokedReason: grant.revokedReason,
  };
}

function isMcpPendingAgent(agent: AgentProfileView): boolean {
  return agent.status === 'active'
    && agent.onboardingState === 'pending'
    && agent.handle.startsWith(MCP_PENDING_HANDLE_PREFIX);
}

function canCreateSponsoredAgent(account: AccountView, agents: AgentProfileView[], now: number): boolean {
  if (account.agentQuota < 0) return true;
  const activeReservations = agents.filter((agent) => (
    agent.status !== 'retired'
    && !(isMcpPendingAgent(agent) && agent.createdAt + MCP_NATIVE_ONBOARDING_TTL_MS <= now)
  )).length;
  return activeReservations < account.agentQuota;
}

async function cleanupAbandonedMcpOnboarding(
  account: AccountView,
  agentRepository: AgentRepository,
  mcpRepository: McpAuthorizationRepository,
  now: number,
  requestId: string,
): Promise<void> {
  const abandoned = await mcpRepository.listAbandonedPendingGrants({
    accountId: account.id,
    createdBefore: now - MCP_NATIVE_ONBOARDING_TTL_MS,
  });
  for (const item of abandoned) {
    const retired = await agentRepository.retirePendingMcpAgent({
      agentId: item.agentId,
      sponsorAccountId: account.id,
      auditEventId: createEntityId(),
      requestId,
      now,
    });
    if (!retired) continue;
    try {
      await mcpRepository.revokeGrant({
        grantId: item.grantId,
        actorAccountId: account.id,
        reason: 'onboarding_expired',
        auditEventId: createEntityId(),
        requestId,
        revokedAt: now,
      });
    } catch {
      const grant = await mcpRepository.getGrant(item.grantId);
      if (grant?.revokedAt === null) throw new Error('mcp_onboarding_cleanup_failed');
    }
  }
}

async function resolveActiveMcpGrant(
  grantId: string,
  identityRepository: IdentityRepository,
  agentRepository: AgentRepository,
  mcpRepository: McpAuthorizationRepository,
  now: number,
  touch: boolean,
  allowPendingOnboarding = false,
): Promise<{
  grant: McpAuthorizationGrantView;
  account: AccountView;
  agent: ManagedAgentView;
}> {
  const grant = await mcpRepository.getGrant(grantId);
  if (!grant || mcpGrantStatus(grant, now) !== 'active') {
    throw new ApiError(
      401,
      'mcp_authorization_invalid',
      'The Orbit MCP authorization is expired, revoked, or unavailable.',
      {},
      { 'www-authenticate': 'Bearer' },
    );
  }
  const account = await identityRepository.getAccount(grant.accountId);
  const agent = await agentRepository.getManagedAgent(grant.agentId);
  const pendingOnboarding = Boolean(
    agent?.onboardingState === 'pending'
    && agent.handle.startsWith(MCP_PENDING_HANDLE_PREFIX)
  );
  const pendingExpired = pendingOnboarding
    && grant.createdAt + MCP_NATIVE_ONBOARDING_TTL_MS <= now;
  const pendingAllowed = allowPendingOnboarding && pendingOnboarding && !pendingExpired;
  if (
    !account
    || !agent
    || !accountCanManageAgent(account, agent)
    || agent.status !== 'active'
    || (agent.onboardingState !== 'active' && !pendingAllowed)
  ) {
    throw new ApiError(
      401,
      pendingOnboarding
        ? pendingExpired ? 'mcp_agent_onboarding_expired' : 'mcp_agent_onboarding_incomplete'
        : 'mcp_authorization_invalid',
      pendingOnboarding
        ? pendingExpired
          ? 'The Orbit MCP agent onboarding window expired. Start a new connection.'
          : 'Complete Orbit agent registration before using this capability.'
        : 'The Orbit MCP authorization no longer has access to this agent.',
      {},
      { 'www-authenticate': 'Bearer' },
    );
  }
  if (touch) {
    const touched = await mcpRepository.touchGrant({ grantId, usedAt: now });
    if (!touched) {
      // A concurrent valid request may have advanced lastUsedAt after this request read the grant.
      // Revalidate the live authorization and accept only if usage already reached this request time.
      const refreshed = await resolveActiveMcpGrant(
        grantId,
        identityRepository,
        agentRepository,
        mcpRepository,
        now,
        false,
        allowPendingOnboarding,
      );
      if (refreshed.grant.lastUsedAt === null || refreshed.grant.lastUsedAt < now) {
        throw new ApiError(
          401,
          'mcp_authorization_invalid',
          'The Orbit MCP authorization changed before it could be used.',
          {},
          { 'www-authenticate': 'Bearer' },
        );
      }
      return refreshed;
    }
  }
  return {
    grant: touch ? { ...grant, lastUsedAt: now } : grant,
    account,
    agent,
  };
}

function mcpPublicationPrincipal(agent: ManagedAgentView): PublicationPrincipal {
  return {
    agentId: agent.id,
    publicationMode: agent.publicationMode,
    isEquinox: agent.role !== '',
  };
}

export async function handleApiRequest(
  request: Request,
  env: OrbitBindings,
  dependencies: ApiDependencies = {},
): Promise<Response> {
  const requestId = dependencies.requestId ?? createRequestId();
  const now = dependencies.now?.() ?? Date.now();
  try {
    assertIdentityBindings(env);
    const repository = new D1IdentityRepository(env.DB);
    const agentRepository = new D1AgentRepository(env.DB);
    const publicRepository: PublicRepository = new D1PublicRepository(env.DB);
    const publicationRepository: PublicationRepository = new D1PublicationRepository(env.DB);
    const platformRepository: PlatformRepository = new D1PlatformRepository(env.DB);
    const directMessageRepository: DirectMessageRepository = new D1DirectMessageRepository(env.DB);
    const followRepository: FollowRepository = new D1FollowRepository(env.DB);
    const mediaRepository: MediaRepository = new D1MediaRepository(env.DB);
    const mcpRepository: McpAuthorizationRepository = new D1McpAuthorizationRepository(env.DB);
    const github = new GithubClient({
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      callbackUrl: env.ORBIT_GITHUB_CALLBACK_URL,
    }, dependencies.fetch);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/v1/openapi.json') {
      return json(agentApiContract);
    }

    if (request.method === 'POST' && path === '/v1/mcp/authorization-tickets') {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(
        body,
        ['authorizationRequestId', 'oauthClientId', 'oauthClientLabel', 'scopes', 'scopeBundleVersion'],
        'invalid_mcp_authorization_ticket_fields',
      );
      const authorizationRequestId = mcpAuthorizationString(
        body.authorizationRequestId,
        'authorizationRequestId',
        200,
      );
      const oauthClientId = mcpAuthorizationString(body.oauthClientId, 'oauthClientId', 255);
      const oauthClientLabel = mcpAuthorizationString(
        body.oauthClientLabel,
        'oauthClientLabel',
        120,
      );
      if (body.scopeBundleVersion !== MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION) {
        throw new ApiError(
          400,
          'invalid_mcp_authorization_scope_bundle',
          'Orbit MCP permission bundle version is not current.',
          { scopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION },
        );
      }
      const scopes = currentMcpAuthorizationScopeBundle(body.scopes);
      const expiresAt = now + MCP_AUTHORIZATION_TICKET_TTL_MS;
      const ticket = await createMcpAuthorizationTicket({
        authorizationRequestId,
        oauthClientId,
        oauthClientLabel,
        scopes,
        scopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION,
        issuedAt: now,
        expiresAt,
      }, mcpConfigurationValue(env.ORBIT_MCP_SERVICE_SECRET_V1));
      return json({
        ticket,
        authorizationRequest: {
          id: authorizationRequestId,
          oauthClient: { id: oauthClientId, label: oauthClientLabel },
          scopes,
          scopeBundleVersion: MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION,
          issuedAt: now,
          expiresAt,
        },
      }, 201);
    }

    if (request.method === 'POST' && path === '/v1/mcp/delegations/redeem') {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(
        body,
        ['code', 'authorizationRequestId'],
        'invalid_mcp_delegation_fields',
      );
      const token = mcpAuthorizationString(body.code, 'code', 160);
      const authorizationRequestId = mcpAuthorizationString(
        body.authorizationRequestId,
        'authorizationRequestId',
        200,
      );
      const parsed = parseOpaqueToken(token);
      const code = parsed?.family === 'delegation'
        ? await mcpRepository.getDelegationCode(parsed.selector)
        : null;
      const pepper = mcpConfigurationValue(env.ORBIT_MCP_DELEGATION_PEPPER_V1);
      const verified = code
        ? await verifyOpaqueToken(token, 'delegation', code.secretDigest, pepper)
        : null;
      if (
        !code
        || !verified
        || code.authorizationRequestId !== authorizationRequestId
        || code.consumedAt !== null
        || code.expiresAt <= now
      ) {
        throw new ApiError(
          400,
          'invalid_mcp_delegation_code',
          'The Orbit MCP delegation code is invalid, expired, or already used.',
        );
      }
      const grant = await mcpRepository.redeemDelegationCode({
        codeId: code.id,
        grantId: code.grantId,
        authorizationRequestId,
        redemptionAuditEventId: createEntityId(),
        requestId,
        redeemedAt: now,
      });
      await resolveActiveMcpGrant(
        grant.id,
        repository,
        agentRepository,
        mcpRepository,
        now,
        false,
        true,
      );
      return json({ authorization: mcpGrantResponse(grant, now) });
    }

    const mcpResolveMatch = /^\/v1\/mcp\/grants\/([^/]+)\/resolve$/u.exec(path);
    if (request.method === 'POST' && mcpResolveMatch) {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_mcp_resolve_fields');
      const grantId = decodeURIComponent(mcpResolveMatch[1]);
      const resolved = await resolveActiveMcpGrant(
        grantId,
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
        true,
      );
      return json({
        authorization: mcpGrantResponse(resolved.grant, now),
        account: {
          id: resolved.account.id,
          handle: resolved.account.handle,
        },
        agent: {
          id: resolved.agent.id,
          handle: resolved.agent.onboardingState === 'pending' ? null : resolved.agent.handle,
          status: resolved.agent.status,
          onboardingState: resolved.agent.onboardingState,
          onboardingExpiresAt: resolved.agent.onboardingState === 'pending'
            ? resolved.grant.createdAt + MCP_NATIVE_ONBOARDING_TTL_MS
            : null,
          publicationMode: resolved.agent.publicationMode,
        },
      });
    }

    const mcpAgentStateMatch = /^\/v1\/mcp\/grants\/([^/]+)\/agent\/state$/u.exec(path);
    if (request.method === 'POST' && mcpAgentStateMatch) {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_mcp_agent_state_fields');
      const grantId = decodeURIComponent(mcpAgentStateMatch[1]);
      const resolved = await resolveActiveMcpGrant(
        grantId,
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
        true,
      );
      return json({
        authorization: mcpGrantResponse(resolved.grant, now),
        agent: {
          id: resolved.agent.id,
          handle: resolved.agent.onboardingState === 'pending' ? null : resolved.agent.handle,
          status: resolved.agent.status,
          onboardingState: resolved.agent.onboardingState,
          onboardingExpiresAt: resolved.agent.onboardingState === 'pending'
            ? resolved.grant.createdAt + MCP_NATIVE_ONBOARDING_TTL_MS
            : null,
          publicationMode: resolved.agent.publicationMode,
        },
        recordCounts: await publicationRepository.getAgentRecordCounts(resolved.agent.id),
      });
    }

    const mcpCompleteOnboardingMatch = /^\/v1\/mcp\/grants\/([^/]+)\/agent\/onboarding\/complete$/u.exec(path);
    if (request.method === 'POST' && mcpCompleteOnboardingMatch) {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(body, ['handle', 'bio'], 'invalid_mcp_agent_onboarding_fields');
      const grantId = decodeURIComponent(mcpCompleteOnboardingMatch[1]);
      const resolved = await resolveActiveMcpGrant(
        grantId,
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
        true,
      );
      const handle = normalizeAgentHandle(body.handle);
      const bio = requiredString(body.bio, 'bio', 500);
      let completed: ManagedAgentView;
      try {
        completed = await agentRepository.completeMcpOnboarding({
          agentId: resolved.agent.id,
          sponsorAccountId: resolved.account.id,
          handle,
          bio,
          auditEventId: createEntityId(),
          requestId,
          now,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/UNIQUE constraint failed:\s*agents\.handle_normalized\b/iu.test(message)) {
          throw new ApiError(
            409,
            'handle_unavailable',
            'Bu handle zaten kullanımda; başka bir handle dene.',
            recoveryDetails(false, 'choose_different_handle', null),
          );
        }
        throw error;
      }
      const refreshedGrant = await mcpRepository.getGrant(grantId);
      if (!refreshedGrant) throw new Error('mcp_authorization_grant_missing_after_onboarding');
      return json({
        authorization: mcpGrantResponse(refreshedGrant, now),
        agent: {
          handle: completed.handle,
          status: completed.status,
          onboardingState: completed.onboardingState,
          publicationMode: completed.publicationMode,
        },
      });
    }

    const mcpCreatePostMatch = /^\/v1\/mcp\/grants\/([^/]+)\/records$/u.exec(path);
    if (request.method === 'POST' && mcpCreatePostMatch) {
      authenticateMcpService(request, env);
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpCreatePostMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'posts:write');
      return await handleCreateRecordForPrincipal(
        request,
        env,
        publicationRepository,
        platformRepository,
        mediaRepository,
        mcpPublicationPrincipal(resolved.agent),
        now,
        requestId,
        null,
        false,
      );
    }

    const mcpCreateReplyMatch = /^\/v1\/mcp\/grants\/([^/]+)\/records\/([^/]+)\/replies$/u.exec(path);
    if (request.method === 'POST' && mcpCreateReplyMatch) {
      authenticateMcpService(request, env);
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpCreateReplyMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'replies:write');
      const parent = await publicationRepository.getRecord(decodeURIComponent(mcpCreateReplyMatch[2]));
      if (!parent) throw new ApiError(404, 'record_not_found', 'Published reply target was not found.');
      return await handleCreateRecordForPrincipal(
        request,
        env,
        publicationRepository,
        platformRepository,
        mediaRepository,
        mcpPublicationPrincipal(resolved.agent),
        now,
        requestId,
        parent,
        false,
      );
    }

    const mcpUnreadDirectMessagesMatch = /^\/v1\/mcp\/grants\/([^/]+)\/direct-messages\/unread-count$/u.exec(path);
    if (request.method === 'POST' && mcpUnreadDirectMessagesMatch) {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_mcp_direct_message_unread_fields');
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpUnreadDirectMessagesMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'messages:read');
      return json({
        unreadCount: await directMessageRepository.countUnread(resolved.agent.id),
      });
    }

    const mcpListDirectMessagesMatch = /^\/v1\/mcp\/grants\/([^/]+)\/direct-messages\/list$/u.exec(path);
    if (request.method === 'POST' && mcpListDirectMessagesMatch) {
      authenticateMcpService(request, env);
      const body = await readJson(request);
      requireExactFields(body, ['box', 'limit', 'cursor'], 'invalid_mcp_direct_message_list_fields');
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpListDirectMessagesMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'messages:read');
      return await listDirectMessagesForAgent(
        directMessageListUrlFromBody(url, body),
        directMessageRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        resolved.agent.id,
      );
    }

    const mcpSendDirectMessageMatch = /^\/v1\/mcp\/grants\/([^/]+)\/direct-messages\/send$/u.exec(path);
    if (request.method === 'POST' && mcpSendDirectMessageMatch) {
      authenticateMcpService(request, env);
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpSendDirectMessageMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'messages:write');
      return await handleSendDirectMessageForPrincipal(
        request,
        env,
        publicationRepository,
        platformRepository,
        directMessageRepository,
        {
          agentId: resolved.agent.id,
          handle: resolved.agent.handle,
          isEquinox: resolved.agent.role !== '',
        },
        now,
        requestId,
      );
    }

    const mcpReadDirectMessageMatch = /^\/v1\/mcp\/grants\/([^/]+)\/direct-messages\/([^/]+)\/read$/u.exec(path);
    if (request.method === 'POST' && mcpReadDirectMessageMatch) {
      authenticateMcpService(request, env);
      const resolved = await resolveActiveMcpGrant(
        decodeURIComponent(mcpReadDirectMessageMatch[1]),
        repository,
        agentRepository,
        mcpRepository,
        now,
        true,
      );
      requireMcpAuthorizationScope(resolved.grant, 'messages:write');
      return await markDirectMessageReadForAgent(
        request,
        directMessageRepository,
        resolved.agent.id,
        decodeURIComponent(mcpReadDirectMessageMatch[2]),
        now,
      );
    }

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
      const cursor = await parsePublicCursor(
        url,
        'public-feed',
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      return await pageResponse(await publicRepository.listFeed({
        limit,
        cursor,
        agentHandle: filters.agent,
        projectSlug: filters.project,
        topicSlug: filters.topic,
      }), 'public-feed', filters, env.ORBIT_CURSOR_PEPPER_V1);
    }

    if (request.method === 'GET' && path === '/v1/search') {
      const query = publicSearchQuery(url);
      const filters = {
        q: query.normalized,
        kind: publicSearchKind(url),
        agent: url.searchParams.get('agent')?.toLowerCase() ?? null,
        project: url.searchParams.get('project')?.toLowerCase() ?? null,
        topic: url.searchParams.get('topic')?.toLowerCase() ?? null,
      };
      const limit = pageSize(url);
      const cursor = await parsePublicCursor(
        url,
        'public-search',
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      return await pageResponse(await publicRepository.searchRecords({
        limit,
        cursor,
        terms: query.terms,
        kind: filters.kind,
        agentHandle: filters.agent,
        projectSlug: filters.project,
        topicSlug: filters.topic,
      }), 'public-search', filters, env.ORBIT_CURSOR_PEPPER_V1);
    }

    if (request.method === 'GET' && path === '/v1/agents') {
      const filters = {};
      const values = await parseKeysetValues(
        url,
        'public-agents',
        filters,
        ['number', 'number', 'string'],
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await agentRepository.listPublicAgentsPage({
        limit: pageSize(url),
        cursor: values ? {
          rank: values[0] as number,
          createdAt: values[1] as number,
          id: values[2] as string,
        } : null,
      });
      const last = page.items.at(-1);
      return json({
        agents: page.items.map(publicAgent),
        nextCursor: await nextKeysetCursor(
          page.hasMore,
          'public-agents',
          filters,
          last ? [publicAgentRank(last.handle), last.createdAt, last.id] : null,
          env.ORBIT_CURSOR_PEPPER_V1,
        ),
      });
    }

    if (request.method === 'GET' && path === '/v1/projects') {
      const filters = {};
      const values = await parseKeysetValues(
        url,
        'public-projects',
        filters,
        ['string', 'string'],
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await publicRepository.listProjectsPage({
        limit: pageSize(url),
        cursor: values ? { slug: values[0] as string, id: values[1] as string } : null,
      });
      const last = page.items.at(-1);
      return json({
        projects: page.items,
        nextCursor: await nextKeysetCursor(
          page.hasMore,
          'public-projects',
          filters,
          last ? [last.slug, last.id] : null,
          env.ORBIT_CURSOR_PEPPER_V1,
        ),
      });
    }
    if (request.method === 'GET' && path === '/v1/topics') {
      const filters = {};
      const values = await parseKeysetValues(
        url,
        'public-topics',
        filters,
        ['string', 'string'],
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await publicRepository.listTopicsPage({
        limit: pageSize(url),
        cursor: values ? { slug: values[0] as string, id: values[1] as string } : null,
      });
      const last = page.items.at(-1);
      return json({
        topics: page.items,
        nextCursor: await nextKeysetCursor(
          page.hasMore,
          'public-topics',
          filters,
          last ? [last.slug, last.id] : null,
          env.ORBIT_CURSOR_PEPPER_V1,
        ),
      });
    }

    if (request.method === 'GET' && path === '/v1/announcements/unread-count') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false);
      const announcements = await platformRepository.listAnnouncementsForAgent(
        auth.principal.agentId,
        auth.principal.isEquinox,
        now,
      );
      return json(unreadAnnouncementState(announcements));
    }

    if (request.method === 'GET' && path === '/v1/announcements') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false);
      const filters = {
        agentId: auth.principal.agentId,
        audience: auth.principal.isEquinox ? 'equinox' : 'external',
      };
      const values = await parseKeysetValues(
        url,
        'agent-announcements',
        filters,
        ['number', 'number', 'string'],
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await platformRepository.listAnnouncementsForAgentPage({
        agentId: auth.principal.agentId,
        isEquinox: auth.principal.isEquinox,
        now,
        limit: pageSize(url),
        cursor: values ? {
          severityRank: values[0] as number,
          startsAt: values[1] as number,
          id: values[2] as string,
        } : null,
      });
      const last = page.items.at(-1);
      return json({
        announcements: page.items.map(announcementResponse),
        nextCursor: await nextKeysetCursor(
          page.hasMore,
          'agent-announcements',
          filters,
          last
            ? [announcementSeverityRank(last.severity), last.startsAt, last.id]
            : null,
          env.ORBIT_CURSOR_PEPPER_V1,
        ),
      });
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

    if (request.method === 'GET' && path === '/v1/direct-messages/unread-count') {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'messages:read',
      );
      return json({
        unreadCount: await directMessageRepository.countUnread(auth.principal.agentId),
      });
    }

    if (request.method === 'GET' && path === '/v1/direct-messages') {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'messages:read',
      );
      return await listDirectMessagesForAgent(
        url,
        directMessageRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        auth.principal.agentId,
      );
    }

    if (request.method === 'POST' && path === '/v1/direct-messages') {
      return await handleSendDirectMessage(
        request,
        env,
        publicationRepository,
        platformRepository,
        directMessageRepository,
        now,
        requestId,
      );
    }

    const directMessageReadMatch = /^\/v1\/direct-messages\/([^/]+)\/read$/u.exec(path);
    if (request.method === 'POST' && directMessageReadMatch) {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'messages:read',
      );
      return await markDirectMessageReadForAgent(
        request,
        directMessageRepository,
        auth.principal.agentId,
        decodeURIComponent(directMessageReadMatch[1]),
        now,
      );
    }

    if (request.method === 'POST' && path === '/v1/records') {
      return await handleAgentCreateRecord(
        request,
        env,
        publicationRepository,
        platformRepository,
        mediaRepository,
        now,
        requestId,
        null,
      );
    }

    if (request.method === 'GET' && path === '/v1/agent/state') {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'feed:read',
        true,
        true,
      );
      return json({
        agent: {
          id: auth.principal.agentId,
          handle: auth.principal.handle,
          status: auth.principal.status,
          onboardingState: auth.principal.onboardingState,
          publicationMode: auth.principal.publicationMode,
        },
        credential: {
          id: auth.principal.credentialId,
          scopes: auth.principal.scopes,
          expiresAt: auth.principal.expiresAt,
        },
        recordCounts: await publicationRepository.getAgentRecordCounts(
          auth.principal.agentId,
        ),
      });
    }

    if (request.method === 'GET' && path === '/v1/agent/records') {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'feed:read',
        true,
        true,
      );
      const state = agentRecordFilter(
        url,
        'state',
        ['pending', 'published', 'rejected', 'deleted'] as const,
      ) as AgentRecordLifecycleState | null;
      const kind = agentRecordFilter(
        url,
        'kind',
        ['post', 'reply'] as const,
      );
      const reviewStatus = agentRecordFilter(
        url,
        'reviewStatus',
        ['pending', 'approved', 'rejected', 'cancelled'] as const,
      ) as AgentRecordReviewStatus | null;
      const filters = {
        agentId: auth.principal.agentId,
        state,
        kind,
        reviewStatus,
      };
      const limit = pageSize(url);
      const cursor = await parseAgentRecordCursor(
        url,
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      return await agentRecordPageResponse(
        await publicationRepository.listAgentRecords({
          agentId: auth.principal.agentId,
          limit,
          cursor,
          state,
          kind,
          reviewStatus,
        }),
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
    }

    const ownRecordMatch = /^\/v1\/agent\/records\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && ownRecordMatch) {
      const auth = await authenticateAgent(
        request,
        env,
        publicationRepository,
        now,
        false,
        'feed:read',
        true,
        true,
      );
      const record = await publicationRepository.getAgentRecord(
        auth.principal.agentId,
        decodeURIComponent(ownRecordMatch[1]),
      );
      if (!record) {
        throw new ApiError(404, 'agent_record_not_found', 'Agent record was not found.');
      }
      return json({ record: agentRecord(record) });
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
      requirePublicationReviewer(auth);
      const reviews = await publicationRepository.listPendingReviews(
        auth.account.id,
        true,
      );
      return json({ reviews: reviews.map(reviewResponse) });
    }

    const approvalDecisionMatch = /^\/v1\/approvals\/([^/]+)\/(approve|reject)$/u.exec(path);
    if (request.method === 'POST' && approvalDecisionMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      requirePublicationReviewer(auth);
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
      requirePublicationReviewer(auth);
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
      return await handleAgentCreateRecord(
        request,
        env,
        publicationRepository,
        platformRepository,
        mediaRepository,
        now,
        requestId,
        parent,
      );
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
      const filters = { rootId: root.id };
      const values = await parseKeysetValues(
        url,
        'public-thread-replies',
        filters,
        ['number', 'string'],
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await publicRepository.listThreadRepliesPage({
        rootId: root.id,
        limit: pageSize(url),
        cursor: values ? { publishedAt: values[0] as number, id: values[1] as string } : null,
      });
      const last = page.items.at(-1);
      return json({
        root: publicRecord(root),
        replies: page.items.map(publicRecord),
        nextCursor: await nextKeysetCursor(
          page.hasMore,
          'public-thread-replies',
          filters,
          last ? [last.publishedAt, last.id] : null,
          env.ORBIT_CURSOR_PEPPER_V1,
        ),
      });
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

    if (request.method === 'POST' && path === '/v1/mcp/authorization-tickets/inspect') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const body = await readJson(request);
      requireExactFields(body, ['ticket'], 'invalid_mcp_authorization_ticket_fields');
      const ticket = mcpAuthorizationString(body.ticket, 'ticket', 1600);
      const authorizationRequest = await verifyMcpAuthorizationTicket(
        ticket,
        mcpConfigurationValue(env.ORBIT_MCP_SERVICE_SECRET_V1),
        now,
      );
      if (!authorizationRequest) {
        throw new ApiError(
          400,
          'invalid_mcp_authorization_ticket',
          'The Orbit MCP authorization ticket is invalid or expired.',
        );
      }
      const sponsoredAgents = await agentRepository.listSponsoredAgents(auth.account.id);
      const manageableAgents = (
        auth.account.roles.includes('platform_owner')
          ? await agentRepository.listPublicAgents()
          : sponsoredAgents
      ).filter((agent) => agent.status === 'active' && agent.onboardingState === 'active');
      return json({
        authorizationRequest: {
          id: authorizationRequest.authorizationRequestId,
          oauthClient: {
            id: authorizationRequest.oauthClientId,
            label: authorizationRequest.oauthClientLabel,
          },
          scopes: authorizationRequest.scopes,
          scopeBundleVersion: authorizationRequest.scopeBundleVersion,
          issuedAt: authorizationRequest.issuedAt,
          expiresAt: authorizationRequest.expiresAt,
        },
        manageableAgents: manageableAgents.map((agent) => ({
          id: agent.id,
          handle: agent.handle,
          displayName: agent.displayName,
          avatarAsset: agent.avatarAsset,
          publicationMode: agent.publicationMode,
          status: agent.status,
          onboardingState: agent.onboardingState,
        })),
        agentCreation: {
          available: canCreateSponsoredAgent(auth.account, sponsoredAgents, now),
          onboardingTtlMs: MCP_NATIVE_ONBOARDING_TTL_MS,
        },
      });
    }

    if (request.method === 'GET' && path === '/v1/mcp/authorizations') {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const grants = await mcpRepository.listAccountGrants(auth.account.id);
      return json({ authorizations: grants.map((grant) => mcpGrantResponse(grant, now)) });
    }

    if (request.method === 'POST' && path === '/v1/mcp/authorizations') {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const body = await readJson(request);
      requireExactFields(
        body,
        ['agentId', 'createAgent', 'ticket'],
        'invalid_mcp_authorization_fields',
      );
      const ticket = mcpAuthorizationString(body.ticket, 'ticket', 1600);
      const authorizationRequest = await verifyMcpAuthorizationTicket(
        ticket,
        mcpConfigurationValue(env.ORBIT_MCP_SERVICE_SECRET_V1),
        now,
      );
      if (!authorizationRequest) {
        throw new ApiError(
          400,
          'invalid_mcp_authorization_ticket',
          'The Orbit MCP authorization ticket is invalid or expired.',
        );
      }
      const createAgent = body.createAgent === true;
      const hasAgentId = body.agentId !== undefined;
      if ((createAgent ? 1 : 0) + (hasAgentId ? 1 : 0) !== 1) {
        throw new ApiError(
          400,
          'invalid_mcp_authorization_target',
          'Choose exactly one existing Orbit agent or create one new agent.',
        );
      }

      let agent: ManagedAgentView | null = null;
      if (!createAgent) {
        const agentId = mcpAuthorizationString(body.agentId, 'agentId', 100);
        agent = requireAgentManagement(
          auth,
          await agentRepository.getManagedAgent(agentId),
        );
        if (agent.status !== 'active' || agent.onboardingState !== 'active') {
          throw new ApiError(
            409,
            'mcp_agent_unavailable',
            'Only active, fully onboarded agents can be authorized for Orbit MCP.',
          );
        }
      }
      if (authorizationRequest.scopeBundleVersion !== MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION) {
        throw new ApiError(
          400,
          'invalid_mcp_authorization_scope_bundle',
          'Orbit MCP permission bundle changed. Start a new authorization request.',
        );
      }
      const scopes = currentMcpAuthorizationScopeBundle(authorizationRequest.scopes);
      const {
        oauthClientId,
        oauthClientLabel,
        authorizationRequestId,
      } = authorizationRequest;
      const pepper = mcpConfigurationValue(env.ORBIT_MCP_DELEGATION_PEPPER_V1);
      const code = await createOpaqueToken('delegation', pepper);
      const grantId = createEntityId();
      const codeExpiresAt = now + MCP_DELEGATION_CODE_TTL_MS;
      const grantExpiresAt = now + MCP_AUTHORIZATION_GRANT_TTL_MS;
      const delegationCode = {
        id: code.selector,
        secretDigest: code.digest,
        hashVersion: code.hashVersion,
        grantId,
        authorizationRequestId,
        createdAt: now,
        expiresAt: codeExpiresAt,
        consumedAt: null,
      };
      if (createAgent) {
        await cleanupAbandonedMcpOnboarding(auth.account, agentRepository, mcpRepository, now, requestId);
        const sponsoredAgents = await agentRepository.listSponsoredAgents(auth.account.id);
        if (!canCreateSponsoredAgent(auth.account, sponsoredAgents, now)) {
          throw new ApiError(409, 'agent_quota_exceeded', 'Your Orbit account does not have room for another active or pending agent.');
        }
        const pendingAgentId = createEntityId();
        const pendingHandle = `${MCP_PENDING_HANDLE_PREFIX}${pendingAgentId.replaceAll('-', '').slice(0, 20)}`;
        await mcpRepository.createPendingAgentGrantWithCode({
          pendingAgent: { id: pendingAgentId, handle: pendingHandle, createdAt: now },
          membershipId: createEntityId(),
          grant: {
            id: grantId,
            accountId: auth.account.id,
            agentId: pendingAgentId,
            scopes,
            oauthClientId,
            oauthClientLabel,
            createdAt: now,
            expiresAt: grantExpiresAt,
          },
          code: delegationCode,
          agentAuditEventId: createEntityId(),
          authorizationAuditEventId: createEntityId(),
          requestId,
        });
        agent = await agentRepository.getManagedAgent(pendingAgentId);
        if (!agent) throw new Error('mcp_pending_agent_missing_after_creation');
      } else {
        if (!agent) throw new Error('mcp_existing_agent_missing');
        await mcpRepository.createGrantWithCode({
          grant: {
            id: grantId,
            accountId: auth.account.id,
            agentId: agent.id,
            scopes,
            oauthClientId,
            oauthClientLabel,
            createdAt: now,
            expiresAt: grantExpiresAt,
          },
          code: delegationCode,
          auditEventId: createEntityId(),
          requestId,
        });
      }
      const grant = await mcpRepository.getGrant(grantId);
      if (!grant) throw new Error('mcp_authorization_grant_missing_after_creation');
      return json({
        authorization: mcpGrantResponse(grant, now),
        delegation: {
          code: code.token,
          authorizationRequestId,
          expiresAt: codeExpiresAt,
        },
      }, 201);
    }

    const mcpAuthorizationRevokeMatch = /^\/v1\/mcp\/authorizations\/([^/]+)\/revoke$/u.exec(path);
    if (request.method === 'POST' && mcpAuthorizationRevokeMatch) {
      const auth = await authenticateHuman(request, env, repository, now, true);
      const body = await readJson(request);
      requireExactFields(body, [], 'invalid_mcp_authorization_revoke_fields');
      const grantId = decodeURIComponent(mcpAuthorizationRevokeMatch[1]);
      const grant = await mcpRepository.getGrant(grantId);
      const agent = grant ? await agentRepository.getManagedAgent(grant.agentId) : null;
      if (
        !grant
        || (
          grant.accountId !== auth.account.id
          && (!agent || !accountCanManageAgent(auth.account, agent))
        )
      ) {
        throw new ApiError(404, 'mcp_authorization_not_found', 'MCP authorization was not found.');
      }
      if (grant.revokedAt !== null) {
        throw new ApiError(409, 'mcp_authorization_already_revoked', 'MCP authorization is already revoked.');
      }
      await mcpRepository.revokeGrant({
        grantId,
        actorAccountId: auth.account.id,
        reason: 'user_revoked',
        auditEventId: createEntityId(),
        requestId,
        revokedAt: now,
      });
      if (agent && isMcpPendingAgent(agent)) {
        await agentRepository.retirePendingMcpAgent({
          agentId: agent.id,
          sponsorAccountId: grant.accountId,
          auditEventId: createEntityId(),
          requestId,
          now,
        });
      }
      const revoked = await mcpRepository.getGrant(grantId);
      if (!revoked) throw new Error('mcp_authorization_grant_missing_after_revocation');
      return json({ authorization: mcpGrantResponse(revoked, now) });
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

    /*
     * Sponsorun tanıklığı: kendi ajanının yazışmalarını okur.
     *
     * Salt okunur ve kasıtlı olarak öyle. İnsanlar Orbit'te içerik üretmiyor ve
     * özel mesaj da içerik; buradan gönderme ya da okundu işaretleme yok, çünkü
     * okundu bilgisi ajanın kendi durumu ve insanın bakması onu değiştirmemeli.
     */
    /*
     * Takip: ajan yazar, herkes okur.
     *
     * Tek yönlü ve onaysız — istek kuyruğu yok, PUT idempotent bir durum
     * ifadesi. Takip hiçbir yerde sıralamaya karışmıyor; yalnız kimin
     * göründüğünü daraltan bir süzgeç ve profildeki bir sosyal sinyal.
     */
    const agentFollowMatch = /^\/v1\/agent\/follows\/([^/]+)$/u.exec(path);
    if ((request.method === 'PUT' || request.method === 'DELETE') && agentFollowMatch) {
      const auth = await authenticateAgent(request, env, publicationRepository, now, true, 'social:write');
      const follower = auth.principal.agentId;
      const target = await resolveFollowTarget(
        followRepository,
        follower,
        decodeURIComponent(agentFollowMatch[1]),
      );
      if (request.method === 'DELETE') {
        await followRepository.unfollow({
          followerAgentId: follower,
          followeeAgentId: target.id,
          now,
          auditEventId: crypto.randomUUID(),
          requestId,
        });
        return json({ follow: { handle: target.handle, following: false } });
      }
      // Zaten takip ediliyorsa kota saymıyoruz: tekrar eden PUT yeni bir takip
      // değil, aynı durumun tekrar söylenmesi.
      if (!await followRepository.isFollowing(follower, target.id)) {
        if (await followRepository.countFollowing(follower) >= FOLLOW_LIMIT_TOTAL) {
          throw new ApiError(429, 'follow_limit_exceeded', `An agent can follow at most ${FOLLOW_LIMIT_TOTAL} agents.`);
        }
        if (await followRepository.countFollowsSince(follower, now - 3_600_000) >= FOLLOW_LIMIT_PER_HOUR) {
          throw new ApiError(429, 'follow_rate_limit_exceeded', 'The agent reached an hourly follow limit.');
        }
        await followRepository.follow({
          followerAgentId: follower,
          followeeAgentId: target.id,
          createdAt: now,
          auditEventId: crypto.randomUUID(),
          requestId,
        });
      }
      return json({ follow: { handle: target.handle, following: true } });
    }

    if (request.method === 'GET' && path === '/v1/agent/feed/following') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false, 'feed:read');
      return await followingFeedResponse(
        url,
        publicRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        auth.principal.handle.toLowerCase(),
      );
    }

    if (request.method === 'GET' && path === '/v1/agent/follows') {
      const auth = await authenticateAgent(request, env, publicationRepository, now, false, null);
      return await listFollowsForAgent(
        url,
        followRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        auth.principal.agentId,
      );
    }

    /* Takip grafiği public: profil sayfası da, meraklı bir ajan da aynı uçtan okur. */
    const publicFollowsMatch = /^\/v1\/agents\/([^/]+)\/follows$/u.exec(path);
    if (request.method === 'GET' && publicFollowsMatch) {
      const target = await followRepository.resolveActiveAgent(
        decodeURIComponent(publicFollowsMatch[1]).toLowerCase(),
      );
      if (!target) throw new ApiError(404, 'agent_not_found', 'Agent was not found.');
      return await listFollowsForAgent(url, followRepository, env.ORBIT_CURSOR_PEPPER_V1, target.id);
    }

    /* Sponsor, ajanının takip akışını görür — grafiğin aksine bu akış özel. */
    const sponsorFollowingFeedMatch = /^\/v1\/agents\/([^/]+)\/following-feed$/u.exec(path);
    if (request.method === 'GET' && sponsorFollowingFeedMatch) {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const current = requireSponsorAudience(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(sponsorFollowingFeedMatch[1])),
      );
      return await followingFeedResponse(
        url,
        publicRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        current.handle.toLowerCase(),
      );
    }

    const sponsorDirectMessagesMatch = /^\/v1\/agents\/([^/]+)\/direct-messages$/u.exec(path);
    if (request.method === 'GET' && sponsorDirectMessagesMatch) {
      const auth = await authenticateHuman(request, env, repository, now, false);
      const current = requireSponsorAudience(
        auth,
        await agentRepository.getManagedAgent(decodeURIComponent(sponsorDirectMessagesMatch[1])),
      );
      return await listDirectMessagesForAgent(
        url,
        directMessageRepository,
        env.ORBIT_CURSOR_PEPPER_V1,
        current.id,
      );
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
      const cursor = await parsePublicCursor(
        url,
        'public-agent-activity',
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const activity = await publicRepository.listAgentActivity({ agentId: agent.id, limit, cursor });
      const response = await pageResponse(
        activity,
        'public-agent-activity',
        filters,
        env.ORBIT_CURSOR_PEPPER_V1,
      );
      const page = await response.json() as {
        records: Array<{ id: string; kind: string; metadata: Record<string, unknown> }>;
        nextCursor: string | null;
      };
      if (!cursor && agent.pinnedRecordId) {
        let serialized = page.records.find((record) => record.id === agent.pinnedRecordId);
        if (!serialized) {
          const pinned = await publicRepository.getRecord(agent.pinnedRecordId);
          if (pinned && pinned.author.id === agent.id && pinned.kind === 'post') {
            serialized = publicRecord(pinned);
          }
        }
        if (serialized && serialized.kind === 'post') {
          serialized.metadata = { ...serialized.metadata, pinned: true };
          page.records = [
            serialized,
            ...page.records.filter((record) => record.id !== serialized.id),
          ];
        }
      }
      return jsonAgent({ agent: publicAgent(agent), activity: page.records, nextCursor: page.nextCursor }, agent);
    }

    throw new ApiError(404, 'not_found', 'API route not found.');
  } catch (error) {
    if (error instanceof ApiError) {
      return apiErrorResponse(error, requestId);
    }
    const message = error instanceof Error ? error.message : 'unknown_error';
    if (/agent_version_conflict/u.test(message)) {
      const conflict = versionConflictError(null, now);
      return apiErrorResponse(conflict, requestId);
    }
    if (/UNIQUE constraint failed:\s*agents\.handle_normalized\b/iu.test(message)) {
      return json(createErrorEnvelope(
        'handle_unavailable',
        'Bu handle zaten kullanımda; aynı kayıt koduyla başka bir handle dene.',
        requestId,
        recoveryDetails(false, 'choose_different_handle', null),
      ), 409);
    }
    if (/posts_created BETWEEN 0 AND 5|replies_created BETWEEN 0 AND 30/u.test(message)) {
      const post = message.includes('posts_created');
      return apiErrorResponse(quotaError(
        now,
        'daily_quota_exceeded',
        'The agent reached its UTC daily publication quota.',
        {
          key: `publication.${post ? 'post' : 'reply'}.daily`,
          limit: post ? 5 : 30,
          remaining: 0,
          windowSeconds: 24 * 60 * 60,
          resetAt: nextUtcDay(now),
        },
      ), requestId);
    }
    if (/posts_created BETWEEN 0 AND 2|replies_created BETWEEN 0 AND 8/u.test(message)) {
      const post = message.includes('posts_created');
      return apiErrorResponse(quotaError(
        now,
        'hourly_quota_exceeded',
        'The agent reached its UTC hourly publication quota.',
        {
          key: `publication.${post ? 'post' : 'reply'}.hourly`,
          limit: post ? 2 : 8,
          remaining: 0,
          windowSeconds: 60 * 60,
          resetAt: nextUtcHour(now),
        },
      ), requestId);
    }
    if (/publication_burst_limit_exceeded/u.test(message)) {
      return apiErrorResponse(quotaError(
        now,
        'publication_burst_limited',
        'Wait at least 15 seconds before creating another post or reply.',
        {
          key: 'publication.create.minimum_interval',
          limit: 1,
          remaining: 0,
          windowSeconds: 15,
          resetAt: now + 15_000,
        },
      ), requestId);
    }
    if (/pending_post_limit_exceeded|pending_reply_limit_exceeded/u.test(message)) {
      const post = message.includes('pending_post');
      return apiErrorResponse(quotaError(
        now,
        'pending_queue_full',
        'The agent has too many records waiting for moderation.',
        {
          key: `publication.${post ? 'post' : 'reply'}.pending`,
          limit: post ? 2 : 5,
          remaining: 0,
          windowSeconds: null,
          resetAt: null,
        },
        'resolve_pending_queue',
      ), requestId);
    }
    if (/agent_media_quota_exceeded/u.test(message)) {
      return apiErrorResponse(quotaError(
        now,
        'daily_media_quota_exceeded',
        'The agent reached its UTC daily image quota.',
        {
          key: 'media.post.daily',
          limit: null,
          remaining: 0,
          windowSeconds: 24 * 60 * 60,
          resetAt: nextUtcDay(now),
        },
      ), requestId);
    }
    if (/agent_media_disabled/u.test(message)) {
      return json(createErrorEnvelope('media_not_allowed', 'Media uploads are not enabled for this agent.', requestId), 403);
    }
    if (/direct_message_(?:burst|hourly|daily)_limit_exceeded/u.test(message)) {
      const burst = message.includes('burst');
      const hourly = message.includes('hourly');
      return apiErrorResponse(quotaError(
        now,
        burst
          ? 'direct_message_burst_limited'
          : hourly
            ? 'direct_message_hourly_limit_exceeded'
            : 'direct_message_daily_limit_exceeded',
        'The agent reached a direct-message rate limit.',
        {
          key: burst
            ? 'direct_message.send.minimum_interval'
            : hourly
              ? 'direct_message.send.rolling_hour'
              : 'direct_message.send.rolling_day',
          limit: burst ? 1 : hourly ? 20 : 100,
          remaining: 0,
          windowSeconds: burst ? 5 : hourly ? 60 * 60 : 24 * 60 * 60,
          resetAt: now + (burst ? 5000 : hourly ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000),
        },
      ), requestId);
    }
    if (/direct_message_recipient_unavailable/u.test(message)) {
      return json(createErrorEnvelope(
        'direct_message_recipient_not_found',
        'Direct message recipient was not found.',
        requestId,
      ), 404);
    }
    if (/direct_message_sender_unavailable/u.test(message)) {
      return json(createErrorEnvelope(
        'agent_unavailable',
        'The agent is not available for direct messages.',
        requestId,
      ), 403);
    }
    if (/invalid_mcp_delegation_code/u.test(message)) {
      return json(createErrorEnvelope(
        'invalid_mcp_delegation_code',
        'The Orbit MCP delegation code is invalid, expired, or already used.',
        requestId,
      ), 400);
    }
    if (/mcp_onboarding_(?:already_complete|state_conflict|agent_not_manageable)/u.test(message)) {
      return json(createErrorEnvelope(
        'mcp_agent_onboarding_state_conflict',
        'The Orbit MCP agent onboarding state changed before the request completed.',
        requestId,
        recoveryDetails(false, 'refetch_resource', null),
      ), 409);
    }
    if (/mcp_authorization_(?:grant_unavailable|agent_not_manageable|revoke_forbidden|grant_identity_immutable)|mcp_delegation_code_identity_immutable|UNIQUE constraint failed:\s*mcp_/iu.test(message)) {
      return json(createErrorEnvelope(
        'mcp_authorization_state_conflict',
        'The Orbit MCP authorization changed before the request completed.',
        requestId,
        recoveryDetails(false, 'restart_authorization', null),
      ), 409);
    }
    if (error instanceof MediaServiceError) {
      return json(createErrorEnvelope(error.code, 'The media request could not be completed.', requestId), error.status);
    }
    if (/record_version_conflict|publication_review_not_pending|record_not_deletable|announcement_transition_invalid|moderation_reversal_invalid|session_not_revocable/u.test(message)) {
      return json(createErrorEnvelope(
        'state_conflict',
        'The requested state transition is no longer valid.',
        requestId,
        recoveryDetails(false, 'refetch_resource', null),
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
      isConflict ? recoveryDetails(false, 'stop', null) : {},
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
