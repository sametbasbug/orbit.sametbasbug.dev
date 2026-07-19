import { runIdentityCleanup } from '../src/server/http/api';
import type { OrbitBindings } from '../src/server/identity/bindings';
import { createDynamicBackup, restoreDynamicBackup } from '../src/server/backup/dynamic-backup';
import {
  createChunkedBackup,
  restoreChunkedBackup,
} from '../src/server/backup/chunked-backup';
import { enforceBackupRetention, runR2Backup } from '../src/server/backup/r2-backup';
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from '../src/server/identity/bindings';
import { handleWorkerRequest } from '../src/worker';
import { cleanupMedia } from '../src/server/media/media-service';
import { D1MediaRepository } from '../src/server/repositories/d1/d1-media-repository';

interface TestStatement {
  bind(...values: unknown[]): TestStatement;
  run<T = unknown>(): Promise<T>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface TestEnv extends OrbitBindings {
  DB: OrbitBindings['DB'] & {
    prepare(query: string): TestStatement;
  };
}

const PROFILES = {
  owner: {
    id: 126420524,
    login: 'sametbasbug',
    name: 'Samet Başbuğ',
    avatar_url: 'https://example.test/owner.png',
  },
  selene: {
    id: 200000001,
    login: 'selene-owner',
    name: 'Selene Owner',
    avatar_url: 'https://example.test/selene.png',
  },
  mismatch: {
    id: 200000002,
    login: 'wrong-owner',
    name: 'Wrong Owner',
    avatar_url: null,
  },
} as const;

class MemoryR2 implements R2BucketLike {
  readonly objects = new Map<string, { value: Uint8Array; customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }>();
  async put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string>; sha256?: ArrayBuffer | Uint8Array | string }): Promise<R2ObjectLike> {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (options?.sha256 && typeof options.sha256 !== 'string') {
      const expected = options.sha256 instanceof Uint8Array ? options.sha256 : new Uint8Array(options.sha256);
      if (expected.byteLength !== digest.byteLength || !expected.every((item, index) => item === digest[index])) {
        throw new Error('r2_checksum_mismatch');
      }
    }
    const etag = [...digest.slice(0, 16)].map((item) => item.toString(16).padStart(2, '0')).join('');
    this.objects.set(key, { value: bytes, customMetadata: options?.customMetadata, httpMetadata: options?.httpMetadata });
    return { key, size: bytes.byteLength, etag, httpEtag: `"${etag}"`, customMetadata: options?.customMetadata };
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null> {
    const item = this.objects.get(key);
    const value = item && options?.range
      ? item.value.slice(options.range.offset, options.range.offset + options.range.length)
      : item?.value;
    if (!item || !value) return null;
    const valueCopy = Uint8Array.from(value);
    const itemCopy = Uint8Array.from(item.value);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', itemCopy));
    const etag = [...digest.slice(0, 16)].map((entry) => entry.toString(16).padStart(2, '0')).join('');
    return item ? {
      key,
      size: item.value.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      body: new Blob([valueCopy]).stream(),
      customMetadata: item.customMetadata,
      httpMetadata: item.httpMetadata,
      text: async () => new TextDecoder().decode(value),
      arrayBuffer: async () => value.slice().buffer,
    } : null;
  }
  async list(options: { prefix?: string } = {}): Promise<{ objects: R2ObjectLike[]; truncated: boolean }> {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .map(([key, item]) => ({ key, size: item.value.byteLength, etag: key, customMetadata: item.customMetadata })),
      truncated: false,
    };
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

const mediaBucket = new MemoryR2();

function profileForToken(token: string | null) {
  if (!token?.startsWith('Bearer test-token-')) return null;
  const key = token.slice('Bearer test-token-'.length) as keyof typeof PROFILES;
  return PROFILES[key] ?? null;
}

async function mockGithubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.href === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { code?: string };
    if (!body.code || !(body.code in PROFILES)) {
      return Response.json({ error: 'bad_verification_code' }, { status: 400 });
    }
    return Response.json({ access_token: `test-token-${body.code}`, token_type: 'bearer' });
  }
  if (url.href === 'https://api.github.com/user') {
    const profile = profileForToken(new Headers(init?.headers).get('authorization'));
    return profile ? Response.json(profile) : Response.json({ message: 'Bad credentials' }, { status: 401 });
  }
  const loginMatch = /^\/users\/([^/]+)$/u.exec(url.pathname);
  if (url.origin === 'https://api.github.com' && loginMatch) {
    const login = decodeURIComponent(loginMatch[1]).toLowerCase();
    const profile = Object.values(PROFILES).find((item) => item.login.toLowerCase() === login);
    return profile ? Response.json(profile) : Response.json({ message: 'Not Found' }, { status: 404 });
  }
  return Response.json({ message: 'Unexpected test URL' }, { status: 500 });
}

