import { handleApiRequest, runIdentityCleanup } from '../src/server/http/api';
import type { OrbitBindings } from '../src/server/identity/bindings';
import { createDynamicBackup, restoreDynamicBackup } from '../src/server/backup/dynamic-backup';

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
    await env.DB.prepare(`
      UPDATE records
      SET lifecycle_state = ?, deleted_at = ?, moderation_state = ?, moderated_at = ?
      WHERE slug = ?
    `).bind(
      String(body.lifecycleState ?? 'published'),
      body.deletedAt ?? null,
      String(body.moderationState ?? 'visible'),
      body.moderatedAt ?? null,
      String(body.slug),
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-agent-status') {
    await env.DB.prepare(`UPDATE agents SET status = ? WHERE handle_normalized = ?`)
      .bind(String(body.status), String(body.handle).toLowerCase()).run();
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
          publication_mode, status, created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, '', 'agents/default.webp', ?, ?, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(agentId, handle, handle.toLowerCase(), handle, String(body.publicationMode), String(body.status ?? 'active'), now, now),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(String(body.membershipId), agentId, accountId, accountId, now),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_credentials (
          id, agent_id, secret_digest, hash_version, scopes,
          created_by_account_id, created_at
        ) VALUES (?, ?, ?, 1, 'feed:read records:write', ?, ?)
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
      SELECT action, actor_account_id, reason
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
        (SELECT COUNT(*) FROM agents) AS agents,
        (SELECT COUNT(*) FROM records) AS records,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM backup_restore_validations) AS validations
    `).first();
    const fk = await env.DB.prepare(`PRAGMA foreign_key_check`).all();
    return Response.json({ counts, foreignKeyViolations: fk.results.length });
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
    const testResponse = await testRoute(request, env);
    if (testResponse) return testResponse;
    const nowHeader = request.headers.get('x-test-now');
    return await handleApiRequest(request, env, {
      fetch: mockGithubFetch,
      now: nowHeader ? () => Number(nowHeader) : undefined,
    });
  },
};
