import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  normalizeSiteAuthorizationScopes,
  parseSiteAuthorizationScopes,
  scopesNeedConsent,
  scopesWithinLimit,
  serializeSiteAuthorizationScopes,
} from '../src/server/identity/site-authorization-scopes';
import {
  createOpaqueToken,
  parseOpaqueToken,
  verifyOpaqueToken,
} from '../src/server/identity/tokens';
import {
  importSiteSigningKey,
  signSiteIdToken,
  siteDiscoveryDocument,
  siteJwks,
} from '../src/server/identity/site-id-token';
import { SITE_AUTHORIZATION_SCOPES } from '../src/server/identity/site-authorization-scopes';
import {
  createSiteAuthorizationRequestTicket,
  verifySiteAuthorizationRequestTicket,
} from '../src/server/identity/site-authorization-request';
import { siteConsentPage } from '../src/server/http/site-consent-page';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.test.jsonc';

const CLIENT = {
  id: 'client-anime',
  clientId: 'orbit-anime-site',
  label: 'Anime sitesi',
  siteUrl: 'https://anime.sametbasbug.dev',
  allowedScopes: 'openid profile email orbit.graph.read orbit.posts.read',
  environment: 'production',
  redirectUris: ['https://anime.sametbasbug.dev/auth/v1/callback'],
};

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let migrationOutput = '';

function runMigrations(): string {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER,
      'd1',
      'migrations',
      'apply',
      'orbit-v6-local',
      '--config',
      CONFIG,
      '--local',
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Migration command failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
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

async function waitForWorker(process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  let output = '';
  process.stdout.on('data', (chunk) => { output += String(chunk); });
  process.stderr.on('data', (chunk) => { output += String(chunk); });
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready:\n${output}`);
    }
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'health' }),
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not bound the local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler did not become ready within 20 seconds:\n${output}`);
}