async function testRoute(request: Request, env: TestEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/__test/')) return null;
  const body = request.method === 'POST'
    ? await request.json() as Record<string, unknown>
    : {};
  const now = Number(request.headers.get('x-test-now') ?? Date.now());

  if (url.pathname === '/__test/seed-invitation') {
    const id = String(body.id);
    await env.DB.prepare(`
      INSERT INTO invitations (
        id, secret_digest, hash_version, expected_github_user_id,
        expected_github_login_snapshot, agent_quota,
        created_by_account_id, created_at, expires_at, revoked_at
      ) VALUES (?, ?, 1, ?, ?, 1,
        '019f64d2-0109-7644-9a4e-a0d25df888e2', ?, ?, ?)
    `).bind(
      id,
      String(body.digest),
      body.expectedGithubUserId ?? null,
      body.expectedGithubLogin ?? null,
      now,
      Number(body.expiresAt),
      body.revokedAt ?? null,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/state') {
    const githubUserId = String(body.githubUserId ?? '');
    const invitationId = String(body.invitationId ?? '');
    const account = githubUserId
      ? await env.DB.prepare(`
        SELECT a.id, a.status
        FROM auth_identities ai JOIN accounts a ON a.id = ai.account_id
        WHERE ai.provider_user_id = ?
      `).bind(githubUserId).first()
      : null;
    const invitation = invitationId
      ? await env.DB.prepare(`
        SELECT redeemed_at, revoked_at FROM invitations WHERE id = ?
      `).bind(invitationId).first()
      : null;
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM oauth_flows) AS oauth_flows,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM idempotency_keys) AS idempotency_keys,
        (SELECT COUNT(*) FROM audit_events) AS audit_events
    `).first();
    return Response.json({ account, invitation, counts });
  }

  if (url.pathname === '/__test/session') {
    const row = await env.DB.prepare(`
      SELECT id, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
      FROM sessions WHERE id = ?
    `).bind(String(body.id)).first();
    return Response.json({ row });
  }

  if (url.pathname === '/__test/agent-state') {
    const agentId = String(body.agentId ?? '');
    const agent = await env.DB.prepare(`
      SELECT id, handle, display_name, bio, publication_mode, status, version
      FROM agents WHERE id = ?
    `).bind(agentId).first();
    const credentials = agentId
      ? await env.DB.prepare(`
        SELECT id, secret_digest, scopes, revoked_at, revoked_reason,
               replaced_by_credential_id
        FROM agent_credentials
        WHERE agent_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all()
      : { results: [] };
    const audits = agentId
      ? await env.DB.prepare(`
        SELECT event_type, actor_id, metadata_json
        FROM audit_events
        WHERE subject_type = 'agent' AND subject_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all()
      : { results: [] };
    return Response.json({ agent, credentials: credentials.results, audits: audits.results });
  }

  if (url.pathname === '/__test/set-record-visibility') {
    await env.DB.batch([
      env.DB.prepare(`
      UPDATE records
      SET lifecycle_state = ?, deleted_at = ?, moderation_state = ?, moderated_at = ?
      WHERE slug = ?
      `).bind(
      String(body.lifecycleState ?? 'published'),
      body.deletedAt ?? null,
      String(body.moderationState ?? 'visible'),
      body.moderatedAt ?? null,
      String(body.slug),
      ),
      env.DB.prepare(`
        UPDATE public_cache_epochs
        SET version = version + 1, updated_at = ?
        WHERE namespace = 'public_read'
      `).bind(now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-agent-status') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE agents SET status = ? WHERE handle_normalized = ?`)
        .bind(String(body.status), String(body.handle).toLowerCase()),
      env.DB.prepare(`
        UPDATE public_cache_epochs
        SET version = version + 1, updated_at = ?
        WHERE namespace = 'public_read'
      `).bind(now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-publication-agent') {
    const accountId = String(body.accountId ?? '019f64d2-0109-7644-9a4e-a0d25df888e2');
    const agentId = String(body.agentId);
    const handle = String(body.handle);
    const now = Number(body.now ?? Date.now());
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO agents (
          id, handle, handle_normalized, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1,
          ?, '', '', '#6f63e8', '', '[]')
      `).bind(
        agentId, handle, handle.toLowerCase(), handle,
        String(body.bio ?? ''), String(body.avatarAsset ?? ''),
        String(body.publicationMode), String(body.status ?? 'active'),
        String(body.onboardingState ?? 'active'), now, now, String(body.role ?? ''),
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(String(body.membershipId), agentId, accountId, accountId, now),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_credentials (
          id, agent_id, secret_digest, hash_version, scopes,
          created_by_account_id, created_at
        ) VALUES (?, ?, ?, 1, 'feed:read records:write media:write profile:write', ?, ?)
      `).bind(String(body.credentialId), agentId, String(body.secretDigest), accountId, now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-human-session') {
    await env.DB.prepare(`
      INSERT INTO sessions (
        id, account_id, secret_digest, hash_version, csrf_digest,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      String(body.sessionId),
      String(body.accountId ?? '019f64d2-0109-7644-9a4e-a0d25df888e2'),
      String(body.secretDigest), String(body.csrfDigest), now, now,
      now + 7 * 86400000, now + 30 * 86400000,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-closed-account-session') {
    const accountId = String(body.accountId);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, display_name, avatar_url,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)
      `).bind(accountId, String(body.handle), String(body.handle), String(body.handle), now, now),
      env.DB.prepare(`
        INSERT INTO sessions (
          id, account_id, secret_digest, hash_version, csrf_digest,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at,
          revoked_at, revoked_reason
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'test_revoked_before_account_close')
      `).bind(
        String(body.sessionId), accountId, String(body.secretDigest), String(body.csrfDigest),
        now, now, now + 7 * 86400000, now + 30 * 86400000, now + 1000,
      ),
      env.DB.prepare(`
        UPDATE accounts SET status = 'closed', updated_at = ? WHERE id = ?
      `).bind(now + 2000, accountId),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/publication-state') {
    const record = await env.DB.prepare(`
      SELECT id, slug, lifecycle_state, current_revision_id, pending_revision_id,
             deleted_at, version FROM records WHERE id = ? OR slug = ? LIMIT 1
    `).bind(String(body.record), String(body.record)).first();
    const revisions = record ? await env.DB.prepare(`
      SELECT id, revision_number, body_markdown, summary, state, published_at
      FROM record_revisions WHERE record_id = ? ORDER BY revision_number
    `).bind((record as { id: string }).id).all() : { results: [] };
    const reviews = record ? await env.DB.prepare(`
      SELECT id, revision_id, status, reviewer_account_id, review_note
      FROM publication_reviews WHERE record_id = ? ORDER BY requested_at
    `).bind((record as { id: string }).id).all() : { results: [] };
    return Response.json({ record, revisions: revisions.results, reviews: reviews.results });
  }

  if (url.pathname === '/__test/publication-evidence') {
    const recordId = String(body.recordId);
    const audits = await env.DB.prepare(`
      SELECT event_type, actor_type, actor_id, metadata_json
      FROM audit_events WHERE subject_type = 'record' AND subject_id = ? ORDER BY sequence
    `).bind(recordId).all();
    const moderation = await env.DB.prepare(`
      SELECT id, action, actor_account_id, reason, reversed_by_action_id, reverses_action_id
      FROM moderation_actions WHERE target_type = 'record' AND target_id = ? ORDER BY created_at, id
    `).bind(recordId).all();
    return Response.json({ audits: audits.results, moderation: moderation.results });
  }

  if (url.pathname === '/__test/usage') {
    const rows = await env.DB.prepare(`
      SELECT day_utc, posts_created, replies_created, write_attempts
      FROM agent_usage_daily WHERE agent_id = ? ORDER BY day_utc
    `).bind(String(body.agentId)).all();
    return Response.json({ rows: rows.results });
  }

  if (url.pathname === '/__test/set-usage') {
    await env.DB.prepare(`
      INSERT INTO agent_usage_daily (
        agent_id, day_utc, posts_created, replies_created, write_attempts, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, day_utc) DO UPDATE SET
        posts_created = excluded.posts_created,
        replies_created = excluded.replies_created,
        write_attempts = excluded.write_attempts,
        updated_at = excluded.updated_at
    `).bind(
      String(body.agentId), String(body.dayUtc), Number(body.postsCreated ?? 0),
      Number(body.repliesCreated ?? 0), Number(body.writeAttempts ?? 0), now,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/backup-export') {
    return Response.json(await createDynamicBackup(env.DB, now, Boolean(body.includeSessions)));
  }

  if (url.pathname === '/__test/chunked-backup-export') {
    return Response.json(await createChunkedBackup(env.DB, now, Boolean(body.includeSessions)));
  }

  if (url.pathname === '/__test/chunked-backup-restore') {
    try {
      const proof = await restoreChunkedBackup(env.DB, body.backup, {
        revokeSecurity: Boolean(body.revokeSecurity), now,
      });
      return Response.json({ ok: true, proof });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof Error ? error.message : 'restore_failed',
      }, { status: 400 });
    }
  }

  if (url.pathname === '/__test/r2-backup') {
    const bucket = new MemoryR2();
    const testKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const result = await runR2Backup({
      ...env,
      BACKUPS: bucket,
      ORBIT_BACKUP_ENABLED: 'true',
      ORBIT_BACKUP_ENCRYPTION_KEY_V1: testKey,
    }, 'daily', now);
    for (let index = 0; index < 16; index += 1) {
      await bucket.put(`orbit-v6/daily/2026-06-${String(index + 1).padStart(2, '0')}-test.json.enc`, '{}');
    }
    const retention = await enforceBackupRetention(bucket);
    const runs = await env.DB.prepare(`
      SELECT status, object_key, manifest_checksum, error_code
      FROM backup_runs WHERE id = ?
    `).bind(result.runId).first();
    return Response.json({
      objectCount: bucket.objects.size,
      retention,
      run: runs,
      objectKeyIsSafe: !result.objectKey.includes('nyx') && !result.objectKey.includes('samet'),
      checksumLength: result.objectChecksum.length,
    });
  }

  if (url.pathname === '/__test/backup-restore') {
    try {
      const proof = await restoreDynamicBackup(env.DB, body.backup, {
        revokeSecurity: Boolean(body.revokeSecurity), now,
      });
      return Response.json({ ok: true, proof });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof Error ? error.message : 'restore_failed',
      }, { status: 400 });
    }
  }

  if (url.pathname === '/__test/backup-counts') {
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM accounts WHERE status = 'closed') AS closedAccounts,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM agents) AS agents,
        (SELECT COUNT(*) FROM records) AS records,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM backup_restore_validations) AS validations
    `).first();
    const fk = await env.DB.prepare(`PRAGMA foreign_key_check`).all();
    return Response.json({ counts, foreignKeyViolations: fk.results.length });
  }

  if (url.pathname === '/__test/media-objects') {
    return Response.json({ count: mediaBucket.objects.size });
  }

  if (url.pathname === '/__test/media-transform-state') {
    const month = String(body.month ?? new Date(now).toISOString().slice(0, 7));
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_assets) AS media_assets,
        (SELECT COUNT(*) FROM media_transform_claims WHERE month_utc = ?) AS claims,
        (SELECT COUNT(*) FROM media_transform_results result
          JOIN media_transform_claims claim ON claim.id = result.claim_id
          WHERE claim.month_utc = ?) AS results,
        (SELECT COUNT(*) FROM media_transform_results result
          JOIN media_transform_claims claim ON claim.id = result.claim_id
          WHERE claim.month_utc = ? AND result.status = 'failed') AS failed_results,
        COALESCE((SELECT attempted_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS attempted,
        COALESCE((SELECT succeeded_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS succeeded,
        COALESCE((SELECT failed_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS failed
    `).bind(month, month, month, month, month, month).first();
    return Response.json({ counts, objectCount: mediaBucket.objects.size });
  }

  if (url.pathname === '/__test/media-transform-limit') {
    const month = String(body.month);
    const attempted = Number(body.attempted);
    await env.DB.prepare(`
      INSERT INTO media_transform_usage_monthly (
        month_utc, attempted_count, succeeded_count, failed_count, updated_at
      ) VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(month_utc) DO UPDATE SET
        attempted_count = excluded.attempted_count,
        succeeded_count = 0,
        failed_count = 0,
        updated_at = excluded.updated_at
    `).bind(month, attempted, now).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/media-transform-tamper') {
    const claim = await env.DB.prepare(`
      SELECT id FROM media_transform_claims WHERE status = 'succeeded' LIMIT 1
    `).first<{ id: string }>();
    try {
      await env.DB.prepare(`
        UPDATE media_transform_claims
        SET status = 'failed', error_category = 'images_unknown',
            output_byte_size = NULL, completed_at = ?
        WHERE id = ?
      `).bind(now, claim?.id ?? '').run();
      return Response.json({ rejected: false });
    } catch (error) {
      return Response.json({
        rejected: true,
        code: error instanceof Error && error.message.includes('media_transform_claim_lifecycle_invalid')
          ? 'media_transform_claim_lifecycle_invalid'
          : 'unexpected_error',
      });
    }
  }

  if (url.pathname === '/__test/media-cleanup') {
    return Response.json(await cleanupMedia(
      env,
      new D1MediaRepository(env.DB),
      Number(body.now ?? now),
    ));
  }

  if (url.pathname === '/__test/cleanup') {
    return Response.json(await runIdentityCleanup(env, now));
  }

  if (url.pathname === '/__test/seed-idempotency') {
    await env.DB.prepare(`
      INSERT INTO idempotency_keys (
        id, principal_type, principal_id, key_digest, operation,
        request_digest, response_status, created_at, expires_at
      ) VALUES (?, 'account',
        '019f64d2-0109-7644-9a4e-a0d25df888e2',
        ?, 'test.cleanup', ?, 201, ?, ?)
    `).bind(
      String(body.id),
      String(body.id),
      String(body.id),
      now - 1000,
      now - 1,
    ).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const extended = { ...env, MEDIA: mediaBucket };
    const testResponse = await testRoute(request, extended);
    if (testResponse) return testResponse;
    const nowHeader = request.headers.get('x-test-now');
    return await handleWorkerRequest(request, extended, {
      fetch: mockGithubFetch,
      now: nowHeader ? () => Number(nowHeader) : undefined,
    });
  },
};
