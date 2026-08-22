/* `POST /v1/site-clients` — alt site istemcisi kaydı.
 *
 * Testler gerçek Worker'a ve gerçek D1'e karşı koşuyor. Sebebi şu: bu ucun
 * asıl iddiası "kaydettiğim istemci GERÇEKTEN giriş yapabilir" ve bunu bir
 * sahte veritabanı kanıtlayamaz.
 *
 * En belirleyici test `invalid_client` ile `invalid_grant` ayrımına bakıyor.
 * Uydurma bir kodla token ucuna gidildiğinde:
 *   - istemci kimlik doğrulaması DÜŞERSE  → `invalid_client`
 *   - istemci tanınır ama kod geçersizse  → `invalid_grant`
 * İkincisini görmek, peper'la üretilen özetin doğrulamanın beklediğiyle
 * birebir eşleştiğini kanıtlıyor. Ayrışsaydı satır yazılır ama o site bir
 * daha hiç giriş yaptıramazdı — ve sebebi hiçbir yerde görünmezdi.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { reserveWorkerPorts } from './orbit-test-ports';
import { createOpaqueToken, hmacDigest, randomBase64Url } from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.slice1-test.jsonc';
const DATABASE = 'orbit-v6-local';
const NOW = Date.parse('2026-08-22T10:00:00Z');
/* Orbit CSRF token'ının ÜSTÜNE Origin başlığını da denetliyor; başlıksız
 * istek `origin_forbidden` ile düşüyor. Tarayıcıdan gelen gerçek istekte bu
 * başlık zaten var. */
const ORIGIN = 'http://localhost:4321';

const SESSION_PEPPER = 'test-session-pepper-at-least-32-bytes-long';
const CSRF_PEPPER = 'test-csrf-pepper-at-least-32-bytes-long';

const SAHIP_ID = '019f7100-0000-7000-8000-0000000000a1';
const UYE_ID = '019f7100-0000-7000-8000-0000000000a2';

/* Haber'in gerçek bildirimi: `scripts/site-clients/haber.json` ile aynı. */
const HABER = {
  clientId: 'orbit-haber',
  label: 'Equinox Haber',
  siteUrl: 'https://haber.sametbasbug.dev',
  scopes: ['openid', 'profile'],
  redirectUris: ['https://haber.sametbasbug.dev/giris/orbit/donus'],
  environment: 'production',
};
const HABER_SIRRI = 'haber-client-secret-value-at-least-32-bytes';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let sahipCerezi = '';
let sahipCsrf = '';
let uyeCerezi = '';
let uyeCsrf = '';

function wrangler(args: string[]): void {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

async function startWorker(persist: string) {
  const { port, inspectorPort } = await reserveWorkerPorts();
  let output = '';
  const child = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`,
    `--inspector-port=${inspectorPort}`, `--persist-to=${persist}`,
  ], { cwd: ROOT, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => { output += String(c); });
  child.stderr.on('data', (c) => { output += String(c); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      if ((await fetch(`${url}/healthz`)).status === 200) return { process: child, url };
    } catch { /* port henüz bağlanmadı */ }
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

async function rolluOturum(accountId: string, handle: string, role: string) {
  const session = await createOpaqueToken('session', SESSION_PEPPER);
  const csrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${csrf}`, CSRF_PEPPER);
  assert.equal((await testPost('/__test/seed-role-session', {
    accountId, handle, role,
    roleId: `${accountId}-role`,
    sessionId: session.selector,
    secretDigest: session.digest,
    csrfDigest,
    now: NOW,
  })).status, 200);
  return {
    cerez: `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${csrf}`,
    csrf,
  };
}

async function kaydet(
  govde: Record<string, unknown>,
  kimlik?: { cerez: string; csrf: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-now': String(NOW),
  };
  if (kimlik) {
    headers.cookie = kimlik.cerez;
    headers['X-Orbit-CSRF'] = kimlik.csrf;
    headers.origin = ORIGIN;
  }
  return await fetch(`${baseUrl}/v1/site-clients`, {
    method: 'POST', headers, body: JSON.stringify(govde),
  });
}

/* Hata gövdesi `{ code, message }` biçiminde — `error` değil. */
async function hata(r: Response): Promise<{ code: string; message: string }> {
  const govde = await r.json() as any;
  /* Gövde iç içe: `{ error: { code, message } }`. */
  const ic = govde.error ?? govde;
  return { code: ic.code ?? '(kod yok)', message: ic.message ?? '' };
}

const tamGovde = (uzerine: Record<string, unknown> = {}) => ({
  ...HABER, clientSecret: HABER_SIRRI, ...uzerine,
});

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-site-client-'));
  wrangler(['d1', 'migrations', 'apply', DATABASE, '--config', CONFIG, '--local', `--persist-to=${persistDirectory}`]);
  const started = await startWorker(persistDirectory);
  worker = started.process;
  baseUrl = started.url;

  const sahip = await rolluOturum(SAHIP_ID, 'samet', 'platform_owner');
  sahipCerezi = sahip.cerez;
  sahipCsrf = sahip.csrf;
  const uye = await rolluOturum(UYE_ID, 'baskasi', 'member');
  uyeCerezi = uye.cerez;
  uyeCsrf = uye.csrf;
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