async function callAction<T>(
  action: string,
  data: Record<string, unknown> = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
  const body = await response.json() as T;
  assert.equal(
    response.status,
    expectedStatus,
    `${action} returned ${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}

interface GrantView {
  id: string;
  clientId: string;
  clientLabel: string;
  accountId: string;
  scopes: string[];
  consentVersion: string;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

interface StateView {
  tokens: Array<{
    id: string;
    token_type: string;
    replaced_by_id: string | null;
    used_at: number | null;
    revoked_at: number | null;
    revoked_reason: string | null;
  }>;
  codes: Array<{ id: string; consumed_at: number | null }>;
  events: string[];
}

/* İmza testleri için bir anahtar. Üretim anahtarı gibi JSON Web Key biçiminde
 * ama teste özel: `scripts/orbit-oidc-key.mjs`'in ürettiğiyle aynı yapı. */
async function generateSigningKeySecret(kid = 'orbit-oidc-test'): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid });
}

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

async function verifyIdTokenSignature(
  token: string,
  publicJwk: Record<string, string>,
): Promise<boolean> {
  const [header, payload, signature] = token.split('.');
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...publicJwk, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(
    Buffer.from(signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64'),
  );
  return await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

async function seedClientAndAccount(accountId: string, now: number): Promise<void> {
  await callAction('seedAccount', { accountId, now });
  await callAction('seedSiteClient', { ...CLIENT, now }, 201);
}

async function consent(input: {
  prefix: string;
  accountId: string;
  now: number;
  scopes?: string[];
  redirectUri?: string;
  nonce?: string | null;
}): Promise<GrantView> {
  const body = await callAction<{ grant: GrantView }>('recordSiteConsent', {
    grantId: `${input.prefix}-grant`,
    clientId: CLIENT.id,
    accountId: input.accountId,
    scopes: input.scopes ?? ['openid', 'profile', 'email'],
    consentVersion: '2026-08-12',
    codeId: `${input.prefix}-code`,
    codeDigest: `${input.prefix}-code-digest`,
    redirectUri: input.redirectUri ?? CLIENT.redirectUris[0],
    pkceChallenge: 'a'.repeat(43),
    nonce: input.nonce === undefined ? `${input.prefix}-nonce-value` : input.nonce,
    codeExpiresAt: input.now + 60 * 1000,
    auditEventId: `${input.prefix}-consent-audit`,
    requestId: `${input.prefix}-consent-request`,
    now: input.now,
  }, 201);
  return body.grant;
}

async function issueTokens(input: {
  prefix: string;
  grantId: string;
  now: number;
  replacesRefreshTokenId?: string | null;
  suffix?: string;
}): Promise<{ accessId: string; refreshId: string; accessDigest: string; refreshDigest: string }> {
  const suffix = input.suffix ?? '1';
  const identifiers = {
    accessId: `${input.prefix}-access-${suffix}`,
    refreshId: `${input.prefix}-refresh-${suffix}`,
    accessDigest: `${input.prefix}-access-digest-${suffix}`,
    refreshDigest: `${input.prefix}-refresh-digest-${suffix}`,
  };
  await callAction('issueSiteTokens', {
    grantId: input.grantId,
    ...identifiers,
    accessExpiresAt: input.now + 15 * 60 * 1000,
    refreshExpiresAt: input.now + 30 * 24 * 60 * 60 * 1000,
    replacesRefreshTokenId: input.replacesRefreshTokenId ?? null,
    auditEventId: `${input.prefix}-tokens-audit-${suffix}`,
    requestId: `${input.prefix}-tokens-request-${suffix}`,
    now: input.now,
  }, 201);
  return identifiers;
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-site-auth-d1-'));
  migrationOutput = runMigrations();
  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(
    process.execPath,
    [
      WRANGLER,
      'dev',
      '--config',
      CONFIG,
      '--local',
      `--port=${port}`,
      `--inspector-port=${inspectorPort}`,
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  await waitForWorker(worker);
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
  if (persistDirectory) {
    await rm(persistDirectory, { recursive: true, force: true });
  }
});

describe('Orbit as a sign-in door for other sites', { concurrency: false }, () => {
  test('migration and the three site token families are available', async () => {
    assert.match(migrationOutput, /0041_orbit_becomes_a_door_for_other_sites\.sql/u);

    for (const [family, pattern] of [
      ['site_code', /^orb_scode_v1_/u],
      ['site_access', /^orb_site_v1_/u],
      ['site_refresh', /^orb_srefr_v1_/u],
    ] as const) {
      const generated = await createOpaqueToken(family, 'test-site-pepper');
      assert.match(generated.token, pattern);
      assert.equal(parseOpaqueToken(generated.token)?.family, family);
      assert.equal(
        (await verifyOpaqueToken(generated.token, family, generated.digest, 'test-site-pepper'))
          ?.selector,
        generated.selector,
      );
    }

    /* Aileler ayrı olduğu için bir cinsin anahtarı başka cins olarak
     * doğrulanamıyor: digest ailenin adını da kapsıyor. */
    const access = await createOpaqueToken('site_access', 'test-site-pepper');
    assert.equal(
      await verifyOpaqueToken(access.token, 'site_refresh', access.digest, 'test-site-pepper'),
      null,
    );
  });

  test('scope rules keep the private surfaces out of reach', () => {
    assert.deepEqual(
      normalizeSiteAuthorizationScopes(['email', 'openid', 'profile', 'email']),
      ['openid', 'profile', 'email'],
    );
    assert.equal(
      serializeSiteAuthorizationScopes(['orbit.posts.read', 'openid']),
      'openid orbit.posts.read',
    );
    assert.deepEqual(parseSiteAuthorizationScopes('openid email'), ['openid', 'email']);

    /* Takip AKIŞI, mesajlar ve yazma yetkisi hiçbir kapsamda yok — istenirse
     * kapsam listesi bunu tanımıyor ve istek reddediliyor. */
    for (const unknown of ['orbit.following.read', 'orbit.messages.read', 'orbit.posts.write']) {
      assert.throws(
        () => normalizeSiteAuthorizationScopes(['openid', unknown]),
        /site_authorization_scope_unknown/u,
      );
    }
    assert.throws(
      () => normalizeSiteAuthorizationScopes(['profile']),
      /site_authorization_scope_missing_openid/u,
    );
    assert.throws(
      () => parseSiteAuthorizationScopes('profile openid'),
      /site_authorization_scope_not_canonical/u,
    );

    assert.equal(scopesWithinLimit(['openid', 'email'], ['openid', 'profile', 'email']), true);
    assert.equal(scopesWithinLimit(['openid', 'orbit.posts.read'], ['openid', 'email']), false);
    assert.equal(scopesNeedConsent(['openid'], ['openid', 'email']), false);
    assert.equal(scopesNeedConsent(['openid', 'email'], ['openid']), true);
  });

  test('a registered client exposes only its exact redirect URIs', async () => {
    const now = 1_760_000_000_000;
    await seedClientAndAccount('door-one', now);

    const body = await callAction<{ client: {
      id: string;
      label: string;
      allowedScopes: string[];
      redirectUris: string[];
      status: string;
    } | null }>('getSiteClient', { clientId: CLIENT.clientId });
    assert.equal(body.client?.label, 'Anime sitesi');
    assert.deepEqual(body.client?.allowedScopes, [
      'openid', 'profile', 'email', 'orbit.graph.read', 'orbit.posts.read',
    ]);
    assert.deepEqual(body.client?.redirectUris, CLIENT.redirectUris);

    const missing = await callAction<{ client: unknown }>('getSiteClient', {
      clientId: 'orbit-not-registered',
    });
    assert.equal(missing.client, null);
  });

  test('a production client cannot register an insecure redirect URI', async () => {
    const now = 1_760_000_100_000;
    /* Açık yönlendiricinin ilk kapısı: şema. Production istemcisine http
     * adres yazılamıyor ve bu kural tetikleyicide, uygulama katmanında
     * değil. */
    const rejected = await callAction<{ error: string }>('seedSiteClient', {
      ...CLIENT,
      id: 'client-insecure',
      clientId: 'orbit-insecure-site',
      redirectUris: ['http://anime.example.com/callback'],
      now,
    }, 409);
    assert.match(rejected.error, /oauth_redirect_uri_insecure/u);

    /* Aynı adres development istemcisinde de reddediliyor: izin yalnız
     * localhost için var. */
    const rejectedRemote = await callAction<{ error: string }>('seedSiteClient', {
      ...CLIENT,
      id: 'client-dev-remote',
      clientId: 'orbit-dev-remote',
      environment: 'development',
      redirectUris: ['http://anime.example.com/callback'],
      now,
    }, 409);
    assert.match(rejectedRemote.error, /oauth_redirect_uri_insecure/u);

    await callAction('seedSiteClient', {
      ...CLIENT,
      id: 'client-dev-local',
      clientId: 'orbit-dev-local',
      environment: 'development',
      siteUrl: 'http://localhost:4322',
      redirectUris: ['http://localhost:4322/auth/callback'],
      now,
    }, 201);
  });

  test('consent records the grant, the code carries the nonce, and the code is single use', async () => {
    const now = 1_760_000_200_000;
    const accountId = 'door-two';
    await seedClientAndAccount(accountId, now);
    const grant = await consent({ prefix: 'single-use', accountId, now });

    assert.deepEqual(grant.scopes, ['openid', 'profile', 'email']);
    assert.equal(grant.consentVersion, '2026-08-12');
    assert.equal(grant.revokedAt, null);

    const stored = await callAction<{ code: {
      id: string;
      grantId: string;
      nonce: string | null;
      redirectUri: string;
      consumedAt: number | null;
    } | null }>('getSiteCode', { codeDigest: 'single-use-code-digest' });
    assert.equal(stored.code?.grantId, grant.id);
    assert.equal(stored.code?.nonce, 'single-use-nonce-value');
    assert.equal(stored.code?.redirectUri, CLIENT.redirectUris[0]);
    assert.equal(stored.code?.consumedAt, null);

    const first = await callAction<{ consumed: boolean }>('consumeSiteCode', {
      codeId: 'single-use-code',
      now: now + 1_000,
    });
    assert.equal(first.consumed, true);

    const second = await callAction<{ consumed: boolean }>('consumeSiteCode', {
      codeId: 'single-use-code',
      now: now + 2_000,
    });
    assert.equal(second.consumed, false, 'a code must not be redeemable twice');
  });

  test('an expired code cannot be consumed', async () => {
    const now = 1_760_000_300_000;
    const accountId = 'door-three';
    await seedClientAndAccount(accountId, now);
    await consent({ prefix: 'expired', accountId, now });

    const consumed = await callAction<{ consumed: boolean }>('consumeSiteCode', {
      codeId: 'expired-code',
      now: now + 61 * 1_000,
    });
    assert.equal(consumed.consumed, false);
  });

  test('the subject is per client and stable across logins', async () => {
    const now = 1_760_000_400_000;
    const accountId = 'door-four';
    await seedClientAndAccount(accountId, now);

    const first = await callAction<{ subject: string }>('ensureSiteSubject', {
      id: 'subject-row-one',
      clientId: CLIENT.id,
      accountId,
      subject: 'subject-anime-door-four',
      now,
    });
    /* İkinci giriş yeni kimlik üretmiyor: aynı insan aynı sitede aynı kişi
     * kalıyor, `accounts.id` hiç dışarı çıkmadan. */
    const second = await callAction<{ subject: string }>('ensureSiteSubject', {
      id: 'subject-row-two',
      clientId: CLIENT.id,
      accountId,
      subject: 'subject-would-be-different',
      now: now + 5_000,
    });
    assert.equal(second.subject, first.subject);
    assert.equal(first.subject, 'subject-anime-door-four');
    assert.notEqual(first.subject, accountId);
  });

  test('tokens resolve with the account and client state attached', async () => {
    const now = 1_760_000_500_000;
    const accountId = 'door-five';
    await seedClientAndAccount(accountId, now);
    const grant = await consent({ prefix: 'resolve', accountId, now });
    await callAction('ensureSiteSubject', {
      id: 'subject-row-five',
      clientId: CLIENT.id,
      accountId,
      subject: 'subject-anime-door-five',
      now,
    });
    const issued = await issueTokens({ prefix: 'resolve', grantId: grant.id, now });

    const resolved = await callAction<{ resolution: {
      token: { id: string; tokenType: string };
      grant: { id: string; lastUsedAt: number | null };
      accountStatus: string;
      clientStatus: string;
      subject: string;
    } | null }>('resolveSiteToken', {
      secretDigest: issued.accessDigest,
      tokenType: 'access',
    });
    assert.equal(resolved.resolution?.token.id, issued.accessId);
    assert.equal(resolved.resolution?.accountStatus, 'active');
    assert.equal(resolved.resolution?.clientStatus, 'active');
    assert.equal(resolved.resolution?.subject, 'subject-anime-door-five');
    assert.equal(resolved.resolution?.grant.lastUsedAt, now);

    /* Erişim anahtarı yenileme anahtarı olarak sunulamıyor: cins sorgunun
     * içinde. */
    const wrongType = await callAction<{ resolution: unknown }>('resolveSiteToken', {
      secretDigest: issued.accessDigest,
      tokenType: 'refresh',
    });
    assert.equal(wrongType.resolution, null);
  });

  test('a suspended account is visible on the token that was already issued', async () => {
    const now = 1_760_000_600_000;
    const accountId = 'door-six';
    await seedClientAndAccount(accountId, now);
    const grant = await consent({ prefix: 'suspend', accountId, now });
    await callAction('ensureSiteSubject', {
      id: 'subject-row-six',
      clientId: CLIENT.id,
      accountId,
      subject: 'subject-anime-door-six',
      now,
    });
    const issued = await issueTokens({ prefix: 'suspend', grantId: grant.id, now });

    await callAction('setAccountStatus', { accountId, status: 'suspended', now: now + 1_000 });

    /* Anahtar satırı hâlâ duruyor — askıya alma anahtarları silmiyor. Ama
     * çözümleme hesabın durumunu birlikte getiriyor, yani yenilemeyi reddedecek
     * uç tek okumada karar verebiliyor. İkinci bir sorgu olsaydı arada hesabın
     * askıya alınabileceği bir aralık kalırdı. */
    const resolved = await callAction<{ resolution: { accountStatus: string } | null }>(
      'resolveSiteToken',
      { secretDigest: issued.refreshDigest, tokenType: 'refresh' },
    );
    assert.equal(resolved.resolution?.accountStatus, 'suspended');
  });

  test('a refresh token rotates once and a replay burns the whole grant', async () => {
    const now = 1_760_000_700_000;
    const accountId = 'door-seven';
    await seedClientAndAccount(accountId, now);
    const grant = await consent({ prefix: 'rotate', accountId, now });
    const first = await issueTokens({ prefix: 'rotate', grantId: grant.id, now });

    const marked = await callAction<{ marked: boolean }>('markSiteRefreshUsed', {
      tokenId: first.refreshId,
      now: now + 1_000,
    });
    assert.equal(marked.marked, true);

    /* Aynı yenileme anahtarının ikinci kullanımı: elimizde iki kopya olduğunu
     * biliyoruz, hangisinin saldırganda olduğunu bilmiyoruz. */
    const replay = await callAction<{ marked: boolean }>('markSiteRefreshUsed', {
      tokenId: first.refreshId,
      now: now + 2_000,
    });
    assert.equal(replay.marked, false);

    const second = await issueTokens({
      prefix: 'rotate',
      grantId: grant.id,
      now: now + 1_000,
      replacesRefreshTokenId: first.refreshId,
      suffix: '2',
    });

    const afterRotation = await callAction<StateView>('siteAuthorizationState', {
      grantId: grant.id,
    });
    const oldRefresh = afterRotation.tokens.find((row) => row.id === first.refreshId);
    assert.equal(oldRefresh?.replaced_by_id, second.refreshId);
    assert.equal(oldRefresh?.revoked_reason, 'rotated');
    assert.ok(afterRotation.events.includes('site.tokens_rotated'));

    const revoked = await callAction<{ revoked: number }>('revokeSiteGrantTokens', {
      grantId: grant.id,
      reason: 'refresh_token_replayed',
      auditEventId: 'rotate-replay-audit',
      requestId: 'rotate-replay-request',
      now: now + 3_000,
    });
    /* Kalan üç anahtar (ilk erişim, ikinci erişim, ikinci yenileme) birlikte
     * düşüyor; eski yenileme anahtarı rotasyonda zaten iptal olmuştu. */
    assert.equal(revoked.revoked, 3);

    const afterReplay = await callAction<StateView>('siteAuthorizationState', {
      grantId: grant.id,
    });
    assert.equal(afterReplay.tokens.filter((row) => row.revoked_at === null).length, 0);
  });

  test('revoking a grant kills its tokens and unredeemed codes in one step', async () => {
    const now = 1_760_000_800_000;
    const accountId = 'door-eight';
    await seedClientAndAccount(accountId, now);
    const grant = await consent({ prefix: 'revoke', accountId, now });
    await issueTokens({ prefix: 'revoke', grantId: grant.id, now });

    await callAction('revokeSiteGrant', {
      grantId: grant.id,
      actorAccountId: accountId,
      reason: 'disconnected_by_owner',
      auditEventId: 'revoke-grant-audit',
      requestId: 'revoke-grant-request',
      now: now + 1_000,
    });

    const state = await callAction<StateView>('siteAuthorizationState', { grantId: grant.id });
    assert.equal(state.tokens.filter((row) => row.revoked_at === null).length, 0);
    assert.equal(
      state.codes.filter((row) => row.consumed_at === null).length,
      0,
      'a code still sitting in a browser must not survive the revocation',
    );
    assert.ok(state.events.includes('site.grant_revoked'));

    const grants = await callAction<{ grants: GrantView[] }>('listSiteGrants', { accountId });
    assert.equal(grants.grants.length, 1);
    assert.equal(grants.grants[0]?.revokedReason, 'disconnected_by_owner');

    /* İptal edilmiş izne yeni kod yazılamıyor. */
    const blocked = await callAction<{ error: string }>('recordSiteConsent', {
      grantId: `${grant.id}`,
      clientId: CLIENT.id,
      accountId,
      scopes: ['openid'],
      consentVersion: '2026-08-12',
      codeId: 'revoke-code-after',
      codeDigest: 'revoke-code-after-digest',
      redirectUri: CLIENT.redirectUris[0],
      pkceChallenge: 'b'.repeat(43),
      nonce: null,
      codeExpiresAt: now + 60 * 1000,
      auditEventId: 'revoke-after-audit',
      requestId: 'revoke-after-request',
      now: now + 2_000,
    }, 201);
    /* Yeniden onay izni diriltiyor — kullanıcı bağlantıyı kestiği bir siteye
     * geri dönebilmeli. Diriltmeyen bir tasarım, iptali kalıcı bir yasağa
     * çevirirdi. */
    assert.equal((blocked as unknown as { grant: GrantView }).grant.revokedAt, null);
  });

  test('a revoked client cannot receive a new grant', async () => {
    const now = 1_760_000_900_000;
    const accountId = 'door-nine';
    await seedClientAndAccount(accountId, now);
    await callAction('setSiteClientStatus', {
      id: CLIENT.id,
      status: 'revoked',
      revokedAt: now + 1_000,
    });

    const rejected = await callAction<{ error: string }>('recordSiteConsent', {
      grantId: 'client-revoked-grant',
      clientId: CLIENT.id,
      accountId,
      scopes: ['openid'],
      consentVersion: '2026-08-12',
      codeId: 'client-revoked-code',
      codeDigest: 'client-revoked-code-digest',
      redirectUri: CLIENT.redirectUris[0],
      pkceChallenge: 'c'.repeat(43),
      nonce: null,
      codeExpiresAt: now + 60 * 1000,
      auditEventId: 'client-revoked-audit',
      requestId: 'client-revoked-request',
      now: now + 2_000,
    }, 409);
    assert.match(rejected.error, /oauth_grant_client_inactive/u);

    await callAction('setSiteClientStatus', { id: CLIENT.id, status: 'active' });
  });

  test('a suspended account cannot receive a new grant', async () => {
    const now = 1_760_001_000_000;
    const accountId = 'door-ten';
    await seedClientAndAccount(accountId, now);
    await callAction('setAccountStatus', { accountId, status: 'suspended', now });

    const rejected = await callAction<{ error: string }>('recordSiteConsent', {
      grantId: 'account-suspended-grant',
      clientId: CLIENT.id,
      accountId,
      scopes: ['openid'],
      consentVersion: '2026-08-12',
      codeId: 'account-suspended-code',
      codeDigest: 'account-suspended-code-digest',
      redirectUri: CLIENT.redirectUris[0],
      pkceChallenge: 'd'.repeat(43),
      nonce: null,
      codeExpiresAt: now + 60 * 1000,
      auditEventId: 'account-suspended-audit',
      requestId: 'account-suspended-request',
      now: now + 1_000,
    }, 409);
    assert.match(rejected.error, /oauth_grant_account_inactive/u);
  });

  test('a second login refreshes the same grant instead of opening another', async () => {
    const now = 1_760_001_100_000;
    const accountId = 'door-eleven';
    await seedClientAndAccount(accountId, now);
    const first = await consent({ prefix: 'again-one', accountId, now });
    const second = await consent({
      prefix: 'again-two',
      accountId,
      now: now + 60_000,
      scopes: ['openid', 'profile', 'email', 'orbit.graph.read'],
    });

    assert.equal(second.id, first.id, 'client + account must hold exactly one grant');
    assert.deepEqual(second.scopes, ['openid', 'profile', 'email', 'orbit.graph.read']);

    const grants = await callAction<{ grants: GrantView[] }>('listSiteGrants', { accountId });
    assert.equal(grants.grants.length, 1);
  });

  test('the ID token verifies against the published JWKS and carries the nonce', async () => {
    const secret = await generateSigningKeySecret('orbit-oidc-2026-08-12');
    const key = await importSiteSigningKey(secret);
    const issuedAt = 1_760_002_000_000;

    const token = await signSiteIdToken(key, {
      issuer: 'https://orbit.sametbasbug.dev',
      subject: 'subject-anime-door-thirteen',
      audience: 'orbit-anime-site',
      issuedAt,
      expiresAt: issuedAt + 15 * 60 * 1000,
      nonce: 'supabase-sent-this-nonce',
      name: 'Samet',
      preferredUsername: 'samet',
      picture: 'https://orbit.sametbasbug.dev/avatar.webp',
      email: 'samet@example.com',
      emailVerified: true,
    });

    const [headerSegment, payloadSegment] = token.split('.');
    const header = decodeSegment(headerSegment);
    assert.equal(header.alg, 'ES256');
    /* `kid` olmadan doğrulayan taraf hangi anahtarı deneyeceğini bilemez ve
     * Supabase bunu şart koşuyor. */
    assert.equal(header.kid, 'orbit-oidc-2026-08-12');

    const payload = decodeSegment(payloadSegment);
    assert.equal(payload.iss, 'https://orbit.sametbasbug.dev');
    assert.equal(payload.aud, 'orbit-anime-site');
    assert.equal(payload.sub, 'subject-anime-door-thirteen');
    assert.equal(payload.nonce, 'supabase-sent-this-nonce');
    assert.equal(payload.email_verified, true);
    /* Saniye cinsinden — milisaniye yazsak token 50 bin yıl yaşardı. */
    assert.equal(payload.iat, Math.floor(issuedAt / 1000));
    assert.equal(payload.exp, Math.floor((issuedAt + 15 * 60 * 1000) / 1000));

    const jwks = siteJwks([key]);
    assert.equal(jwks.keys.length, 1);
    /* Özel alan JWKS'e sızmıyor. Bu satır bir yazım kontrolü değil: `d`
     * yayınlanırsa imzayı herkes taklit eder. */
    assert.equal((jwks.keys[0] as Record<string, unknown>).d, undefined);
    assert.equal(jwks.keys[0]?.kid, 'orbit-oidc-2026-08-12');

    assert.equal(await verifyIdTokenSignature(token, jwks.keys[0]), true);

    /* Gövdesi değiştirilmiş token doğrulamayı geçmiyor. */
    const tampered = [
      headerSegment,
      Buffer.from(JSON.stringify({ ...payload, sub: 'someone-else' }))
        .toString('base64url'),
      token.split('.')[2],
    ].join('.');
    assert.equal(await verifyIdTokenSignature(tampered, jwks.keys[0]), false);

    /* Başka bir anahtarla imzalanmış token da geçmiyor — JWKS'teki anahtar
     * gerçekten imzalayanı bağlıyor. */
    const otherKey = await importSiteSigningKey(await generateSigningKeySecret('other'));
    const otherToken = await signSiteIdToken(otherKey, {
      issuer: 'https://orbit.sametbasbug.dev',
      subject: 'subject-anime-door-thirteen',
      audience: 'orbit-anime-site',
      issuedAt,
      expiresAt: issuedAt + 60_000,
      nonce: null,
    });
    assert.equal(await verifyIdTokenSignature(otherToken, jwks.keys[0]), false);
  });

  test('a token without profile scopes leaks no profile claims', async () => {
    const key = await importSiteSigningKey(await generateSigningKeySecret());
    const issuedAt = 1_760_002_100_000;
    const token = await signSiteIdToken(key, {
      issuer: 'https://orbit.sametbasbug.dev',
      subject: 'subject-minimal',
      audience: 'orbit-anime-site',
      issuedAt,
      expiresAt: issuedAt + 60_000,
      nonce: null,
    });
    const payload = decodeSegment(token.split('.')[1]);
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
    /* İstemci nonce göndermediyse claim hiç yazılmıyor — boş bir `nonce`
     * alanı, doğrulayan tarafta "gönderilmiş ama boş" ile karışırdı. */
    assert.equal('nonce' in payload, false);
  });

  test('a malformed signing key is rejected instead of being guessed at', async () => {
    await assert.rejects(
      () => importSiteSigningKey('not json'),
      /site_signing_key_not_json/u,
    );
    await assert.rejects(
      () => importSiteSigningKey(JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' })),
      /site_signing_key_missing:d/u,
    );
    const rsa = JSON.parse(await generateSigningKeySecret()) as Record<string, string>;
    await assert.rejects(
      () => importSiteSigningKey(JSON.stringify({ ...rsa, kty: 'RSA' })),
      /site_signing_key_unsupported_kty/u,
    );
    await assert.rejects(
      () => importSiteSigningKey(JSON.stringify({ ...rsa, crv: 'P-384' })),
      /site_signing_key_unsupported_curve/u,
    );
    /* `kid`siz anahtar da reddediliyor: anahtar değişimi ona bağlı. */
    const withoutKid = { ...rsa };
    delete withoutKid.kid;
    await assert.rejects(
      () => importSiteSigningKey(JSON.stringify(withoutKid)),
      /site_signing_key_missing:kid/u,
    );
  });

  test('the discovery document describes what Supabase needs to find', () => {
    const document = siteDiscoveryDocument(
      'https://orbit.sametbasbug.dev',
      SITE_AUTHORIZATION_SCOPES,
    );
    assert.equal(document.issuer, 'https://orbit.sametbasbug.dev');
    assert.equal(document.jwks_uri, 'https://orbit.sametbasbug.dev/.well-known/jwks.json');
    assert.equal(
      document.authorization_endpoint,
      'https://orbit.sametbasbug.dev/v1/oauth/authorize',
    );
    assert.deepEqual(document.id_token_signing_alg_values_supported, ['ES256']);
    /* Simetrik imza hiç sunulmuyor: Supabase kabul etmiyor ve her istemciye
     * kendi sırrımızı vermek demekti. */
    assert.equal(document.id_token_signing_alg_values_supported.includes('HS256'), false);
    /* Ortak (public) kimlik sunulmuyor; her site farklı bir `sub` görüyor. */
    assert.deepEqual(document.subject_types_supported, ['pairwise']);
    assert.deepEqual(document.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(document.scopes_supported, [
      'openid', 'profile', 'email', 'orbit.graph.read', 'orbit.posts.read',
    ]);
    assert.equal(document.scopes_supported.some((scope) => scope.endsWith('.write')), false);
  });

  test('the consent ticket binds what the screen showed', async () => {
    const pepper = 'test-oauth-pepper-at-least-32-bytes-long';
    const issuedAt = 1_760_003_000_000;
    const request = {
      clientRowId: CLIENT.id,
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0],
      scopes: ['openid', 'email'] as const,
      state: 'supabase-state-value',
      codeChallenge: 'e'.repeat(43),
      nonce: 'supabase-nonce',
      issuedAt,
      expiresAt: issuedAt + 10 * 60 * 1000,
    };

    const ticket = await createSiteAuthorizationRequestTicket({ ...request, scopes: [...request.scopes] }, pepper);
    const verified = await verifySiteAuthorizationRequestTicket(ticket, pepper, issuedAt + 1_000);
    assert.deepEqual(verified?.scopes, ['openid', 'email']);
    assert.equal(verified?.redirectUri, CLIENT.redirectUris[0]);
    assert.equal(verified?.state, 'supabase-state-value');

    /* Asıl mesele bu: gövdedeki kapsamı büyütmek. Ekranda "e-postan" yazarken
     * kaydedilen iznin gönderilerini de kapsaması, imza olmadan mümkün olurdu. */
    const [prefix, payload, signature] = ticket.split('.');
    const widened = Buffer.from(JSON.stringify({
      ...request,
      scopes: ['openid', 'email', 'orbit.posts.read'],
    })).toString('base64url');
    assert.equal(
      await verifySiteAuthorizationRequestTicket(
        `${prefix}.${widened}.${signature}`,
        pepper,
        issuedAt + 1_000,
      ),
      null,
      'a widened scope list must not survive the signature',
    );

    assert.equal(
      await verifySiteAuthorizationRequestTicket(ticket, 'another-pepper-at-least-32-bytes-long', issuedAt),
      null,
    );
    assert.equal(
      await verifySiteAuthorizationRequestTicket(ticket, pepper, issuedAt + 11 * 60 * 1000),
      null,
      'an expired ticket must not be accepted',
    );
    assert.equal(await verifySiteAuthorizationRequestTicket(`${prefix}.${payload}`, pepper, issuedAt), null);
  });

  test('the consent screen names what is shared and what is not', async () => {
    const response = siteConsentPage({
      clientLabel: 'Anime sitesi',
      clientSiteUrl: 'https://anime.sametbasbug.dev',
      scopes: ['openid', 'profile', 'email'],
      accountHandle: 'samet',
      accountDisplayName: 'Samet Başbuğ',
      ticket: 'orb_site_req_v1.payload.signature',
      csrfToken: 'csrf-value',
      cancelUrl: 'https://anime.sametbasbug.dev/auth/v1/callback?error=access_denied',
    });
    const html = await response.text();

    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    /* Sayfada script yok ve CSP bunu kalıcı kılıyor; iframe'e alınamıyor. */
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
    assert.equal(/<script/iu.test(html), false);

    assert.match(html, /E-posta adresin/u);
    /* E-postanın geri alınamazlığı ekranda yazılı: kararın bedeli onay
     * anında görünmeli, sonradan değil. */
    assert.match(html, /o kopya sitede kalır/u);
    /* Verilmeyenler listesi — takip akışı burada, çünkü kapsam listesinde
     * bilerek yok. */
    assert.match(html, /takip akışın/u);
    assert.match(html, /Mesajların/u);
    /* İstenmeyen kapsamın metni sayfaya hiç girmiyor. */
    assert.equal(html.includes('Herkese açık gönderilerin'), false);
    assert.match(html, /@samet/u);
  });

  test('a hostile client label cannot inject markup into the consent screen', async () => {
    const response = siteConsentPage({
      clientLabel: '<img src=x onerror="alert(1)">Anime',
      clientSiteUrl: 'https://anime.example/"><script>alert(2)</script>',
      scopes: ['openid'],
      accountHandle: 'samet',
      accountDisplayName: 'Samet',
      ticket: 'orb_site_req_v1.a.b',
      csrfToken: 'csrf',
      cancelUrl: 'https://anime.example/cb',
    });
    const html = await response.text();
    /* İstemci adı operatör eliyle giriliyor, yani bugün güvenilir. Kaçış yine
     * var: "bize güvenilir veri" varsayımı, o veriyi başka bir yerden alan bir
     * yol yazıldığı gün sessizce yanlış olur. */
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>alert(2)'), false);
    assert.match(html, /&lt;img src=x/u);
  });

  test('expired codes are removed by retention', async () => {
    const now = 1_760_001_200_000;
    const accountId = 'door-twelve';
    await seedClientAndAccount(accountId, now);
    await consent({ prefix: 'retention', accountId, now });

    const deleted = await callAction<{ deleted: number }>('deleteExpiredSiteCodes', {
      now: now + 120 * 1_000,
    });
    assert.ok(deleted.deleted >= 1);
    const gone = await callAction<{ code: unknown }>('getSiteCode', {
      codeDigest: 'retention-code-digest',
    });
    assert.equal(gone.code, null);
  });
});
