/**
 * "Orbit ile devam et" akışının uçtan uca provası (Plan 008).
 *
 * Bu dosya parçaları değil YOLU sınıyor: gerçek worker, gerçek D1, gerçek
 * çerezler. Şema ve imza testleri ayrı dosyada (orbit-site-authorization-tests)
 * ve orada geçen her şey burada da geçmek zorunda değil — burada ölçülen şey
 * uçların birbirine gerçekten bağlı olduğu.
 *
 * Neden ayrı bir dosya: bu akış tarayıcı yönlendirmeleri üzerinden yürüyor ve
 * testin `redirect: 'manual'` ile her sıçramayı tek tek okuması gerekiyor.
 * Mevcut slice1 testlerinin içine karışsaydı, bir yönlendirmenin kaybolduğu
 * hata başka bir testin arızası gibi görünürdü.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createOpaqueToken,
  hmacDigest,
  randomBase64Url,
  sha256Base64Url,
} from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.slice1-test.jsonc';
const DATABASE = 'orbit-v6-local';
const ORIGIN = 'http://localhost:4321';
const NOW = Date.parse('2026-08-12T10:00:00Z');

const SESSION_PEPPER = 'test-session-pepper-at-least-32-bytes-long';
const CSRF_PEPPER = 'test-csrf-pepper-at-least-32-bytes-long';
const SITE_TOKEN_PEPPER = 'test-site-token-pepper-at-least-32-bytes-long';

/* Gerçek istemci: Equinox Rota. Adı ve adresi gerçek, sırrı teste özel. */
const CLIENT_ID = 'orbit-equinox-rota';
const CLIENT_ROW_ID = '019f7000-0000-7000-8000-000000000001';
const CLIENT_SECRET = 'rota-client-secret-value-at-least-32-bytes';
const CLIENT_LABEL = 'Equinox Rota';
const REDIRECT_URI = 'https://anime.sametbasbug.dev/auth/v1/callback';
const OTHER_REDIRECT_URI = 'https://anime.sametbasbug.dev/auth/v1/second';

const ACCOUNT_ID = '019f7000-0000-7000-8000-0000000000a1';
const ACCOUNT_HANDLE = 'samet';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let sessionCookie = '';
let csrfToken = '';

function wrangler(args: string[]): void {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local test port.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startWorker(persist: string): Promise<{
  process: ChildProcessWithoutNullStreams;
  url: string;
}> {
  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  let output = '';
  const child = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`,
    `--inspector-port=${inspectorPort}`, `--persist-to=${persist}`,
  ], { cwd: ROOT, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      if ((await fetch(`${url}/healthz`)).status === 200) return { process: child, url };
    } catch {
      // Port not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler timeout:\n${output}`);
}

async function testPost(pathname: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
    body: JSON.stringify(body),
  });
}

/* Yönlendirmeler elle okunuyor: akışın tamamı 302'lerden oluşuyor ve nereye
 * gittiği testin asıl konusu. */
async function authorize(
  query: Record<string, string>,
  options: { cookie?: string | null; now?: number } = {},
): Promise<Response> {
  const url = new URL('/v1/oauth/authorize', baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { 'x-test-now': String(options.now ?? NOW) };
  const cookie = options.cookie === undefined ? sessionCookie : options.cookie;
  if (cookie) headers.cookie = cookie;
  return await fetch(url, { headers, redirect: 'manual' });
}

function authorizeQuery(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    state: 'rota-state-value',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    nonce: 'rota-nonce-value',
    ...overrides,
  };
}