describe('Registering a site client', { concurrency: false }, () => {
  test('oturumsuz istek reddediliyor', async () => {
    const r = await kaydet(tamGovde());
    assert.equal(r.status, 401);
  });

  test('sıradan üye reddediliyor — kapı platform_owner', async () => {
    const r = await kaydet(tamGovde(), { cerez: uyeCerezi, csrf: uyeCsrf });
    const h = await hata(r);
    assert.equal(r.status, 403);
    assert.equal(h.code, 'permission_denied');
  });

  test('CSRF başlığı olmadan reddediliyor', async () => {
    const r = await fetch(`${baseUrl}/v1/site-clients`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-now': String(NOW),
        cookie: sahipCerezi,
        origin: ORIGIN,
      },
      body: JSON.stringify(tamGovde()),
    });
    assert.equal(r.status, 403);
  });

  test('kısa istemci sırrı reddediliyor', async () => {
    const r = await kaydet(tamGovde({ clientSecret: 'kisa' }), { cerez: sahipCerezi, csrf: sahipCsrf });
    const h = await hata(r);
    assert.equal(r.status, 400, h.message);
    assert.equal(h.code, 'invalid_site_client_secret');
  });

  test('openid taşımayan kapsam reddediliyor', async () => {
    const r = await kaydet(tamGovde({ scopes: ['profile'] }), { cerez: sahipCerezi, csrf: sahipCsrf });
    const h = await hata(r);
    assert.equal(r.status, 400, h.message);
    assert.match(h.message, /openid/u);
  });

  test('production istemcisine localhost adresi reddediliyor', async () => {
    const r = await kaydet(
      tamGovde({ redirectUris: ['http://localhost:4321/geri'] }),
      { cerez: sahipCerezi, csrf: sahipCsrf },
    );
    assert.equal(r.status, 400);
  });

  test('parça taşıyan yönlendirme adresi reddediliyor', async () => {
    const r = await kaydet(
      tamGovde({ redirectUris: ['https://haber.sametbasbug.dev/geri#kod'] }),
      { cerez: sahipCerezi, csrf: sahipCsrf },
    );
    assert.equal(r.status, 400);
  });

  test('platform sahibi kaydediyor ve yanıt sır taşımıyor', async () => {
    const r = await kaydet(tamGovde(), { cerez: sahipCerezi, csrf: sahipCsrf });
    const govde = await r.text();
    assert.equal(r.status, 201, `beklenmedik yanıt: ${govde}`);
    const okunan = JSON.parse(govde).siteClient;
    assert.equal(okunan.clientId, 'orbit-haber');
    assert.deepEqual(okunan.allowedScopes, ['openid', 'profile']);
    assert.deepEqual(okunan.redirectUris, HABER.redirectUris);
    assert.equal(okunan.status, 'active');
    /* Ne sır ne özet yanıtta olmalı. */
    assert.ok(!govde.includes(HABER_SIRRI), 'yanıt istemci sırrını taşıyor');
    assert.ok(!/secretDigest|secret_digest/u.test(govde), 'yanıt özet taşıyor');
  });

  test('KAYDEDİLEN İSTEMCİ TOKEN UCUNDA TANINIYOR', async () => {
    /* Uydurma kod. Beklenen `invalid_grant`: istemci kimlik doğrulamasını
     * GEÇTİ, düşen şey kod. `invalid_client` gelseydi özet ayrışmış olurdu. */
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'uydurma-kod',
      code_verifier: 'x'.repeat(43),
      redirect_uri: HABER.redirectUris[0],
    });
    const r = await fetch(`${baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-now': String(NOW),
        authorization: `Basic ${Buffer.from(`${HABER.clientId}:${HABER_SIRRI}`).toString('base64')}`,
      },
      body,
    });
    assert.equal((await hata(r)).code, 'invalid_grant');
  });

  test('YANLIŞ SIRLA aynı istek invalid_client veriyor — kontrol grubu', async () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'uydurma-kod',
      code_verifier: 'x'.repeat(43),
      redirect_uri: HABER.redirectUris[0],
    });
    const r = await fetch(`${baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-now': String(NOW),
        authorization: `Basic ${Buffer.from(`${HABER.clientId}:yanlis-sir-ama-yeterince-uzun-32-bayt`).toString('base64')}`,
      },
      body,
    });
    assert.equal((await hata(r)).code, 'invalid_client');
  });

  test('aynı client_id ikinci kez kaydedilemiyor', async () => {
    const r = await kaydet(
      tamGovde({ clientSecret: 'bambaska-bir-sir-yine-en-az-32-karakter' }),
      { cerez: sahipCerezi, csrf: sahipCsrf },
    );
    assert.equal(r.status, 409);
    assert.equal((await hata(r)).code, 'site_client_exists');
  });

  test('çakışma sonrası ilk sır HÂLÂ geçerli — üzerine yazılmadı', async () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'uydurma-kod',
      code_verifier: 'x'.repeat(43),
      redirect_uri: HABER.redirectUris[0],
    });
    const r = await fetch(`${baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-test-now': String(NOW),
        authorization: `Basic ${Buffer.from(`${HABER.clientId}:${HABER_SIRRI}`).toString('base64')}`,
      },
      body,
    });
    assert.equal((await hata(r)).code, 'invalid_grant');
  });
});
