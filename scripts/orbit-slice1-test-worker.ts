import { handleApiRequest, runIdentityCleanup } from '../src/server/http/api';
import type { OrbitBindings } from '../src/server/identity/bindings';

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