async function consent(
  ticket: string,
  decision: string,
  options: { cookie?: string; csrf?: string; now?: number } = {},
): Promise<Response> {
  const body = new URLSearchParams({
    ticket,
    csrf: options.csrf ?? csrfToken,
    decision,
  });
  return await fetch(`${baseUrl}/v1/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie: options.cookie ?? sessionCookie,
      'x-test-now': String(options.now ?? NOW),
    },
    body: body.toString(),
  });
}

async function tokenRequest(
  fields: Record<string, string>,
  options: { basic?: boolean; now?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-test-now': String(options.now ?? NOW),
  };
  if (options.basic) {
    headers.authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  } else {
    body.set('client_id', CLIENT_ID);
    body.set('client_secret', CLIENT_SECRET);
  }
  const response = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function ticketFromConsentPage(html: string): string {
  const match = /name="ticket" value="([^"]+)"/u.exec(html);
  assert.ok(match, 'the consent screen must carry a signed ticket');
  return match[1];
}

function locationOf(response: Response): URL {
  const location = response.headers.get('location');
  assert.ok(location, `expected a redirect, got ${response.status}`);
  return new URL(location);
}

const VERIFIER = 'rota-code-verifier-value-that-is-long-enough-000';
let CHALLENGE = '';

before(async () => {
  CHALLENGE = await sha256Base64Url(VERIFIER);
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-site-signin-'));
  wrangler(['d1', 'migrations', 'apply', DATABASE, '--config', CONFIG, '--local', `--persist-to=${persistDirectory}`]);
  const started = await startWorker(persistDirectory);
  worker = started.process;
  baseUrl = started.url;

  assert.equal((await testPost('/__test/seed-account', {
    accountId: ACCOUNT_ID,
    handle: ACCOUNT_HANDLE,
    displayName: 'Samet Başbuğ',
    now: NOW,
  })).status, 200);
  /* Doğrulanmış adres: `email` kapsamının kaynağı bu satır. */
  assert.equal((await testPost('/__test/seed-provider-identity', {
    identityId: '019f7000-0000-7000-8000-0000000000b1',
    accountId: ACCOUNT_ID,
    provider: 'google',
    providerUserId: 'google-samet',
    providerLogin: 'samet@example.test',
    providerEmail: 'samet@example.test',
    now: NOW,
  })).status, 200);

  const session = await createOpaqueToken('session', SESSION_PEPPER);
  csrfToken = randomBase64Url(32);
  const csrfDigest = await hmacDigest(
    `orbit:csrf:v1:${session.selector}:${csrfToken}`,
    CSRF_PEPPER,
  );
  assert.equal((await testPost('/__test/seed-human-session', {
    sessionId: session.selector,
    secretDigest: session.digest,
    csrfDigest,
    accountId: ACCOUNT_ID,
    now: NOW,
  })).status, 200);
  sessionCookie = `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${csrfToken}`;

  assert.equal((await testPost('/__test/seed-site-client', {
    id: CLIENT_ROW_ID,
    clientId: CLIENT_ID,
    secretDigest: await hmacDigest(
      `orbit:site-client-secret:v1:${CLIENT_SECRET}`,
      SITE_TOKEN_PEPPER,
    ),
    label: CLIENT_LABEL,
    siteUrl: 'https://anime.sametbasbug.dev',
    allowedScopes: 'openid profile email orbit.graph.read',
    environment: 'production',
    redirectUris: [REDIRECT_URI, OTHER_REDIRECT_URI],
    now: NOW,
  })).status, 200);
});

after(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => worker?.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  if (persistDirectory) await rm(persistDirectory, { recursive: true, force: true });
});

describe('Signing in to another Equinox site with Orbit', { concurrency: false }, () => {
  test('the discovery document and JWKS are served from the well-known paths', async () => {
    /* Supabase bu iki adresi kökte arıyor ve issuer bir yol taşıyamıyor —
     * yolun `/v1` altında olması yetmez. */
    const discovery = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    const document = await discovery.json() as Record<string, unknown>;
    assert.equal(document.issuer, ORIGIN);
    assert.equal(document.authorization_endpoint, `${ORIGIN}/v1/oauth/authorize`);
    assert.equal(document.jwks_uri, `${ORIGIN}/.well-known/jwks.json`);

    const jwks = await fetch(`${baseUrl}/.well-known/jwks.json`);
    assert.equal(jwks.status, 200);
    const keys = await jwks.json() as { keys: Array<Record<string, unknown>> };
    assert.equal(keys.keys[0]?.kid, 'orbit-oidc-test');
    assert.equal(keys.keys[0]?.alg, 'ES256');
    /* Özel yarı hiçbir koşulda yayınlanmıyor. */
    assert.equal(keys.keys[0]?.d, undefined);
  });

  test('a full sign-in: consent screen, code, tokens, userinfo', async () => {
    const screen = await authorize(authorizeQuery());
    assert.equal(screen.status, 200);
    const html = await screen.text();
    /* Ekranda sitenin gerçek adı, ve virgülle Orbit'ten ayrılmış hâli. */
    assert.match(html, /Equinox Rota, Orbit hesabınla devam etmek istiyor/u);
    assert.match(html, /@samet/u);
    /* İstenmeyen kapsamın metni ekranda yok. */
    assert.equal(html.includes('Kimi takip ettiğin'), false);

    const redirect = await consent(ticketFromConsentPage(html), 'allow');
    assert.equal(redirect.status, 302);
    const target = locationOf(redirect);
    assert.equal(`${target.origin}${target.pathname}`, REDIRECT_URI);
    assert.equal(target.searchParams.get('state'), 'rota-state-value');
    const code = target.searchParams.get('code') ?? '';
    assert.ok(code.startsWith('orb_scode_v1_'));

    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(tokens.status, 200);
    assert.equal(tokens.body.token_type, 'Bearer');
    assert.equal(tokens.body.expires_in, 900);
    assert.equal(tokens.body.scope, 'openid profile email');
    assert.ok(String(tokens.body.access_token).startsWith('orb_site_v1_'));
    assert.ok(String(tokens.body.refresh_token).startsWith('orb_srefr_v1_'));

    /* ID token: nonce birebir iade ediliyor (Supabase bunu doğruluyor) ve
     * `sub` hesap kimliği DEĞİL. */
    const payload = JSON.parse(
      Buffer.from(String(tokens.body.id_token).split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(payload.iss, ORIGIN);
    assert.equal(payload.aud, CLIENT_ID);
    assert.equal(payload.nonce, 'rota-nonce-value');
    assert.equal(payload.preferred_username, ACCOUNT_HANDLE);
    assert.equal(payload.email, 'samet@example.test');
    assert.equal(payload.email_verified, true);
    assert.notEqual(payload.sub, ACCOUNT_ID);

    const header = JSON.parse(
      Buffer.from(String(tokens.body.id_token).split('.')[0], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(header.kid, 'orbit-oidc-test');

    const userinfo = await fetch(`${baseUrl}/v1/oauth/userinfo`, {
      headers: {
        authorization: `Bearer ${String(tokens.body.access_token)}`,
        'x-test-now': String(NOW),
      },
    });
    assert.equal(userinfo.status, 200);
    const profile = await userinfo.json() as Record<string, unknown>;
    /* İki uç aynı kullanıcı için aynı kimliği ve aynı alan adlarını
     * kullanıyor; ayrışsalar istemci hangisine güveneceğini bilemezdi. */
    assert.equal(profile.sub, payload.sub);
    assert.equal(profile.email, 'samet@example.test');
    assert.equal(profile.preferred_username, ACCOUNT_HANDLE);
  });

  test('a second sign-in skips the screen but the grant stays one row', async () => {
    const silent = await authorize(authorizeQuery());
    assert.equal(silent.status, 302, 'an unchanged scope must not ask again');
    const code = locationOf(silent).searchParams.get('code');
    assert.ok(code);

    const state = await testPost('/__test/site-grant-state', { clientId: CLIENT_ID });
    const { grants } = await state.json() as {
      grants: Array<{ scopes: string; consent_version: string; revoked_at: number | null }>;
    };
    assert.equal(grants.length, 1, 'client + account must hold exactly one grant');
    assert.equal(grants[0]?.scopes, 'openid profile email');
  });

  test('a widened scope asks again instead of granting silently', async () => {
    const widened = await authorize(authorizeQuery({
      scope: 'openid profile email orbit.graph.read',
    }));
    assert.equal(widened.status, 200, 'a new scope must return to the consent screen');
    const html = await widened.text();
    assert.match(html, /Kimi takip ettiğin/u);
  });

  test('a scope the client is not allowed to ask for is refused, not trimmed', async () => {
    const refused = await authorize(authorizeQuery({
      scope: 'openid orbit.posts.read',
    }));
    assert.equal(refused.status, 302);
    assert.equal(locationOf(refused).searchParams.get('error'), 'invalid_scope');
  });

  test('an unknown client or redirect URI never redirects anywhere', async () => {
    const unknownClient = await authorize(authorizeQuery({ client_id: 'orbit-not-registered' }));
    assert.equal(unknownClient.status, 400);
    assert.equal(unknownClient.headers.get('location'), null);
    assert.match(await unknownClient.text(), /Orbit’e bağlı değil/u);

    /* Asıl mesele bu: listede olmayan adrese hata bile göndermiyoruz. Aksi
     * hâlde uç, saldırganın seçtiği adrese parametre taşıyan bir araç olurdu. */
    const badRedirect = await authorize(authorizeQuery({
      redirect_uri: 'https://saldirgan.example/callback',
    }));
    assert.equal(badRedirect.status, 400);
    assert.equal(badRedirect.headers.get('location'), null);
    assert.match(await badRedirect.text(), /Geri dönüş adresi tanınmıyor/u);
  });

  test('a signed-out visitor is parked and resumed after signing in', async () => {
    const parked = await authorize(authorizeQuery(), { cookie: null });
    assert.equal(parked.status, 302);
    assert.equal(locationOf(parked).pathname, '/dashboard');
    const setCookie = parked.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /__Host-orbit_site_return=/u);
    assert.match(setCookie, /HttpOnly/u);

    /* Bilet çerezden okunuyor: adres satırında hiçbir parametre yok, yani
     * girişten sonra nereye dönüleceği kullanıcının yazabildiği bir yerde
     * durmuyor. */
    const ticket = /__Host-orbit_site_return=([^;]+)/u.exec(setCookie)?.[1] ?? '';
    assert.ok(ticket.length > 0);
    const resumed = await fetch(new URL('/v1/oauth/authorize?resume=1', baseUrl), {
      redirect: 'manual',
      headers: {
        cookie: `${sessionCookie}; __Host-orbit_site_return=${ticket}`,
        'x-test-now': String(NOW),
      },
    });
    /* İzin zaten verilmiş olduğu için doğrudan kod dönüyor. */
    assert.equal(resumed.status, 302);
    const target = locationOf(resumed);
    assert.equal(`${target.origin}${target.pathname}`, REDIRECT_URI);
    assert.ok(target.searchParams.get('code'));
  });

  test('saying no sends access_denied and writes no code', async () => {
    const widened = await authorize(authorizeQuery({
      scope: 'openid profile email orbit.graph.read',
      state: 'deny-state',
    }));
    const denied = await consent(ticketFromConsentPage(await widened.text()), 'deny');
    assert.equal(denied.status, 302);
    const target = locationOf(denied);
    assert.equal(target.searchParams.get('error'), 'access_denied');
    assert.equal(target.searchParams.get('state'), 'deny-state');
    assert.equal(target.searchParams.get('code'), null);
  });

  test('consent without the session CSRF value is rejected', async () => {
    const screen = await authorize(authorizeQuery({
      scope: 'openid profile email orbit.graph.read',
    }));
    const ticket = ticketFromConsentPage(await screen.text());
    const forged = await consent(ticket, 'allow', { csrf: randomBase64Url(32) });
    assert.equal(forged.status, 403);
  });

  test('a code cannot be exchanged twice, and the replay burns the tokens', async () => {
    const granted = await authorize(authorizeQuery({ state: 'replay-state' }));
    const code = locationOf(granted).searchParams.get('code') ?? '';

    const first = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    }, { basic: true });
    assert.equal(first.status, 200, 'Basic client authentication must work too');

    const replay = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(replay.status, 400);

    /* Tekrar kullanım yalnız reddedilmiyor: o izne ait bütün anahtarlar
     * düşüyor, çünkü kodun iki kopyası olduğunu biliyoruz ama hangisinin
     * saldırganda olduğunu bilmiyoruz. */
    const state = await testPost('/__test/site-grant-state', { clientId: CLIENT_ID });
    const { grants } = await state.json() as { grants: Array<{ live_tokens: number }> };
    assert.equal(grants[0]?.live_tokens, 0);
  });

  test('the PKCE verifier and the redirect URI are both checked', async () => {
    const granted = await authorize(authorizeQuery({ state: 'pkce-state' }));
    const code = locationOf(granted).searchParams.get('code') ?? '';

    const wrongVerifier = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'another-verifier-value-that-is-long-enough-0000',
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(wrongVerifier.status, 400);

    /* Kod hâlâ yakılmadı: yanlış doğrulayıcı kodu harcamıyor. */
    const wrongRedirect = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: OTHER_REDIRECT_URI,
    });
    assert.equal(wrongRedirect.status, 400, 'the code belongs to the address it was issued for');

    const correct = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(correct.status, 200);
  });

  test('a wrong client secret gets nothing', async () => {
    const granted = await authorize(authorizeQuery({ state: 'secret-state' }));
    const code = locationOf(granted).searchParams.get('code') ?? '';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: 'wrong-secret-value',
    });
    const response = await fetch(`${baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-now': String(NOW),
      },
      body: body.toString(),
    });
    assert.equal(response.status, 401);
  });

  test('the refresh token rotates once and a replay burns the grant', async () => {
    const granted = await authorize(authorizeQuery({ state: 'refresh-state' }));
    const code = locationOf(granted).searchParams.get('code') ?? '';
    const first = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    });
    const refreshToken = String(first.body.refresh_token);

    const rotated = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }, { now: NOW + 60_000 });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refresh_token, refreshToken);
    /* Yenilemede nonce yok: nonce o tek girişe ait. */
    const rotatedPayload = JSON.parse(
      Buffer.from(String(rotated.body.id_token).split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal('nonce' in rotatedPayload, false);

    const replay = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }, { now: NOW + 120_000 });
    assert.equal(replay.status, 400);

    const newToken = String(rotated.body.refresh_token);
    const afterBurn = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: newToken,
    }, { now: NOW + 180_000 });
    assert.equal(afterBurn.status, 400, 'the replay must burn the rotated token too');
  });

  test('suspending the account stops the refresh and the userinfo read', async () => {
    const granted = await authorize(authorizeQuery({ state: 'suspend-state' }));
    const code = locationOf(granted).searchParams.get('code') ?? '';
    const issued = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(issued.status, 200);

    assert.equal((await testPost('/__test/set-site-account-status', {
      accountId: ACCOUNT_ID,
      status: 'suspended',
    })).status, 200);

    /* Askıya almanın alt siteye yayıldığı iki kapı. Erişim anahtarı hâlâ
     * elinde ama artık hiçbir şey okuyamıyor, ve yenileme de reddediliyor —
     * yani oturum en çok erişim anahtarının ömrü kadar yaşıyor. */
    const userinfo = await fetch(`${baseUrl}/v1/oauth/userinfo`, {
      headers: {
        authorization: `Bearer ${String(issued.body.access_token)}`,
        'x-test-now': String(NOW + 60_000),
      },
    });
    assert.equal(userinfo.status, 401);

    const refreshed = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: String(issued.body.refresh_token),
    }, { now: NOW + 60_000 });
    assert.equal(refreshed.status, 400);

    assert.equal((await testPost('/__test/set-site-account-status', {
      accountId: ACCOUNT_ID,
      status: 'active',
    })).status, 200);
  });
});
