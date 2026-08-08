import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  DEFAULT_AGENT_QUOTA,
  OAUTH_COOKIE,
  REGISTRATION_IP_MAX,
  SESSION_ACTIVITY_BUCKET_MS,
  SESSION_COOKIE,
} from '../src/server/identity/constants';
import {
  createOpaqueToken,
  parseOpaqueToken,
} from '../src/server/identity/tokens';
import { LEGAL_LAST_UPDATED } from '../src/data/legal';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.slice1-test.jsonc';
const ORIGIN = 'http://localhost:4321';
const NOW = 1_784_103_600_000;
const MCP_SERVICE_SECRET = 'test-mcp-service-secret-at-least-32-bytes-long';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;

function migrate(): void {
  const result = spawnSync(process.execPath, [
    WRANGLER,
    'd1',
    'migrations',
    'apply',
    'orbit-v6-local',
    '--config',
    CONFIG,
    '--local',
    `--persist-to=${persistDirectory}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

/* Giriş izinin HTTP yüzeyi yok ve olmaması bilinçli: IP'leri web'e açan bir
 * uç, bir yetkilendirme hatasında sızdırılacak yüzey demek. Kayıt hukuki
 * talep geldiğinde elle sorgulanıyor — testin de aynı yoldan bakması,
 * gerçekte kullanılacak yolu doğrulaması anlamına geliyor. */
function queryDatabase<T>(sql: string): T[] {
  const result = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'execute', 'orbit-v6-local',
    '--config', CONFIG, '--local', `--persist-to=${persistDirectory}`,
    '--json', '--command', sql,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('['))) as Array<{ results: T[] }>;
  return payload[0]?.results ?? [];
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('port_unavailable'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForWorker(process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  let output = '';
  process.stdout.on('data', (chunk) => { output += String(chunk); });
  process.stderr.on('data', (chunk) => { output += String(chunk); });
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/v1/missing`);
      if (response.status === 404) return;
    } catch {
      // Worker is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler timeout:\n${output}`);
}

async function request(
  pathname: string,
  init: RequestInit = {},
  now = NOW,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-test-now', String(now));
  return await fetch(`${baseUrl}${pathname}`, { ...init, headers, redirect: 'manual' });
}

async function postJson(
  pathname: string,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
  now = NOW,
): Promise<Response> {
  const combined = new Headers(headers);
  combined.set('content-type', 'application/json');
  return await request(pathname, {
    method: 'POST',
    headers: combined,
    body: JSON.stringify(body),
  }, now);
}

async function patchJson(
  pathname: string,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
  now = NOW,
): Promise<Response> {
  const combined = new Headers(headers);
  combined.set('content-type', 'application/json');
  return await request(pathname, {
    method: 'PATCH',
    headers: combined,
    body: JSON.stringify(body),
  }, now);
}

function setCookieLines(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = response.headers.get('set-cookie');
  return value ? value.split(/,(?=\s*__Host-)/u) : [];
}

function cookieValues(response: Response): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of setCookieLines(response)) {
    const pair = line.split(';', 1)[0];
    const index = pair.indexOf('=');
    values.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1)));
  }
  return values;
}

function cookieHeader(values: Map<string, string>, names?: string[]): string {
  return [...values.entries()]
    .filter(([name]) => !names || names.includes(name))
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

/* Her akış artık onayla başlıyor. Onaysız bir akış hiç kurulmuyor, o yüzden
 * bunu varsayılan yapmak testleri gerçeğe yaklaştırıyor; onayın YOKLUĞUNU
 * ölçen testler /v1/auth/github/start'ı kendileri çağırıyor. */
async function startOAuth(
  now = NOW,
): Promise<{ state: string; oauthCookie: string }> {
  const response = await postJson('/v1/auth/github/start', {
    acceptedTerms: true,
    termsVersion: LEGAL_LAST_UPDATED,
  }, { origin: ORIGIN }, now);
  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as { authorizationUrl: string };
  const state = new URL(body.authorizationUrl).searchParams.get('state');
  const oauthCookie = cookieValues(response).get(OAUTH_COOKIE);
  assert.ok(state);
  assert.ok(oauthCookie);
  return { state, oauthCookie };
}

let callbackCount = 0;

async function callback(
  code: 'owner' | 'selene' | 'mismatch' | 'renameBefore' | 'renameAfter'
    | 'traced' | 'tracedUnverified' | 'tracedNoreply' | `crowd-${number}`,
  flow: { state: string; oauthCookie: string },
  now = NOW + 1,
  ip?: string,
  openRegistration?: 'true' | 'false',
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: `${OAUTH_COOKIE}=${encodeURIComponent(flow.oauthCookie)}`,
  };
  if (openRegistration) headers['x-test-open-registration'] = openRegistration;
  /* Cloudflare bu başlığı kenarda kendisi yazar; testte onun yerine
   * geçiyoruz.
   *
   * Varsayılan HER ÇAĞRIDA FARKLI bir adres, çünkü gerçekte farklı insanlar
   * farklı bağlantılardan geliyor. Eskiden başlık hiç yazılmıyordu ve o
   * hâlin "izsiz giriş" olduğunu sanıyordum; ölçünce görüldü ki yerel
   * wrangler başlığı kendisi 127.0.0.1 olarak dolduruyor. Yani bütün test
   * paketi tek bir bağlantıdan kayıt oluyormuş gibi görünüyordu ve kayıt
   * hız tavanı geldiğinde alakasız testler düşmeye başladı. Tavanı gevşetmek
   * yerine kurgu düzeltildi: paketin gerçeğe benzemesi gerekiyordu. */
  headers['cf-connecting-ip'] = ip ?? `198.18.${Math.floor(callbackCount / 250) % 250}.${callbackCount++ % 250}`;
  return await request(`/v1/auth/github/callback?code=${code}&state=${encodeURIComponent(flow.state)}`, {
    headers,
  }, now);
}

function authenticatedHeaders(cookies: Map<string, string>, csrf = false): Headers {
  const headers = new Headers({ cookie: cookieHeader(cookies) });
  if (csrf) {
    headers.set('origin', ORIGIN);
    headers.set(CSRF_HEADER, cookies.get(CSRF_COOKIE) ?? '');
  }
  return headers;
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice1-'));
  migrate();
  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [
    WRANGLER,
    'dev',
    '--config',
    CONFIG,
    '--local',
    `--port=${port}`,
    `--inspector-port=${inspectorPort}`,
    `--persist-to=${persistDirectory}`,
  ], {
    cwd: ROOT,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  await rm(persistDirectory, { recursive: true, force: true });
});

describe('Orbit V6 Slice 1–2 identity and agent-management HTTP core', { concurrency: false }, () => {
  let ownerCookies = new Map<string, string>();
  let sponsorCookies = new Map<string, string>();
  let otherSponsorCookies = new Map<string, string>();
  let sponsoredAgentId = '';
let firstCredentialId = '';
let firstCredentialToken = '';
  let replacementCredentialId = '';
  let recoveredCredentialId = '';
  let sponsoredAgentEtag = '';
  let mcpGrantId = '';
  let mcpDelegationCode = '';
  const mcpAuthorizationRequestId = 'chatgpt-authorization-request-001';

  async function createAuthorizedMcpGrant(options: {
    requestId: string;
    now: number;
    agentId?: string;
    cookies?: Map<string, string>;
  }): Promise<{
    grantId: string;
    delegationCode: string;
    scopes: string[];
  }> {
    const ticketResponse = await postJson(
      '/v1/mcp/authorization-tickets',
      {
        authorizationRequestId: options.requestId,
        oauthClientId: `chatgpt-${options.requestId}`,
        oauthClientLabel: 'ChatGPT',
        scopes: ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
        scopeBundleVersion: 2,
      },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      options.now,
    );
    assert.equal(ticketResponse.status, 201, await ticketResponse.clone().text());
    const ticketBody = await ticketResponse.json() as { ticket: string };

    const created = await postJson(
      '/v1/mcp/authorizations',
      {
        agentId: options.agentId ?? sponsoredAgentId,
        ticket: ticketBody.ticket,
      },
      authenticatedHeaders(options.cookies ?? sponsorCookies, true),
      options.now + 1,
    );
    assert.equal(created.status, 201, await created.clone().text());
    const body = await created.json() as {
      authorization: { id: string; scopes: string[] };
      delegation: { code: string };
    };
    assert.deepEqual(
      body.authorization.scopes,
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
    );
    return {
      grantId: body.authorization.id,
      delegationCode: body.delegation.code,
      scopes: body.authorization.scopes,
    };
  }

  test('token families use a 128-bit selector and 256-bit secret', async () => {
    for (const family of ['session', 'agent', 'registration', 'delegation'] as const) {
      const generated = await createOpaqueToken(family, `${family}-pepper-at-least-32-random-bytes`);
      const parsed = parseOpaqueToken(generated.token);
      assert.equal(parsed?.family, family);
      assert.equal(parsed?.selector.length, 22);
      assert.equal(parsed?.secret.length, 43);
      assert.equal(generated.digest.length, 43);
    }
  });

  test('platform owner seed is authorized by immutable GitHub numeric ID', async () => {
    const flow = await startOAuth();
    const response = await callback('owner', flow);
    assert.equal(response.status, 302, await response.clone().text());
    ownerCookies = cookieValues(response);
    assert.ok(ownerCookies.get(SESSION_COOKIE)?.startsWith('orb_sess_v1_'));
    assert.equal(ownerCookies.get(CSRF_COOKIE)?.length, 43);

    const me = await request('/v1/me', { headers: authenticatedHeaders(ownerCookies) }, NOW + 2);
    assert.equal(me.status, 200, await me.clone().text());
    const body = await me.json() as { account: { handle: string; roles: string[]; agentQuota: number } };
    assert.equal(body.account.handle, 'sametbasbug');
    assert.deepEqual(body.account.roles, ['platform_owner']);
    assert.equal(body.account.agentQuota, -1);

    const replay = await callback('owner', flow, NOW + 3);
    assert.equal(replay.status, 400);
  });

  /* Kayıt artık davetsiz. Eskiden burada bir davet üretilir, o davetle
     kayıt olunur ve davetin listede sızmadığı ölçülürdü. Davet emekliye
     ayrıldı; ölçülmesi gereken şey değişti: GitHub hesabı olan biri kendi
     başına kayıt olabiliyor mu, doğru rolü ve ajan hakkını alıyor mu, ve
     ikinci girişinde aynı hesaba mı düşüyor. */
  test('anyone with a GitHub account registers themselves, lands as a member, and returns to the same account', async () => {
    const registration = await callback('selene', await startOAuth(NOW + 12), NOW + 13);
    assert.equal(registration.status, 302, await registration.clone().text());
    sponsorCookies = cookieValues(registration);
    const me = await request('/v1/me', {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 14);
    const sponsor = await me.json() as { account: { id: string; handle: string; roles: string[]; agentQuota: number } };
    assert.equal(sponsor.account.handle, 'selene-owner');
    assert.deepEqual(sponsor.account.roles, ['member'], 'kendi kaydolan biri fazladan yetki almış');
    assert.equal(sponsor.account.agentQuota, DEFAULT_AGENT_QUOTA);

    const replay = await callback('selene', await startOAuth(NOW + 15), NOW + 16);
    assert.equal(replay.status, 302, 'dönen kullanıcı tekrar giremiyor');
    const again = await (await request('/v1/me', {
      headers: authenticatedHeaders(cookieValues(replay)),
    }, NOW + 17)).json() as { account: { id: string } };
    assert.equal(again.account.id, sponsor.account.id, 'ikinci giriş ikinci bir hesap açmış');
  });

  test('a GitHub rename reaches the dashboard on the next login', async () => {
    /* GitHub kullanıcı adı değişebilir; kimlik numarası değişmez. Hesap
     * kayıt anındaki adı `accounts.handle` içinde saklıyor ve orası bir daha
     * değişmiyor — değişemez de, benzersizlik kısıtı var ve o alan Orbit'in
     * kendi tanımlayıcısı. Dashboard bir zamanlar onu "GitHub hesabın" diye
     * gösteriyordu, bu yüzden yeniden adlandırma hiç görünmüyordu.
     * Gösterilmesi gereken, her girişte tazelenen `githubLogin`. */

    const registration = await callback('renameBefore', await startOAuth(NOW + 61), NOW + 62);
    assert.equal(registration.status, 302, await registration.clone().text());
    const firstCookies = cookieValues(registration);
    const before = await (await request('/v1/me', {
      headers: authenticatedHeaders(firstCookies),
    }, NOW + 63)).json() as { account: { id: string; handle: string; githubLogin: string | null } };
    assert.equal(before.account.handle, 'eski-kullanici');
    assert.equal(before.account.githubLogin, 'eski-kullanici');

    // İnsan GitHub'da adını değiştirdi ve tekrar giriş yaptı.
    const relogin = await callback('renameAfter', await startOAuth(NOW + 64), NOW + 65);
    assert.equal(relogin.status, 302, await relogin.clone().text());
    const secondCookies = cookieValues(relogin);
    const after = await (await request('/v1/me', {
      headers: authenticatedHeaders(secondCookies),
    }, NOW + 66)).json() as {
      account: { id: string; handle: string; githubLogin: string | null; displayName: string };
    };

    // Yeni bir hesap açılmadı: aynı GitHub kimlik numarası aynı hesaba düştü.
    assert.equal(after.account.id, before.account.id);
    assert.equal(after.account.githubLogin, 'yeni-kullanici', 'dashboard yeni GitHub adını göstermiyor');
    assert.equal(after.account.displayName, 'Yeni Kullanıcı');
    // Orbit'in kendi tanımlayıcısı kasten sabit kalır: benzersizlik kısıtı
    // taşıyor ve her girişte yeniden yazmak girişi çökertme riski demek.
    assert.equal(after.account.handle, 'eski-kullanici');
  });

  test('every human sign-in leaves a connection trace, and the first one is marked as registration', async () => {
    /* Bu izin tek amacı, hukuki bir talepte hesabı gerçek bir aboneye
     * bağlayabilmek. Yalnız kayıt anını tutmak yetmezdi: CGNAT arkasındaki
     * tek gözlem aboneyi daraltmayabilir ve Cloudflare bize kaynak portu
     * vermiyor. Cevap çokluk — o yüzden burada iki ayrı giriş ölçülüyor. */

    const registration = await callback(
      'traced',
      await startOAuth(NOW + 201),
      NOW + 202,
      '203.0.113.7',
    );
    assert.equal(registration.status, 302, await registration.clone().text());

    const relogin = await callback('traced', await startOAuth(NOW + 203), NOW + 204, '198.51.100.22');
    assert.equal(relogin.status, 302, await relogin.clone().text());

    const rows = queryDatabase<{ event_type: string; ip: string | null; created_at: number }>(`
      SELECT e.event_type, e.ip, e.created_at
      FROM account_sign_in_events e
      JOIN auth_identities i ON i.account_id = e.account_id
      WHERE i.provider_user_id = '200000004'
      ORDER BY e.created_at ASC
    `);

    assert.equal(rows.length, 2, 'her giriş iz bırakmıyor');
    assert.equal(rows[0].event_type, 'registration', 'ilk giriş kayıt olarak işaretlenmemiş');
    assert.equal(rows[0].ip, '203.0.113.7', 'kayıt anındaki IP saklanmamış');
    assert.equal(rows[1].event_type, 'sign_in');
    assert.equal(rows[1].ip, '198.51.100.22', 'sonraki girişin IP\'si saklanmamış');
  });

  test('the trace records the human who signs in, never the agent that publishes', async () => {
    /* Ajanın yayın isteğinde görülecek IP, ajanın çalıştığı veri merkezini
     * gösterir — sorumlu insanı değil. O yüzden yazma yolunda iz hiç
     * okunmuyor. Bu test o sınırın yerinde durduğunu ölçüyor: ajan bir
     * istek yapıyor ve ortada yeni bir giriş izi oluşmuyor. */
    const before = queryDatabase<{ total: number }>(
      'SELECT COUNT(*) AS total FROM account_sign_in_events',
    )[0].total;
    /* Boş tabloda "sayı değişmedi" demek hiçbir şey ölçmez; testin
     * kendisinin boşa geçmediğini burada kelepçeliyoruz. */
    assert.ok(before > 0, 'iz tablosu boş: bu test hiçbir şey ölçmüyor');

    const agentCall = await request('/v1/agent/profile', {
      headers: new Headers({
        authorization: 'Bearer orb_agent_v1_gecersiz',
        'cf-connecting-ip': '203.0.113.250',
      }),
    }, NOW + 210);
    assert.equal(agentCall.status, 401, 'test varsayımı kaydı: bu çağrı reddedilmeliydi');

    const after = queryDatabase<{ total: number }>(
      'SELECT COUNT(*) AS total FROM account_sign_in_events',
    )[0].total;
    assert.equal(after, before, 'ajanın API isteği giriş izi yazmış');
  });

  test('GitHub email is stored only when verified, and a later sign-in without one keeps it', async () => {
    /* Adres yalnız hizmet bildirimi için: hesap, güvenlik, moderasyon,
     * yasal bildirim ve platform duyurusu. Doğrulanmamış bir adrese yazmak
     * başkasının kutusuna yazmak riskini taşıdığı için verified şartı var. */
    const unverified = await callback(
      'tracedUnverified',
      await startOAuth(NOW + 221),
      NOW + 222,
    );
    assert.equal(unverified.status, 302, await unverified.clone().text());

    const stored = queryDatabase<{ provider_user_id: string; provider_email_snapshot: string | null }>(`
      SELECT provider_user_id, provider_email_snapshot FROM auth_identities
      WHERE provider_user_id IN ('200000004', '200000005')
    `);
    const traced = stored.find((row) => row.provider_user_id === '200000004');
    const withoutEmail = stored.find((row) => row.provider_user_id === '200000005');

    assert.equal(traced?.provider_email_snapshot, 'izli@example.test', 'doğrulanmış birincil adres saklanmamış');
    assert.equal(
      withoutEmail?.provider_email_snapshot,
      null,
      'doğrulanmamış adres saklanmış; o kutuya bildirim göndermek başkasına yazmak olurdu',
    );

    /* Adres alınamayan bir giriş, elimizdeki adresi silmemeli: aksi hâlde
     * tek bir izinsiz giriş, güvenlik bildirimi gönderebileceğimiz tek
     * kanalı sessizce yok ederdi. Owner profilinin adresi var, ama
     * `mismatch` profilinin hiç yok — burada ölçülen, izli hesabın
     * adresinin ikinci girişten sonra da yerinde durması. */
    const relogin = await callback('traced', await startOAuth(NOW + 223), NOW + 224);
    assert.equal(relogin.status, 302);
    const afterRelogin = queryDatabase<{ provider_email_snapshot: string | null }>(
      "SELECT provider_email_snapshot FROM auth_identities WHERE provider_user_id = '200000004'",
    );
    assert.equal(afterRelogin[0]?.provider_email_snapshot, 'izli@example.test');
  });

  test('a GitHub noreply address is never stored, even when it is the verified primary', async () => {
    /* "E-posta adresimi gizli tut" açık olan kullanıcıda listedeki
     * @users.noreply.github.com adresi hem birincil hem doğrulanmış
     * görünür. GitHub o adrese posta teslim etmez: saklarsak elimizde
     * ulaşabildiğimizi sandığımız ama ulaşamadığımız bir adres olur ve
     * geri dönen her gönderim, gerçek adresi olan kullanıcılara ulaşma
     * ihtimalimizi de düşürür. */
    const registration = await callback(
      'tracedNoreply',
      await startOAuth(NOW + 231),
      NOW + 232,
    );
    assert.equal(registration.status, 302, await registration.clone().text());

    const stored = queryDatabase<{ provider_email_snapshot: string | null }>(
      "SELECT provider_email_snapshot FROM auth_identities WHERE provider_user_id = '200000006'",
    );
    assert.equal(
      stored[0]?.provider_email_snapshot,
      'gercek@example.test',
      'noreply adresi saklanmış ya da gerçek doğrulanmış adrese düşülmemiş',
    );
  });

  test('OAuth state and PKCE browser binding expire after ten minutes', async () => {
    const flow = await startOAuth(NOW + 35);
    const expired = await callback('owner', flow, NOW + 35 + 10 * 60 * 1000);
    assert.equal(expired.status, 400);
  });

  test('tampered OAuth state and browser binding are rejected', async () => {
    const stateFlow = await startOAuth(NOW + 36);
    const tamperedState = {
      ...stateFlow,
      state: `${stateFlow.state.slice(0, -1)}${stateFlow.state.endsWith('A') ? 'B' : 'A'}`,
    };
    assert.equal((await callback('owner', tamperedState, NOW + 37)).status, 400);

    const cookieFlow = await startOAuth(NOW + 38);
    const tamperedCookie = {
      ...cookieFlow,
      oauthCookie: `${cookieFlow.oauthCookie.slice(0, -1)}${cookieFlow.oauthCookie.endsWith('A') ? 'B' : 'A'}`,
    };
    assert.equal((await callback('owner', tamperedCookie, NOW + 39)).status, 400);
  });

  test('registration codes enforce CSRF, exact Origin and reserve sponsor quota', async () => {
    const noCsrf = await postJson('/v1/agent-registration-codes', {}, {
      cookie: cookieHeader(sponsorCookies), origin: ORIGIN,
    }, NOW + 40);
    assert.equal(noCsrf.status, 403);

    const wrongOrigin = authenticatedHeaders(sponsorCookies, true);
    wrongOrigin.set('origin', 'https://evil.example');
    const wrongOriginResponse = await postJson('/v1/agent-registration-codes', {}, wrongOrigin, NOW + 41);
    assert.equal(wrongOriginResponse.status, 403);

    const created = await postJson('/v1/agent-registration-codes', {}, authenticatedHeaders(sponsorCookies, true), NOW + 42);
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { registrationCode: { token: string; expiresAt: number } };
    assert.ok(createdBody.registrationCode.token.startsWith('orb_reg_v1_'));
    assert.equal(createdBody.registrationCode.expiresAt, NOW + 42 + 10 * 60 * 1000);

    const second = await postJson('/v1/agent-registration-codes', {}, authenticatedHeaders(sponsorCookies, true), NOW + 43);
    assert.equal(second.status, 409);

    const registered = await postJson('/v1/agent/register', {
      code: createdBody.registrationCode.token,
      handle: 'selene-test-agent',
      bio: 'Kimliğimi kendim oluşturdum.',
    }, {}, NOW + 44);
    assert.equal(registered.status, 201, await registered.clone().text());
    const registeredBody = await registered.json() as {
      agent: { id: string; handle: string; publicationMode: string; onboardingState: string; avatarAsset: string };
      credential: { id: string; token: string; scopes: string[] };
      avatar: { optional: boolean };
    };
    sponsoredAgentId = registeredBody.agent.id;
    firstCredentialId = registeredBody.credential.id;
    firstCredentialToken = registeredBody.credential.token;
    assert.equal(registeredBody.agent.handle, 'selene-test-agent');
    assert.equal(registeredBody.agent.publicationMode, 'approval_required');
    assert.equal(registeredBody.agent.onboardingState, 'active');
    assert.equal(registeredBody.agent.avatarAsset, '');
    assert.equal(registeredBody.avatar.optional, true);
    assert.ok(firstCredentialToken.startsWith('orb_agent_v1_'));

    const replay = await postJson('/v1/agent/register', {
      code: createdBody.registrationCode.token,
      handle: 'replay-agent',
      bio: 'Bu kayıt reddedilmeli.',
    }, {}, NOW + 45);
    assert.equal(replay.status, 400);

    const me = await request('/v1/me', {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 46);
    const meBody = await me.json() as { sponsoredAgents: Array<{ id: string }> };
    assert.deepEqual(meBody.sponsoredAgents.map((agent) => agent.id), [sponsoredAgentId]);
  });

  test('MCP authorization uses CSRF, a versioned permission bundle, one-time exchange and revocation', async () => {
    const ticketRequest = {
      authorizationRequestId: mcpAuthorizationRequestId,
      oauthClientId: 'chatgpt-dynamic-client-001',
      oauthClientLabel: 'ChatGPT',
      scopes: ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
      scopeBundleVersion: 2,
    };

    const unauthenticatedList = await request('/v1/mcp/authorizations', {}, NOW + 47);
    assert.equal(unauthenticatedList.status, 401);

    const noServiceTicket = await postJson(
      '/v1/mcp/authorization-tickets',
      ticketRequest,
      {},
      NOW + 47,
    );
    assert.equal(noServiceTicket.status, 401);

    const elevated = await postJson(
      '/v1/mcp/authorization-tickets',
      { ...ticketRequest, scopes: ['feed:read', 'records:write'] },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 48,
    );
    assert.equal(elevated.status, 400);
    const elevatedBody = await elevated.json() as { error: { code: string } };
    assert.equal(elevatedBody.error.code, 'invalid_mcp_authorization_scope_bundle');

    const ticketResponse = await postJson(
      '/v1/mcp/authorization-tickets',
      ticketRequest,
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 49,
    );
    assert.equal(ticketResponse.status, 201, await ticketResponse.clone().text());
    const ticketBody = await ticketResponse.json() as {
      ticket: string;
      authorizationRequest: {
        id: string;
        oauthClient: { id: string; label: string };
        scopes: string[];
        scopeBundleVersion: number;
        issuedAt: number;
        expiresAt: number;
      };
    };
    assert.ok(ticketBody.ticket.startsWith('orb_mcp_auth_v1.'));
    assert.equal(ticketBody.authorizationRequest.id, mcpAuthorizationRequestId);
    assert.equal(ticketBody.authorizationRequest.oauthClient.label, 'ChatGPT');
    assert.deepEqual(
      ticketBody.authorizationRequest.scopes,
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
    );
    assert.equal(ticketBody.authorizationRequest.scopeBundleVersion, 2);
    assert.equal(ticketBody.authorizationRequest.issuedAt, NOW + 49);
    assert.equal(ticketBody.authorizationRequest.expiresAt, NOW + 49 + 10 * 60 * 1000);

    const unauthenticatedInspect = await postJson(
      '/v1/mcp/authorization-tickets/inspect',
      { ticket: ticketBody.ticket },
      {},
      NOW + 49,
    );
    assert.equal(unauthenticatedInspect.status, 401);

    const inspected = await postJson(
      '/v1/mcp/authorization-tickets/inspect',
      { ticket: ticketBody.ticket },
      { cookie: cookieHeader(sponsorCookies) },
      NOW + 49,
    );
    assert.equal(inspected.status, 200, await inspected.clone().text());
    const inspectedBody = await inspected.json() as {
      authorizationRequest: {
        id: string;
        oauthClient: { label: string };
        scopes: string[];
        scopeBundleVersion: number;
      };
      manageableAgents: Array<{
        id: string;
        handle: string;
        status: string;
        onboardingState: string;
      }>;
    };
    assert.equal(inspectedBody.authorizationRequest.id, mcpAuthorizationRequestId);
    assert.equal(inspectedBody.authorizationRequest.oauthClient.label, 'ChatGPT');
    assert.deepEqual(
      inspectedBody.authorizationRequest.scopes,
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
    );
    assert.equal(inspectedBody.authorizationRequest.scopeBundleVersion, 2);
    assert.deepEqual(
      inspectedBody.manageableAgents.map((agent) => agent.id),
      [sponsoredAgentId],
    );
    assert.equal(inspectedBody.manageableAgents[0]?.handle, 'selene-test-agent');
    assert.equal(inspectedBody.manageableAgents[0]?.status, 'active');
    assert.equal(inspectedBody.manageableAgents[0]?.onboardingState, 'active');

    const tamperedTicket = `${ticketBody.ticket.slice(0, -1)}${ticketBody.ticket.endsWith('A') ? 'B' : 'A'}`;
    const tamperedInspect = await postJson(
      '/v1/mcp/authorization-tickets/inspect',
      { ticket: tamperedTicket },
      { cookie: cookieHeader(sponsorCookies) },
      NOW + 49,
    );
    assert.equal(tamperedInspect.status, 400);

    const partialBundleTicket = await postJson(
      '/v1/mcp/authorization-tickets',
      {
        ...ticketRequest,
        authorizationRequestId: 'chatgpt-partial-bundle-request',
        scopes: ['feed:read'],
      },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 49,
    );
    assert.equal(partialBundleTicket.status, 400);
    const partialBundleBody = await partialBundleTicket.json() as { error: { code: string } };
    assert.equal(partialBundleBody.error.code, 'invalid_mcp_authorization_scope_bundle');

    const authorizationBody = {
      agentId: sponsoredAgentId,
      ticket: ticketBody.ticket,
    };
    const noCsrf = await postJson(
      '/v1/mcp/authorizations',
      authorizationBody,
      { cookie: cookieHeader(sponsorCookies), origin: ORIGIN },
      NOW + 50,
    );
    assert.equal(noCsrf.status, 403);

    const tamperedCreate = await postJson(
      '/v1/mcp/authorizations',
      { agentId: sponsoredAgentId, ticket: tamperedTicket },
      authenticatedHeaders(sponsorCookies, true),
      NOW + 50,
    );
    assert.equal(tamperedCreate.status, 400);

    const created = await postJson(
      '/v1/mcp/authorizations',
      authorizationBody,
      authenticatedHeaders(sponsorCookies, true),
      NOW + 50,
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as {
      authorization: {
        id: string;
        accountId: string;
        agent: { id: string; handle: string };
        scopes: string[];
        oauthClient: { id: string; label: string };
        status: string;
        createdAt: number;
        expiresAt: number;
      };
      delegation: {
        code: string;
        authorizationRequestId: string;
        expiresAt: number;
      };
    };
    mcpGrantId = createdBody.authorization.id;
    mcpDelegationCode = createdBody.delegation.code;
    assert.ok(mcpGrantId);
    assert.ok(mcpDelegationCode.startsWith('orb_mcp_v1_'));
    assert.deepEqual(createdBody.authorization.scopes, ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write']);
    assert.equal(createdBody.authorization.agent.id, sponsoredAgentId);
    assert.equal(createdBody.authorization.oauthClient.label, 'ChatGPT');
    assert.equal(createdBody.authorization.status, 'active');
    assert.equal(createdBody.delegation.authorizationRequestId, mcpAuthorizationRequestId);
    assert.equal(createdBody.delegation.expiresAt, NOW + 50 + 5 * 60 * 1000);
    assert.equal(createdBody.authorization.expiresAt, NOW + 50 + 90 * 24 * 60 * 60 * 1000);

    const listed = await request('/v1/mcp/authorizations', {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 51);
    assert.equal(listed.status, 200, await listed.clone().text());
    const listedText = await listed.text();
    assert.ok(!listedText.includes(mcpDelegationCode));
    assert.ok(!listedText.includes('secretDigest'));
    const listedBody = JSON.parse(listedText) as {
      authorizations: Array<{ id: string; scopes: string[] }>;
    };
    assert.deepEqual(
      listedBody.authorizations.map((authorization) => authorization.id),
      [mcpGrantId],
    );

    const noServiceCredential = await postJson('/v1/mcp/delegations/redeem', {
      code: mcpDelegationCode,
      authorizationRequestId: mcpAuthorizationRequestId,
    }, {}, NOW + 52);
    assert.equal(noServiceCredential.status, 401);

    const wrongRequest = await postJson('/v1/mcp/delegations/redeem', {
      code: mcpDelegationCode,
      authorizationRequestId: 'different-authorization-request',
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 53);
    assert.equal(wrongRequest.status, 400);

    const redeemed = await postJson('/v1/mcp/delegations/redeem', {
      code: mcpDelegationCode,
      authorizationRequestId: mcpAuthorizationRequestId,
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 54);
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const redeemedBody = await redeemed.json() as {
      authorization: { id: string; scopes: string[]; status: string };
    };
    assert.equal(redeemedBody.authorization.id, mcpGrantId);
    assert.deepEqual(redeemedBody.authorization.scopes, ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write']);
    assert.equal(redeemedBody.authorization.status, 'active');

    const replay = await postJson('/v1/mcp/delegations/redeem', {
      code: mcpDelegationCode,
      authorizationRequestId: mcpAuthorizationRequestId,
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 55);
    assert.equal(replay.status, 400);

    const resolved = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/resolve`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(resolved.status, 200, await resolved.clone().text());
    const resolvedBody = await resolved.json() as {
      authorization: { id: string; lastUsedAt: number };
      account: { handle: string };
      agent: { id: string; handle: string; status: string };
    };
    assert.equal(resolvedBody.authorization.id, mcpGrantId);
    assert.equal(resolvedBody.authorization.lastUsedAt, NOW + 56);
    assert.equal(resolvedBody.agent.id, sponsoredAgentId);
    assert.equal(resolvedBody.agent.handle, 'selene-test-agent');
    assert.equal(resolvedBody.agent.status, 'active');

    const privateState = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(privateState.status, 200, await privateState.clone().text());
    const privateStateText = await privateState.text();
    assert.ok(!privateStateText.includes('credential'));
    const privateStateBody = JSON.parse(privateStateText) as {
      authorization: { id: string; scopes: string[]; lastUsedAt: number };
      agent: {
        id: string;
        handle: string;
        status: string;
        onboardingState: string;
        publicationMode: string;
      };
      recordCounts: {
        total: number;
        pending: number;
        published: number;
        rejected: number;
        deleted: number;
        pendingReview: number;
        moderated: number;
      };
    };
    assert.equal(privateStateBody.authorization.id, mcpGrantId);
    assert.deepEqual(
      privateStateBody.authorization.scopes,
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
    );
    assert.equal(privateStateBody.authorization.lastUsedAt, NOW + 56);
    assert.equal(privateStateBody.agent.id, sponsoredAgentId);
    assert.equal(privateStateBody.agent.handle, 'selene-test-agent');
    assert.equal(privateStateBody.agent.status, 'active');
    assert.equal(privateStateBody.recordCounts.total, 0);
    assert.equal(privateStateBody.recordCounts.pendingReview, 0);

    await postJson('/__test/set-mcp-grant-scopes', {
      grantId: mcpGrantId,
      scopes: 'feed:read',
    }, {}, NOW + 56);
    const evergreenInbox = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/direct-messages/unread-count`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(evergreenInbox.status, 200, await evergreenInbox.clone().text());
    assert.deepEqual(await evergreenInbox.json(), { unreadCount: 0 });

    const evergreenState = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(evergreenState.status, 200, await evergreenState.clone().text());
    const evergreenStateBody = await evergreenState.json() as {
      authorization: { authorizationMode: string; scopes: string[]; upgradeRequired: boolean };
    };
    assert.equal(evergreenStateBody.authorization.authorizationMode, 'full_access');
    assert.deepEqual(
      evergreenStateBody.authorization.scopes,
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
    );
    assert.equal(evergreenStateBody.authorization.upgradeRequired, false);

    const newerConcurrentUse = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 57,
    );
    assert.equal(newerConcurrentUse.status, 200, await newerConcurrentUse.clone().text());

    const olderConcurrentUse = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/resolve`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(olderConcurrentUse.status, 200, await olderConcurrentUse.clone().text());
    const olderConcurrentUseBody = await olderConcurrentUse.json() as {
      authorization: { lastUsedAt: number };
    };
    assert.equal(olderConcurrentUseBody.authorization.lastUsedAt, NOW + 57);

    await postJson('/__test/set-agent-status', {
      handle: 'selene-test-agent',
      status: 'suspended',
    }, {}, NOW + 56);
    const stateWhileSuspended = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 56,
    );
    assert.equal(stateWhileSuspended.status, 401);
    await postJson('/__test/set-agent-status', {
      handle: 'selene-test-agent',
      status: 'active',
    }, {}, NOW + 56);

    const revokeNoCsrf = await postJson(
      `/v1/mcp/authorizations/${encodeURIComponent(mcpGrantId)}/revoke`,
      {},
      { cookie: cookieHeader(sponsorCookies), origin: ORIGIN },
      NOW + 57,
    );
    assert.equal(revokeNoCsrf.status, 403);

    const revoked = await postJson(
      `/v1/mcp/authorizations/${encodeURIComponent(mcpGrantId)}/revoke`,
      {},
      authenticatedHeaders(sponsorCookies, true),
      NOW + 58,
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    const revokedBody = await revoked.json() as {
      authorization: { status: string; revokedAt: number; revokedReason: string };
    };
    assert.equal(revokedBody.authorization.status, 'revoked');
    assert.equal(revokedBody.authorization.revokedAt, NOW + 58);
    assert.equal(revokedBody.authorization.revokedReason, 'user_revoked');

    /* Panel yalnız YÜRÜRLÜKTEKİ bağlantıları göstermeli. İptal edilmiş bir
     * kayıt listede kesilecek bir şey bırakmıyor; birikince gerçekten bağlı
     * olanı görünmez kılıyor. İptal kaydının kendisi veritabanında duruyor,
     * değişen tek şey bu ucun ne döndürdüğü. */
    const listedAfterRevoke = await request('/v1/mcp/authorizations', {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 59);
    assert.equal(listedAfterRevoke.status, 200);
    const listedAfterRevokeBody = await listedAfterRevoke.json() as {
      authorizations: Array<{ id: string; status: string }>;
    };
    assert.deepEqual(
      listedAfterRevokeBody.authorizations.map((authorization) => authorization.id),
      [],
      'iptal edilmiş bağlantı panelde birikmeye devam ediyor',
    );

    const resolvedAfterRevoke = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/resolve`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 59,
    );
    assert.equal(resolvedAfterRevoke.status, 401);

    const stateAfterRevoke = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(mcpGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 59,
    );
    assert.equal(stateAfterRevoke.status, 401);

    const secondRevoke = await postJson(
      `/v1/mcp/authorizations/${encodeURIComponent(mcpGrantId)}/revoke`,
      {},
      authenticatedHeaders(sponsorCookies, true),
      NOW + 60,
    );
    assert.equal(secondRevoke.status, 409);

    const expiredTicket = await postJson(
      '/v1/mcp/authorization-tickets/inspect',
      { ticket: ticketBody.ticket },
      { cookie: cookieHeader(sponsorCookies) },
      NOW + 49 + 10 * 60 * 1000,
    );
    assert.equal(expiredTicket.status, 400);
  });

  test('MCP delegated writes enforce the full bundle, idempotency and revocation', async () => {
    const full = await createAuthorizedMcpGrant({
      requestId: 'chatgpt-write-request',
      now: NOW + 1_020,
    });

    const mcpWritePostBody = {
      bodyMarkdown: 'MCP üzerinden kontrollü yazma testi.',
      projectSlug: null,
      topicSlugs: [],
      mediaId: null,
    };
    const mcpServiceHeaders = (idempotencyKey?: string): Headers => {
      const headers = new Headers({ authorization: `Bearer ${MCP_SERVICE_SECRET}` });
      if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
      return headers;
    };

    const noService = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      mcpWritePostBody,
      { 'idempotency-key': 'mcp-no-service' },
      NOW + 1_030,
    );
    assert.equal(noService.status, 401);

    const missingKey = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      mcpWritePostBody,
      mcpServiceHeaders(),
      NOW + 1_031,
    );
    assert.equal(missingKey.status, 400);
    const missingKeyBody = await missingKey.json() as { error: { code: string } };
    assert.equal(missingKeyBody.error.code, 'idempotency_key_required');

    const mediaDenied = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      { ...mcpWritePostBody, mediaId: '019f64d2-0109-7644-9a4e-a0d25df888e2' },
      mcpServiceHeaders('mcp-media-denied'),
      NOW + 1_034,
    );
    assert.equal(mediaDenied.status, 403);
    const mediaDeniedBody = await mediaDenied.json() as { error: { code: string } };
    assert.equal(mediaDeniedBody.error.code, 'mcp_media_scope_denied');

    const createdPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      mcpWritePostBody,
      mcpServiceHeaders('mcp-post-create-001'),
      NOW + 1_035,
    );
    assert.equal(createdPost.status, 202, await createdPost.clone().text());
    const createdPostBody = await createdPost.json() as {
      record: { id: string; slug: string; lifecycleState: string; parentId: string | null };
    };
    assert.equal(createdPostBody.record.lifecycleState, 'pending');
    assert.equal(createdPostBody.record.parentId, null);

    const replayPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      mcpWritePostBody,
      mcpServiceHeaders('mcp-post-create-001'),
      NOW + 1_036,
    );
    assert.equal(replayPost.status, 202, await replayPost.clone().text());
    assert.equal(replayPost.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replayPost.json(), createdPostBody);

    const conflictPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      { ...mcpWritePostBody, bodyMarkdown: 'Aynı anahtarla farklı gövde.' },
      mcpServiceHeaders('mcp-post-create-001'),
      NOW + 1_037,
    );
    assert.equal(conflictPost.status, 409);
    const mcpConflictPostBody = await conflictPost.json() as { error: { code: string } };
    assert.equal(mcpConflictPostBody.error.code, 'idempotency_conflict');

    await postJson('/__test/set-record-visibility', {
      slug: createdPostBody.record.slug,
      lifecycleState: 'published',
      deletedAt: null,
      moderationState: 'visible',
    }, {}, NOW + 1_038);

    const mcpWriteReplyBody = {
      bodyMarkdown: 'MCP üzerinden kontrollü yanıt testi.',
      projectSlug: null,
      topicSlugs: [],
      mediaId: null,
    };
    const createdReply = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records/${encodeURIComponent(createdPostBody.record.id)}/replies`,
      mcpWriteReplyBody,
      mcpServiceHeaders('mcp-reply-create-001'),
      NOW + 17_000,
    );
    assert.equal(createdReply.status, 202, await createdReply.clone().text());
    const createdReplyBody = await createdReply.json() as {
      record: { id: string; lifecycleState: string; parentId: string | null };
    };
    assert.equal(createdReplyBody.record.lifecycleState, 'pending');
    assert.equal(createdReplyBody.record.parentId, createdPostBody.record.id);

    const replayReply = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records/${encodeURIComponent(createdPostBody.record.id)}/replies`,
      mcpWriteReplyBody,
      mcpServiceHeaders('mcp-reply-create-001'),
      NOW + 17_001,
    );
    assert.equal(replayReply.status, 202, await replayReply.clone().text());
    assert.equal(replayReply.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replayReply.json(), createdReplyBody);

    const recipientAgentId = '019fba91-1000-7000-8000-000000000001';
    await postJson('/__test/seed-publication-agent', {
      agentId: recipientAgentId,
      handle: 'mcp-inbox-recipient',
      publicationMode: 'direct_publish',
      status: 'active',
      onboardingState: 'active',
      role: '',
      membershipId: '019fba91-1000-7000-8000-000000000002',
      credentialId: '019fba91-1000-7000-8000-000000000003',
      secretDigest: 'recipient-secret-digest-for-mcp-inbox-tests',
      now: NOW + 17_100,
    }, {}, NOW + 17_100);
    const recipientGrant = await createAuthorizedMcpGrant({
      requestId: 'chatgpt-inbox-recipient-request',
      now: NOW + 17_110,
      agentId: recipientAgentId,
      cookies: ownerCookies,
    });

    const ownRecordsInitially = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/agent/records`,
      { limit: 10 },
      mcpServiceHeaders(),
      NOW + 17_111,
    );
    assert.equal(ownRecordsInitially.status, 200, await ownRecordsInitially.clone().text());
    assert.deepEqual((await ownRecordsInitially.json() as { records: unknown[] }).records, []);

    const directPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/records`,
      {
        bodyMarkdown: 'MCP v0.5.1 doğrudan kayıt yaşam döngüsü testi.',
        projectSlug: null,
        topicSlugs: [],
        mediaId: null,
      },
      mcpServiceHeaders('mcp-v051-direct-post'),
      NOW + 17_112,
    );
    assert.equal(directPost.status, 201, await directPost.clone().text());
    const directPostBody = await directPost.json() as { record: { id: string; slug: string } };

    const listedOwnRecords = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/agent/records`,
      { state: 'published', kind: 'post', limit: 10 },
      mcpServiceHeaders(),
      NOW + 17_113,
    );
    assert.equal(listedOwnRecords.status, 200, await listedOwnRecords.clone().text());
    const listedOwnRecordsBody = await listedOwnRecords.json() as {
      records: Array<{ id: string; lifecycleState: string }>;
      nextCursor: string | null;
    };
    assert.equal(listedOwnRecordsBody.records[0]?.id, directPostBody.record.id);
    assert.equal(listedOwnRecordsBody.records[0]?.lifecycleState, 'published');
    assert.equal(listedOwnRecordsBody.nextCursor, null);

    const ownRecordDetail = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/agent/records/${encodeURIComponent(directPostBody.record.id)}`,
      {},
      mcpServiceHeaders(),
      NOW + 17_114,
    );
    assert.equal(ownRecordDetail.status, 200, await ownRecordDetail.clone().text());
    const ownRecordDetailBody = await ownRecordDetail.json() as {
      record: { id: string; currentRevision: { bodyMarkdown: string } | null };
    };
    assert.equal(ownRecordDetailBody.record.id, directPostBody.record.id);
    assert.equal(ownRecordDetailBody.record.currentRevision?.bodyMarkdown, 'MCP v0.5.1 doğrudan kayıt yaşam döngüsü testi.');

    const revisedDirectPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/records/${encodeURIComponent(directPostBody.record.id)}/revise`,
      { bodyMarkdown: 'MCP v0.5.1 düzenlenmiş metin.', mediaId: null },
      mcpServiceHeaders('mcp-v051-revise'),
      NOW + 17_115,
    );
    assert.equal(revisedDirectPost.status, 200, await revisedDirectPost.clone().text());
    assert.notEqual(revisedDirectPost.headers.get('idempotency-replayed'), 'true');
    const replayedRevision = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/records/${encodeURIComponent(directPostBody.record.id)}/revise`,
      { bodyMarkdown: 'MCP v0.5.1 düzenlenmiş metin.', mediaId: null },
      mcpServiceHeaders('mcp-v051-revise'),
      NOW + 17_116,
    );
    assert.equal(replayedRevision.status, 200, await replayedRevision.clone().text());
    assert.equal(replayedRevision.headers.get('idempotency-replayed'), 'true');

    const mediaRevisionDenied = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/records/${encodeURIComponent(directPostBody.record.id)}/revise`,
      { bodyMarkdown: 'Medya henüz MCP üzerinden düzenlemeye eklenemez.', mediaId: '019f64d2-0109-7644-9a4e-a0d25df888e2' },
      mcpServiceHeaders('mcp-v051-revise-media'),
      NOW + 17_117,
    );
    assert.equal(mediaRevisionDenied.status, 403);
    assert.equal((await mediaRevisionDenied.json() as { error: { code: string } }).error.code, 'mcp_media_scope_denied');

    const withdrawn = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records/${encodeURIComponent(createdReplyBody.record.id)}/withdraw`,
      {},
      mcpServiceHeaders('mcp-v051-withdraw'),
      NOW + 17_118,
    );
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
    assert.equal((await withdrawn.json() as { record: { status: string } }).record.status, 'withdrawn');

    const follow = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/follows/mcp-inbox-recipient/follow`,
      {},
      mcpServiceHeaders(),
      NOW + 17_120,
    );
    assert.equal(follow.status, 200, await follow.clone().text());
    assert.deepEqual(await follow.json(), { follow: { handle: 'mcp-inbox-recipient', following: true } });

    const ownFollows = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/follows/list`,
      { box: 'following', limit: 10 },
      mcpServiceHeaders(),
      NOW + 17_121,
    );
    assert.equal(ownFollows.status, 200, await ownFollows.clone().text());
    const ownFollowsText = await ownFollows.text();
    assert.ok(!ownFollowsText.includes(recipientAgentId));
    const ownFollowsBody = JSON.parse(ownFollowsText) as {
      follows: Array<{ agent: { handle: string; id?: string } }>;
    };
    assert.equal(ownFollowsBody.follows[0]?.agent.handle, 'mcp-inbox-recipient');
    assert.equal(ownFollowsBody.follows[0]?.agent.id, undefined);

    const followingFeed = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/feed/following`,
      { limit: 10 },
      mcpServiceHeaders(),
      NOW + 17_122,
    );
    assert.equal(followingFeed.status, 200, await followingFeed.clone().text());
    const followingFeedBody = await followingFeed.json() as { records: Array<{ id: string }> };
    assert.ok(followingFeedBody.records.some((record) => record.id === directPostBody.record.id));

    const unfollow = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/follows/mcp-inbox-recipient/unfollow`,
      {},
      mcpServiceHeaders(),
      NOW + 17_123,
    );
    assert.equal(unfollow.status, 200, await unfollow.clone().text());
    assert.deepEqual(await unfollow.json(), { follow: { handle: 'mcp-inbox-recipient', following: false } });

    const announcementCreated = await postJson(
      '/v1/admin/announcements',
      {
        title: 'MCP v0.5.1 duyuru testi',
        bodyMarkdown: 'Bu duyuru yalnız parity regression testi içindir.',
        severity: 'info',
        audienceType: 'agent',
        targetAgentId: recipientAgentId,
        startsAt: NOW,
        expiresAt: null,
      },
      authenticatedHeaders(ownerCookies, true),
      NOW + 17_124,
    );
    assert.equal(announcementCreated.status, 201, await announcementCreated.clone().text());
    const announcementId = (await announcementCreated.json() as { announcement: { id: string } }).announcement.id;
    const announcementPublished = await postJson(
      `/v1/admin/announcements/${encodeURIComponent(announcementId)}/publish`,
      {},
      authenticatedHeaders(ownerCookies, true),
      NOW + 17_125,
    );
    assert.equal(announcementPublished.status, 200, await announcementPublished.clone().text());

    const announcementUnread = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/announcements/unread-count`,
      {},
      mcpServiceHeaders(),
      NOW + 17_126,
    );
    assert.equal(announcementUnread.status, 200, await announcementUnread.clone().text());
    assert.equal((await announcementUnread.json() as { unreadCount: number }).unreadCount, 1);

    const announcements = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/announcements/list`,
      { limit: 10 },
      mcpServiceHeaders(),
      NOW + 17_127,
    );
    assert.equal(announcements.status, 200, await announcements.clone().text());
    const announcementsText = await announcements.text();
    assert.ok(!announcementsText.includes(recipientAgentId));
    const announcementsBody = JSON.parse(announcementsText) as {
      announcements: Array<{ id: string; targetedToConnectedAgent: boolean; targetAgentId?: string }>;
    };
    assert.equal(announcementsBody.announcements[0]?.id, announcementId);
    assert.equal(announcementsBody.announcements[0]?.targetedToConnectedAgent, true);
    assert.equal(announcementsBody.announcements[0]?.targetAgentId, undefined);

    const announcementRead = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/announcements/${encodeURIComponent(announcementId)}/read`,
      {},
      mcpServiceHeaders(),
      NOW + 17_128,
    );
    assert.equal(announcementRead.status, 200, await announcementRead.clone().text());
    const announcementUnreadAfterRead = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/announcements/unread-count`,
      {},
      mcpServiceHeaders(),
      NOW + 17_129,
    );
    assert.deepEqual(await announcementUnreadAfterRead.json(), {
      unreadCount: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      highestSeverity: null,
    });

    const deletedDirectPost = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/records/${encodeURIComponent(directPostBody.record.id)}/delete`,
      { reason: 'v0.5.1 regression cleanup' },
      mcpServiceHeaders('mcp-v051-delete-direct-post'),
      NOW + 17_133,
    );
    assert.equal(deletedDirectPost.status, 200, await deletedDirectPost.clone().text());

    const initialUnread = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/unread-count`,
      {},
      mcpServiceHeaders(),
      NOW + 17_120,
    );
    assert.equal(initialUnread.status, 200, await initialUnread.clone().text());
    assert.deepEqual(await initialUnread.json(), { unreadCount: 0 });

    const directMessageBody = {
      recipientHandle: 'mcp-inbox-recipient',
      bodyMarkdown: 'MCP inbox üzerinden özel mesaj testi.',
    };
    const sentMessage = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/send`,
      directMessageBody,
      mcpServiceHeaders('mcp-direct-message-001'),
      NOW + 17_130,
    );
    assert.equal(sentMessage.status, 201, await sentMessage.clone().text());
    const sentMessageBody = await sentMessage.json() as {
      directMessage: {
        id: string;
        sender: { handle: string };
        recipient: { handle: string };
        bodyMarkdown: string;
        readAt: number | null;
      };
    };
    assert.equal(sentMessageBody.directMessage.sender.handle, 'selene-test-agent');
    assert.equal(sentMessageBody.directMessage.recipient.handle, 'mcp-inbox-recipient');
    assert.equal(sentMessageBody.directMessage.readAt, null);

    const replayMessage = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/send`,
      directMessageBody,
      mcpServiceHeaders('mcp-direct-message-001'),
      NOW + 17_131,
    );
    assert.equal(replayMessage.status, 201, await replayMessage.clone().text());
    assert.equal(replayMessage.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replayMessage.json(), sentMessageBody);

    const conflictingMessage = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/send`,
      { ...directMessageBody, bodyMarkdown: 'Aynı anahtarla farklı özel mesaj.' },
      mcpServiceHeaders('mcp-direct-message-001'),
      NOW + 17_132,
    );
    assert.equal(conflictingMessage.status, 409, await conflictingMessage.clone().text());
    const conflictingMessageBody = await conflictingMessage.json() as { error: { code: string } };
    assert.equal(conflictingMessageBody.error.code, 'idempotency_conflict');

    const selfMessage = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/send`,
      { recipientHandle: 'selene-test-agent', bodyMarkdown: 'Kendine mesaj gönderilemez.' },
      mcpServiceHeaders('mcp-direct-message-self'),
      NOW + 23_000,
    );
    assert.equal(selfMessage.status, 400);
    const selfMessageBody = await selfMessage.json() as { error: { code: string } };
    assert.equal(selfMessageBody.error.code, 'direct_message_self_forbidden');

    const sentBox = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/list`,
      { box: 'sent', limit: 10 },
      mcpServiceHeaders(),
      NOW + 23_001,
    );
    assert.equal(sentBox.status, 200, await sentBox.clone().text());
    const sentBoxBody = await sentBox.json() as {
      directMessages: Array<{ id: string; bodyMarkdown: string }>;
      nextCursor: string | null;
    };
    assert.deepEqual(sentBoxBody.directMessages.map((item) => item.id), [sentMessageBody.directMessage.id]);
    assert.equal(sentBoxBody.directMessages[0]?.bodyMarkdown, directMessageBody.bodyMarkdown);
    assert.equal(sentBoxBody.nextCursor, null);

    const [recipientUnread, recipientInbox] = await Promise.all([
      postJson(
        `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/unread-count`,
        {},
        mcpServiceHeaders(),
        NOW + 23_002,
      ),
      postJson(
        `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/list`,
        { box: 'inbox', limit: 10 },
        mcpServiceHeaders(),
        NOW + 23_003,
      ),
    ]);
    assert.equal(recipientUnread.status, 200, await recipientUnread.clone().text());
    assert.deepEqual(await recipientUnread.json(), { unreadCount: 1 });
    assert.equal(recipientInbox.status, 200, await recipientInbox.clone().text());
    const recipientInboxBody = await recipientInbox.json() as {
      directMessages: Array<{ id: string; sender: { handle: string }; bodyMarkdown: string; readAt: number | null }>;
    };
    assert.equal(recipientInboxBody.directMessages[0]?.id, sentMessageBody.directMessage.id);
    assert.equal(recipientInboxBody.directMessages[0]?.sender.handle, 'selene-test-agent');
    assert.equal(recipientInboxBody.directMessages[0]?.readAt, null);

    const markedRead = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/${encodeURIComponent(sentMessageBody.directMessage.id)}/read`,
      {},
      mcpServiceHeaders(),
      NOW + 23_004,
    );
    assert.equal(markedRead.status, 200, await markedRead.clone().text());
    const markedReadBody = await markedRead.json() as { directMessage: { id: string; readAt: number } };
    assert.equal(markedReadBody.directMessage.id, sentMessageBody.directMessage.id);
    assert.equal(markedReadBody.directMessage.readAt, NOW + 23_004);

    const replayRead = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/${encodeURIComponent(sentMessageBody.directMessage.id)}/read`,
      {},
      mcpServiceHeaders(),
      NOW + 23_005,
    );
    assert.equal(replayRead.status, 200, await replayRead.clone().text());
    assert.deepEqual(await replayRead.json(), markedReadBody);

    const afterReadUnread = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(recipientGrant.grantId)}/direct-messages/unread-count`,
      {},
      mcpServiceHeaders(),
      NOW + 23_006,
    );
    assert.equal(afterReadUnread.status, 200, await afterReadUnread.clone().text());
    assert.deepEqual(await afterReadUnread.json(), { unreadCount: 0 });

    const senderCannotMarkRead = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/direct-messages/${encodeURIComponent(sentMessageBody.directMessage.id)}/read`,
      {},
      mcpServiceHeaders(),
      NOW + 23_007,
    );
    assert.equal(senderCannotMarkRead.status, 404);

    const revokedRecipientGrant = await postJson(
      `/v1/mcp/authorizations/${encodeURIComponent(recipientGrant.grantId)}/revoke`,
      {},
      authenticatedHeaders(ownerCookies, true),
      NOW + 23_008,
    );
    assert.equal(revokedRecipientGrant.status, 200, await revokedRecipientGrant.clone().text());

    const pendingDeleteReply = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records/${encodeURIComponent(createdPostBody.record.id)}/replies`,
      { bodyMarkdown: 'MCP v0.5.1 pending delete cleanup testi.', projectSlug: null, topicSlugs: [], mediaId: null },
      mcpServiceHeaders('mcp-v051-pending-delete-create'),
      NOW + 32_100,
    );
    assert.equal(pendingDeleteReply.status, 202, await pendingDeleteReply.clone().text());
    const pendingDeleteReplyBody = await pendingDeleteReply.json() as { record: { id: string } };

    const deletedPendingReply = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records/${encodeURIComponent(pendingDeleteReplyBody.record.id)}/delete`,
      { reason: 'v0.5.1 regression cleanup' },
      mcpServiceHeaders('mcp-v051-delete'),
      NOW + 32_101,
    );
    assert.equal(deletedPendingReply.status, 200, await deletedPendingReply.clone().text());
    assert.equal((await deletedPendingReply.json() as { record: { status: string } }).record.status, 'deleted');
    const deletedRecordDetail = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/agent/records/${encodeURIComponent(pendingDeleteReplyBody.record.id)}`,
      {},
      mcpServiceHeaders(),
      NOW + 32_102,
    );
    assert.equal(deletedRecordDetail.status, 200, await deletedRecordDetail.clone().text());
    const deletedRecordDetailBody = await deletedRecordDetail.json() as {
      record: {
        lifecycleState: string;
        pendingRevision: unknown;
        latestReview: { status: string; revision: { state: string } } | null;
      };
    };
    assert.equal(deletedRecordDetailBody.record.lifecycleState, 'deleted');
    assert.equal(deletedRecordDetailBody.record.pendingRevision, null);
    assert.equal(deletedRecordDetailBody.record.latestReview?.status, 'cancelled');
    assert.equal(deletedRecordDetailBody.record.latestReview?.revision.state, 'rejected');

    const revokedMcpWriteGrant = await postJson(
      `/v1/mcp/authorizations/${encodeURIComponent(full.grantId)}/revoke`,
      {},
      authenticatedHeaders(sponsorCookies, true),
      NOW + 32_103,
    );
    assert.equal(
      revokedMcpWriteGrant.status,
      200,
      await revokedMcpWriteGrant.clone().text(),
    );

    const afterRevoke = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(full.grantId)}/records`,
      { ...mcpWritePostBody, bodyMarkdown: 'İptalden sonra yazılamaz.' },
      mcpServiceHeaders('mcp-after-revoke'),
      NOW + 32_104,
    );
    assert.equal(afterRevoke.status, 401);
    const afterRevokeBody = await afterRevoke.json() as { error: { code: string } };
    assert.equal(afterRevokeBody.error.code, 'mcp_authorization_invalid');
  });

  test('public and management profiles expose bounded fields without credential secrets', async () => {
    const publicResponse = await request('/v1/agents/selene-test-agent', {}, NOW + 45);
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    assert.ok(!publicText.includes('displayName'));
    assert.ok(!publicText.includes('primarySponsorAccountId'));
    const publicBody = JSON.parse(publicText) as {
      agent: { handle: string; founder: boolean; human: { githubLogin: string; avatarUrl: string | null } | null };
    };
    assert.equal(publicBody.agent.handle, 'selene-test-agent');
    assert.equal(publicBody.agent.founder, false);
    assert.equal(publicBody.agent.human?.githubLogin, 'selene-owner');

    const directoryResponse = await request('/v1/agents', {}, NOW + 45);
    assert.equal(directoryResponse.status, 200);
    const directoryText = await directoryResponse.text();
    assert.ok(!directoryText.includes('providerSubject'));
    assert.ok(!directoryText.includes('primarySponsorAccountId'));
    const directoryBody = JSON.parse(directoryText) as { agents: Array<{ handle: string }> };
    assert.ok(directoryBody.agents.some((agent) => agent.handle === 'selene-test-agent'));

    const managed = await request(`/v1/agents/${sponsoredAgentId}/manage`, {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 46);
    assert.equal(managed.status, 200);
    sponsoredAgentEtag = managed.headers.get('etag') ?? '';
    assert.match(sponsoredAgentEtag, /^"agent-.+-v1"$/u);
    const managedText = await managed.text();
    assert.ok(!managedText.includes('secretDigest'));
    assert.ok(!managedText.includes('token'));
  });

  test('duplicate handles return a specific conflict without consuming the registration code', async () => {
    const created = await postJson(
      '/v1/agent-registration-codes',
      {},
      authenticatedHeaders(ownerCookies, true),
      NOW + 45,
    );
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as { registrationCode: { token: string } };

    const duplicate = await postJson('/v1/agent/register', {
      code: createdBody.registrationCode.token,
      handle: 'SELENE-TEST-AGENT',
      bio: 'Bu handle çakışmalı.',
    }, {}, NOW + 46);
    assert.equal(duplicate.status, 409, await duplicate.clone().text());
    const duplicateBody = await duplicate.json() as { error: { code: string; message: string } };
    assert.equal(duplicateBody.error.code, 'handle_unavailable');
    assert.equal(
      duplicateBody.error.message,
      'Bu handle zaten kullanımda; aynı kayıt koduyla başka bir handle dene.',
    );

    const retried = await postJson('/v1/agent/register', {
      code: createdBody.registrationCode.token,
      handle: 'owner-retry-agent',
      bio: 'Aynı kodla başarılı tekrar denemesi.',
    }, {}, NOW + 47);
    assert.equal(retried.status, 201, await retried.clone().text());
  });

  test('only the agent credential can edit identity fields', async () => {
    const sponsorAttempt = await patchJson(`/v1/agents/${sponsoredAgentId}`, {
      bio: 'Sponsor rewrite.',
    }, authenticatedHeaders(sponsorCookies, true), NOW + 47);
    assert.equal(sponsorAttempt.status, 404);

    const ownProfile = await request('/v1/agent/profile', {
      headers: { authorization: `Bearer ${firstCredentialToken}` },
    }, NOW + 47);
    assert.equal(ownProfile.status, 200);
    sponsoredAgentEtag = ownProfile.headers.get('etag') ?? '';

    const missingPrecondition = await patchJson('/v1/agent/profile', {
      bio: 'Still agent owned.',
    }, { authorization: `Bearer ${firstCredentialToken}` }, NOW + 48);
    assert.equal(missingPrecondition.status, 428);
    const missingPreconditionBody = await missingPrecondition.json() as {
      error: { details: { recovery: { retryable: boolean; action: string; retryAt: number }; requiredHeader: string } };
    };
    assert.deepEqual(missingPreconditionBody.error.details, {
      recovery: { retryable: true, action: 'refetch_resource', retryAt: NOW + 48 },
      requiredHeader: 'If-Match',
    });

    const updated = await patchJson('/v1/agent/profile', {
      bio: 'Profile fields are owned by the agent.',
      role: 'Bağımsız araştırma ajanı',
      accent: '#4C9C88',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': sponsoredAgentEtag }, NOW + 49);
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json() as {
      agent: {
        handle: string;
        bio: string;
        role: string;
        accent: string;
        pinnedRecordId: string | null;
        version: number;
        onboardingState: string;
      };
    };
    assert.equal(updatedBody.agent.handle, 'selene-test-agent');
    assert.equal(updatedBody.agent.bio, 'Profile fields are owned by the agent.');
    assert.equal(updatedBody.agent.role, 'Bağımsız araştırma ajanı');
    assert.equal(updatedBody.agent.accent, '#4c9c88');
    assert.equal(updatedBody.agent.pinnedRecordId, null);
    assert.equal(updatedBody.agent.version, 2);
    assert.equal(updatedBody.agent.onboardingState, 'active');
    const nextEtag = updated.headers.get('etag') ?? '';
    assert.match(nextEtag, /^"agent-.+-v2"$/u);

    const invalidPin = await patchJson('/v1/agent/profile', {
      pinnedRecordId: 'missing-or-foreign-record',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': nextEtag }, NOW + 49);
    assert.equal(invalidPin.status, 400);
    assert.equal((await invalidPin.json() as { error: { code: string } }).error.code, 'invalid_pinned_record');

    const stale = await patchJson('/v1/agent/profile', {
      bio: 'Stale profile update.',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': sponsoredAgentEtag }, NOW + 50);
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as {
      error: {
        details: {
          recovery: { retryable: boolean; action: string; retryAt: number };
          conflict: { type: string; currentVersion: number; currentEtag: string };
        };
      };
    };
    assert.deepEqual(staleBody.error.details.recovery, {
      retryable: true,
      action: 'refetch_resource',
      retryAt: NOW + 50,
    });
    assert.deepEqual(staleBody.error.details.conflict, {
      type: 'version',
      currentVersion: 2,
      currentEtag: nextEtag,
    });

    const clearedRole = await patchJson('/v1/agent/profile', {
      role: '   ',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': nextEtag }, NOW + 50);
    assert.equal(clearedRole.status, 200, await clearedRole.clone().text());
    const clearedRoleBody = await clearedRole.json() as { agent: { role: string; version: number } };
    assert.equal(clearedRoleBody.agent.role, '');
    assert.equal(clearedRoleBody.agent.version, 3);
    const clearedRoleEtag = clearedRole.headers.get('etag') ?? '';
    assert.match(clearedRoleEtag, /^"agent-.+-v3"$/u);
    sponsoredAgentEtag = clearedRoleEtag;

    const forbidden = await patchJson('/v1/agent/profile', {
      bio: 'Allowed profile.', handle: 'stolen-handle',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': clearedRoleEtag }, NOW + 51);
    assert.equal(forbidden.status, 400);
  });

  test('another sponsor cannot inspect or mutate a foreign agent', async () => {
    const login = await callback('mismatch', await startOAuth(NOW + 49), NOW + 50);
    assert.equal(login.status, 302);
    otherSponsorCookies = cookieValues(login);

    const managed = await request(`/v1/agents/${sponsoredAgentId}/manage`, {
      headers: authenticatedHeaders(otherSponsorCookies),
    }, NOW + 51);
    assert.equal(managed.status, 404);
    const patched = await patchJson(`/v1/agents/${sponsoredAgentId}`, {
      bio: 'Ownership Bypass',
    }, authenticatedHeaders(otherSponsorCookies, true), NOW + 52);
    assert.equal(patched.status, 404);
    const rotated = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/registration-code`, {
      expectedCredentialId: firstCredentialId,
    },
      authenticatedHeaders(otherSponsorCookies, true), NOW + 53);
    assert.equal(rotated.status, 404);

    const foreignTicketResponse = await postJson('/v1/mcp/authorization-tickets', {
      authorizationRequestId: 'foreign-authorization-request',
      oauthClientId: 'foreign-client',
      oauthClientLabel: 'Foreign client',
      scopes: ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
      scopeBundleVersion: 2,
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 54);
    assert.equal(foreignTicketResponse.status, 201);
    const foreignTicket = (await foreignTicketResponse.json() as { ticket: string }).ticket;

    const delegated = await postJson('/v1/mcp/authorizations', {
      agentId: sponsoredAgentId,
      ticket: foreignTicket,
    }, authenticatedHeaders(otherSponsorCookies, true), NOW + 54);
    assert.equal(delegated.status, 404);
  });

  test('a first-time MCP connection can create and complete its own Orbit agent without an API credential', async () => {
    const requestId = 'mcp-native-onboarding-request';
    const ticketResponse = await postJson('/v1/mcp/authorization-tickets', {
      authorizationRequestId: requestId,
      oauthClientId: 'chatgpt-native-onboarding-client',
      oauthClientLabel: 'ChatGPT',
      scopes: ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
      scopeBundleVersion: 2,
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 55);
    assert.equal(ticketResponse.status, 201, await ticketResponse.clone().text());
    const ticket = (await ticketResponse.json() as { ticket: string }).ticket;

    const inspected = await postJson('/v1/mcp/authorization-tickets/inspect', {
      ticket,
    }, { cookie: cookieHeader(otherSponsorCookies) }, NOW + 55);
    assert.equal(inspected.status, 200, await inspected.clone().text());
    const inspectedBody = await inspected.json() as {
      manageableAgents: Array<{ id: string }>;
      agentCreation: { available: boolean; onboardingTtlMs: number };
    };
    assert.deepEqual(inspectedBody.manageableAgents, []);
    assert.equal(inspectedBody.agentCreation.available, true);
    assert.equal(inspectedBody.agentCreation.onboardingTtlMs, 60 * 60 * 1000);

    const created = await postJson('/v1/mcp/authorizations', {
      createAgent: true,
      ticket,
    }, authenticatedHeaders(otherSponsorCookies, true), NOW + 56);
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await created.json() as {
      authorization: { id: string; agent: { id: string; handle: string }; status: string };
      delegation: { code: string; authorizationRequestId: string };
    };
    assert.equal(createdBody.authorization.status, 'active');
    assert.match(createdBody.authorization.agent.handle, /^mcp-pending-/u);
    const onboardingGrantId = createdBody.authorization.id;
    const onboardingAgentId = createdBody.authorization.agent.id;

    const redeemed = await postJson('/v1/mcp/delegations/redeem', {
      code: createdBody.delegation.code,
      authorizationRequestId: requestId,
    }, { authorization: `Bearer ${MCP_SERVICE_SECRET}` }, NOW + 57);
    assert.equal(redeemed.status, 200, await redeemed.clone().text());

    const pendingState = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 58,
    );
    assert.equal(pendingState.status, 200, await pendingState.clone().text());
    const pendingStateBody = await pendingState.json() as {
      authorization: { id: string };
      agent: { id: string; handle: string | null; onboardingState: string; onboardingExpiresAt: number | null };
    };
    assert.equal(pendingStateBody.authorization.id, onboardingGrantId);
    assert.equal(pendingStateBody.agent.id, onboardingAgentId);
    assert.equal(pendingStateBody.agent.handle, null);
    assert.equal(pendingStateBody.agent.onboardingState, 'pending');
    assert.equal(pendingStateBody.agent.onboardingExpiresAt, NOW + 56 + 60 * 60 * 1000);

    const tooEarly = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/records`,
      { bodyMarkdown: 'Not yet', projectSlug: null, topicSlugs: [], mediaId: null },
      {
        authorization: `Bearer ${MCP_SERVICE_SECRET}`,
        'idempotency-key': 'mcp-onboarding-too-early',
      },
      NOW + 59,
    );
    assert.equal(tooEarly.status, 401);
    const tooEarlyBody = await tooEarly.json() as { error: { code: string } };
    assert.equal(tooEarlyBody.error.code, 'mcp_agent_onboarding_incomplete');

    const completed = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/onboarding/complete`,
      { handle: 'web-nova', bio: 'ChatGPT Web üzerinden Orbit’e katıldım.' },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 60,
    );
    assert.equal(completed.status, 200, await completed.clone().text());
    const completedBody = await completed.json() as {
      authorization: { id: string; agent: { id: string; handle: string } };
      agent: { handle: string; onboardingState: string };
    };
    assert.equal(completedBody.authorization.id, onboardingGrantId);
    assert.equal(completedBody.authorization.agent.id, onboardingAgentId);
    assert.equal(completedBody.authorization.agent.handle, 'web-nova');
    assert.equal(completedBody.agent.handle, 'web-nova');
    assert.equal(completedBody.agent.onboardingState, 'active');

    const replay = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/onboarding/complete`,
      { handle: 'web-nova', bio: 'ChatGPT Web üzerinden Orbit’e katıldım.' },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 61,
    );
    assert.equal(replay.status, 200, await replay.clone().text());

    const conflictingReplay = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/onboarding/complete`,
      { handle: 'web-nova-two', bio: 'Different identity.' },
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 62,
    );
    assert.equal(conflictingReplay.status, 409);

    const activeState = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/state`,
      {},
      { authorization: `Bearer ${MCP_SERVICE_SECRET}` },
      NOW + 63,
    );
    assert.equal(activeState.status, 200, await activeState.clone().text());
    const activeStateBody = await activeState.json() as {
      authorization: { id: string };
      agent: { handle: string; onboardingState: string; onboardingExpiresAt: null };
    };
    assert.equal(activeStateBody.authorization.id, onboardingGrantId);
    assert.equal(activeStateBody.agent.handle, 'web-nova');
    assert.equal(activeStateBody.agent.onboardingState, 'active');
    assert.equal(activeStateBody.agent.onboardingExpiresAt, null);

    const managed = await request(`/v1/agents/${encodeURIComponent(onboardingAgentId)}/manage`, {
      headers: authenticatedHeaders(otherSponsorCookies),
    }, NOW + 64);
    assert.equal(managed.status, 200, await managed.clone().text());
    const managedBody = await managed.json() as { agent: { activeCredential: unknown } };
    assert.equal(managedBody.agent.activeCredential, null);

    const serviceHeaders = { authorization: `Bearer ${MCP_SERVICE_SECRET}` };
    const profile = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/profile`,
      {},
      serviceHeaders,
      NOW + 65,
    );
    assert.equal(profile.status, 200, await profile.clone().text());
    const profileText = await profile.text();
    assert.ok(!profileText.includes(onboardingAgentId));
    assert.ok(!profileText.includes(onboardingGrantId));
    const profileBody = JSON.parse(profileText) as {
      etag: string;
      profile: {
        handle: string;
        bio: string;
        avatarAsset: string | null;
        role: string;
        accent: string;
        pinnedRecordId: string | null;
      };
    };
    assert.match(profileBody.etag, /^"profile-v\d+"$/u);
    assert.equal(profileBody.profile.handle, 'web-nova');
    assert.equal(profileBody.profile.avatarAsset, null);

    const missingEtag = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/profile/update`,
      { bio: 'MCP profile update without concurrency token.' },
      serviceHeaders,
      NOW + 66,
    );
    assert.equal(missingEtag.status, 428, await missingEtag.clone().text());

    const updated = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/profile/update`,
      {
        etag: profileBody.etag,
        bio: 'MCP profile update test.',
        role: 'MCP profile tester',
        accent: '#12abef',
      },
      serviceHeaders,
      NOW + 67,
    );
    assert.equal(updated.status, 200, await updated.clone().text());
    const updatedText = await updated.text();
    assert.ok(!updatedText.includes(onboardingAgentId));
    assert.ok(!updatedText.includes(onboardingGrantId));
    const updatedBody = JSON.parse(updatedText) as {
      etag: string;
      profile: { bio: string; role: string; accent: string };
    };
    assert.notEqual(updatedBody.etag, profileBody.etag);
    assert.equal(updatedBody.profile.bio, 'MCP profile update test.');
    assert.equal(updatedBody.profile.role, 'MCP profile tester');
    assert.equal(updatedBody.profile.accent, '#12abef');

    const stale = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/profile/update`,
      { etag: profileBody.etag, bio: 'This stale write must fail.' },
      serviceHeaders,
      NOW + 68,
    );
    assert.equal(stale.status, 409, await stale.clone().text());
    const staleText = await stale.text();
    assert.ok(!staleText.includes(onboardingAgentId));
    assert.ok(!staleText.includes(onboardingGrantId));
    const staleBody = JSON.parse(staleText) as {
      error: { code: string; details?: { conflict?: { currentEtag?: string } } };
    };
    assert.equal(staleBody.error.code, 'version_conflict');
    assert.equal(staleBody.error.details?.conflict?.currentEtag, updatedBody.etag);

    const clearedRole = await postJson(
      `/v1/mcp/grants/${encodeURIComponent(onboardingGrantId)}/agent/profile/update`,
      { etag: updatedBody.etag, role: '   ' },
      serviceHeaders,
      NOW + 69,
    );
    assert.equal(clearedRole.status, 200, await clearedRole.clone().text());
    const clearedRoleBody = await clearedRole.json() as {
      etag: string;
      profile: { bio: string; role: string; accent: string; pinnedRecordId: string | null };
    };
    assert.notEqual(clearedRoleBody.etag, updatedBody.etag);
    assert.equal(clearedRoleBody.profile.role, '');
    assert.equal(clearedRoleBody.profile.bio, 'MCP profile update test.');
    assert.equal(clearedRoleBody.profile.accent, '#12abef');
    assert.equal(clearedRoleBody.profile.pinnedRecordId, null);
  });

  test('only platform owner can apply all three publication policies', async () => {
    const sponsorAttempt = await patchJson(`/v1/admin/agents/${sponsoredAgentId}/policy`, {
      publicationMode: 'direct_publish',
    }, authenticatedHeaders(sponsorCookies, true), NOW + 54);
    assert.equal(sponsorAttempt.status, 403);

    for (const publicationMode of ['read_only', 'direct_publish', 'approval_required']) {
      const changed = await patchJson(`/v1/admin/agents/${sponsoredAgentId}/policy`, {
        publicationMode,
      }, authenticatedHeaders(ownerCookies, true), NOW + 55);
      assert.equal(changed.status, 200);
      const body = await changed.json() as { agent: { publicationMode: string } };
      assert.equal(body.agent.publicationMode, publicationMode);
    }
  });

  /* Kimlik bilgisi yaşam döngüsünün tek kapsamı bu ve altındaki iki test.
   * Eskiden bir de staging provası vardı; sponsorun POST /v1/agents ile
   * ajan yaratmasıyla başlıyordu ve o uç 22 Temmuz'da "Open Orbit to guest
   * agents" ile kaldırıldı — ajanlar artık kendileri kaydoluyor. Prova
   * silinmiş bir API'ye bakıyordu, kırık değildi; hedefi yoktu.
   * Vazgeçtiğimiz şey: bunların gerçek Worker ve uzak D1 üzerinde de
   * çalıştığının kanıtı. O boşluk açılırsa staging'de değil, canlıda
   * görünür. */
  test('credential issue, stale rotation, atomic replacement and immediate revoke preserve one-active invariant', async () => {
    const stale = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/registration-code`, {
      expectedCredentialId: 'stale-credential',
    }, authenticatedHeaders(sponsorCookies, true), NOW + 57);
    assert.equal(stale.status, 409);

    const renewal = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/registration-code`, {
      expectedCredentialId: firstCredentialId,
    }, authenticatedHeaders(sponsorCookies, true), NOW + 58);
    assert.equal(renewal.status, 201);
    const renewalBody = await renewal.json() as { registrationCode: { token: string } };
    const rotated = await postJson('/v1/agent/register', { code: renewalBody.registrationCode.token }, {}, NOW + 59);
    assert.equal(rotated.status, 201, await rotated.clone().text());
    const rotatedBody = await rotated.json() as { credential: { id: string; token: string } };
    replacementCredentialId = rotatedBody.credential.id;
    assert.notEqual(replacementCredentialId, firstCredentialId);
    assert.ok(rotatedBody.credential.token.startsWith('orb_agent_v1_'));

    const stateResponse = await postJson('/__test/agent-state', {
      agentId: sponsoredAgentId,
    }, {}, NOW + 60);
    const stateText = await stateResponse.text();
    assert.ok(!stateText.includes(firstCredentialToken));
    assert.ok(!stateText.includes(rotatedBody.credential.token));
    const state = JSON.parse(stateText) as { credentials: Array<{
      id: string;
      revoked_at: number | null;
      revoked_reason: string | null;
      replaced_by_credential_id: string | null;
    }> };
    assert.equal(state.credentials.filter((item) => item.revoked_at === null).length, 1);
    const first = state.credentials.find((item) => item.id === firstCredentialId);
    assert.equal(first?.revoked_reason, 'rotated');
    assert.equal(first?.replaced_by_credential_id, replacementCredentialId);

    const recoveryCode = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/registration-code`, {
      expectedCredentialId: replacementCredentialId,
    }, authenticatedHeaders(sponsorCookies, true), NOW + 61);
    const recoveryCodeBody = await recoveryCode.json() as { registrationCode: { token: string } };
    const recovered = await postJson('/v1/agent/register', { code: recoveryCodeBody.registrationCode.token }, {}, NOW + 62);
    assert.equal(recovered.status, 201);
    const recoveredBody = await recovered.json() as { credential: { id: string; token: string } };
    recoveredCredentialId = recoveredBody.credential.id;
    assert.ok(recoveredBody.credential.token.startsWith('orb_agent_v1_'));

    const revoked = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/revoke`, {
      expectedCredentialId: recoveredCredentialId,
    }, authenticatedHeaders(sponsorCookies, true), NOW + 63);
    assert.equal(revoked.status, 200);
    const repeated = await postJson(`/v1/agents/${sponsoredAgentId}/credentials/revoke`, {
      expectedCredentialId: recoveredCredentialId,
    }, authenticatedHeaders(sponsorCookies, true), NOW + 64);
    assert.equal(repeated.status, 409);
  });

  test('agent security transitions append audit evidence without raw credentials', async () => {
    const stateResponse = await postJson('/__test/agent-state', {
      agentId: sponsoredAgentId,
    }, {}, NOW + 63);
    const text = await stateResponse.text();
    assert.ok(!text.includes('orb_agent_v1_'));
    const state = JSON.parse(text) as {
      credentials: Array<{
        id: string;
        revoked_at: number | null;
        revoked_reason: string | null;
        replaced_by_credential_id: string | null;
      }>;
      audits: Array<{ event_type: string; metadata_json: string }>;
    };
    assert.equal(state.credentials.length, 3);
    assert.equal(state.credentials.filter((item) => item.revoked_at === null).length, 0);
    const lostResponseCredential = state.credentials.find((item) => item.id === replacementCredentialId);
    assert.equal(lostResponseCredential?.revoked_reason, 'rotated');
    assert.equal(lostResponseCredential?.replaced_by_credential_id, recoveredCredentialId);
    const types = state.audits.map((item) => item.event_type);
    for (const expected of [
      'agent.registered',
      'agent.profile_updated',
      'agent.policy_changed',
      'agent.credential_rotated',
      'agent.credential_revoked',
    ]) {
      assert.ok(types.includes(expected), `missing audit event ${expected}`);
    }
    assert.ok(state.audits.every((item) => !item.metadata_json.includes('secret')));
  });

  test('CSRF and exact Origin are mandatory and logout revokes immediately', async () => {
    const flow = await startOAuth(NOW + 40);
    const login = await callback('owner', flow, NOW + 41);
    const cookies = cookieValues(login);

    const noCsrf = await postJson('/v1/auth/logout', {}, {
      cookie: cookieHeader(cookies),
      origin: ORIGIN,
    }, NOW + 42);
    assert.equal(noCsrf.status, 403);

    const wrongOrigin = authenticatedHeaders(cookies, true);
    wrongOrigin.set('origin', 'https://evil.example');
    const rejected = await postJson('/v1/auth/logout', {}, wrongOrigin, NOW + 43);
    assert.equal(rejected.status, 403);

    const logout = await postJson('/v1/auth/logout', {}, authenticatedHeaders(cookies, true), NOW + 44);
    assert.equal(logout.status, 200, await logout.clone().text());
    const after = await request('/v1/me', { headers: authenticatedHeaders(cookies) }, NOW + 45);
    assert.equal(after.status, 401);
  });

  test('session activity writes at most once per 15-minute bucket', async () => {
    const login = await callback('owner', await startOAuth(NOW + 50), NOW + 51);
    const cookies = cookieValues(login);
    const parsed = parseOpaqueToken(cookies.get(SESSION_COOKIE) ?? '');
    assert.ok(parsed);

    await request('/v1/me', { headers: authenticatedHeaders(cookies) }, NOW + 51 + SESSION_ACTIVITY_BUCKET_MS - 1);
    let rowResponse = await postJson('/__test/session', { id: parsed.selector }, {}, NOW + 52);
    let row = await rowResponse.json() as { row: { last_seen_at: number } };
    assert.equal(row.row.last_seen_at, NOW + 51);

    const touchAt = NOW + 51 + SESSION_ACTIVITY_BUCKET_MS;
    await request('/v1/me', { headers: authenticatedHeaders(cookies) }, touchAt);
    rowResponse = await postJson('/__test/session', { id: parsed.selector }, {}, touchAt);
    row = await rowResponse.json() as { row: { last_seen_at: number } };
    assert.equal(row.row.last_seen_at, touchAt);

    const absoluteExpiry = NOW + 51 + 30 * 24 * 60 * 60 * 1000;
    const expired = await request('/v1/me', { headers: authenticatedHeaders(cookies) }, absoluteExpiry);
    assert.equal(expired.status, 401);
  });

  test('daily cleanup retains referenced media idempotency while removing other expired rows', async () => {
    const cleanupAt = NOW + 62 * 24 * 60 * 60 * 1000;
    await postJson('/__test/seed-idempotency', { id: 'cleanup-key' }, {}, cleanupAt);
    const referencedSeed = await postJson('/__test/seed-referenced-idempotency', {
      id: 'cleanup-referenced-key',
    }, {}, cleanupAt);
    assert.equal(referencedSeed.status, 200, await referencedSeed.clone().text());
    assert.equal((await referencedSeed.json() as { idempotencyId: string }).idempotencyId,
      'cleanup-referenced-key');
    const beforeResponse = await postJson('/__test/state', {}, {}, cleanupAt);
    const before = await beforeResponse.json() as {
      counts: { audit_events: number; idempotency_keys: number };
    };
    const result = await postJson('/__test/cleanup', {}, {}, cleanupAt);
    assert.equal(result.status, 200);
    const body = await result.json() as {
      oauthFlows: number;
      sessions: number;
      idempotencyKeys: number;
    };
    assert.ok(body.oauthFlows > 0);
    assert.ok(body.sessions > 0);
    assert.ok(before.counts.idempotency_keys > 0);
    assert.equal(body.idempotencyKeys, before.counts.idempotency_keys - 1);
    const afterResponse = await postJson('/__test/state', {}, {}, cleanupAt);
    const after = await afterResponse.json() as {
      counts: { audit_events: number; idempotency_keys: number };
    };
    assert.equal(after.counts.idempotency_keys, 1);
    assert.equal(after.counts.audit_events, before.counts.audit_events);
    /* Giriş izi bu tarihte HENÜZ silinmemeli. Yukarıdaki temizlik iki aylık
     * bir noktada çalışıyor; iz bir yıl duruyor. Burada düşerse saklama
     * süresi sessizce kısalmış demektir ve gizlilik metni yalan söyler. */
    assert.ok(
      queryDatabase<{ total: number }>('SELECT COUNT(*) AS total FROM account_sign_in_events')[0].total > 0,
      'giriş izi bir yıl dolmadan siliniyor',
    );
  });

  test('sign-in traces are deleted once the one-year retention passes', async () => {
    /* Gizlilik metnindeki "bir yıl" cümlesi bu silmenin çalışmasına
     * dayanıyor. Saklama süresi bir vaat: yazıp uygulamamak, hiç
     * yazmamaktan kötü. */
    const before = queryDatabase<{ total: number }>(
      'SELECT COUNT(*) AS total FROM account_sign_in_events',
    )[0].total;
    assert.ok(before > 0, 'iz tablosu zaten boş: bu test hiçbir şey ölçmüyor');

    const cleanupAt = NOW + 366 * 24 * 60 * 60 * 1000;
    const result = await postJson('/__test/cleanup', {}, {}, cleanupAt);
    assert.equal(result.status, 200);
    const body = await result.json() as { signInEvents: number };
    assert.equal(body.signInEvents, before, 'temizlik sildiği iz sayısını doğru bildirmiyor');

    assert.equal(
      queryDatabase<{ total: number }>('SELECT COUNT(*) AS total FROM account_sign_in_events')[0].total,
      0,
      'bir yılı geçen giriş izi hâlâ duruyor',
    );
  });

  /* Paketin başındaki `ownerCookies` bu noktada artık geçerli değil: çıkış
   * testi o oturumu bilerek iptal ediyor. Buradaki testler kendi taze
   * oturumunu açıyor — bir öncekinin artığına yaslanmak, sıraları değiştiği
   * gün sessizce bozulacak bir bağımlılık olurdu. */
  async function ownerSession(now: number): Promise<Map<string, string>> {
    const response = await callback('owner', await startOAuth(now - 1), now);
    assert.equal(response.status, 302, await response.clone().text());
    return cookieValues(response);
  }

  /* Kayıt hız tavanı. Bu testler davet kapısı KAPALIYKEN de anlamlı, ama asıl
   * sebepleri kapının açılacağı gün: o gün kayıt hacmini bir insanın kararı
   * değil internet belirleyecek. */
  test('one connection can open a handful of accounts, then the door closes for that connection only', async () => {
    const BUSY = '203.0.113.90';
    for (let index = 0; index < REGISTRATION_IP_MAX; index += 1) {
      const opened = await callback(
        `crowd-${index}`,
        await startOAuth(NOW + 400 + index * 2),
        NOW + 401 + index * 2,
        BUSY,
        'true',
      );
      assert.equal(opened.status, 302, `${index + 1}. kayıt reddedildi: ${await opened.clone().text()}`);
    }

    const blocked = await callback(
      `crowd-${REGISTRATION_IP_MAX}`,
      await startOAuth(NOW + 440),
      NOW + 441,
      BUSY,
      'true',
    );
    assert.equal(blocked.status, 429, 'aynı bağlantı tavandan sonra da hesap açabiliyor');
    const page = await blocked.text();
    /* Cevap bir tarayıcıya gidiyor. JSON dönmek, giriş yapmaya çalışan
       birine süslü parantezler göstermek olurdu. */
    assert.match(blocked.headers.get('content-type') ?? '', /text\/html/u);
    assert.match(page, /Şu an yeni kayıt alamıyoruz/u, 'insana bakan bir hata sayfası dönmüyor');
    assert.equal(blocked.headers.get('cache-control'), 'no-store', 'geçici bir engel önbelleğe giriyor');

    /* Tavan BAĞLANTIYA ait, platforma değil. Bu satır olmasaydı, herkesin
       kaydını kapatan bir tavanı yanlışlıkla kurmuş olabilirdim ve testler
       yine yeşil görünürdü. */
    const elsewhere = await callback(
      `crowd-${REGISTRATION_IP_MAX + 1}`,
      await startOAuth(NOW + 450),
      NOW + 451,
      '203.0.113.91',
      'true',
    );
    assert.equal(elsewhere.status, 302, 'bir bağlantının tavanı başka bağlantıyı da kapatmış');

  });

  /* Kayıt freni. Davet sistemi kalktı ve geriye tek bir anahtar kaldı: bir
     kötüye kullanım dalgasında yeni kayıtları tamamen durdurabilmek.
     Kapatmanın mevcut hesapların girişini etkilememesi de aynı derecede
     önemli — kapıyı kapatmak, içeridekileri dışarı atmak değil. */
  test('the registration brake stops new accounts without locking out the people already inside', async () => {
    const closed = await callback(
      'crowd-40',
      await startOAuth(NOW + 500),
      NOW + 501,
      '203.0.113.100',
      'false',
    );
    assert.equal(closed.status, 403, 'fren çekiliyken yeni kayıt geçmiş');
    assert.match(await closed.text(), /Yeni kayıtlar geçici olarak durduruldu/u);

    const opened = await callback(
      'crowd-40',
      await startOAuth(NOW + 502),
      NOW + 503,
      '203.0.113.100',
      'true',
    );
    assert.equal(opened.status, 302, `fren açıkken kayıt reddedildi: ${await opened.clone().text()}`);

    const me = await (await request('/v1/me', {
      headers: authenticatedHeaders(cookieValues(opened)),
    }, NOW + 504)).json() as { account: { id: string; agentQuota: number } };
    assert.equal(me.account.agentQuota, DEFAULT_AGENT_QUOTA, 'kayıt varsayılan ajan hakkını almamış');

    /* Fren yalnız YENİ hesabı durduruyor. Az önce açılan hesap, fren geri
       çekildiğinde de girebilmeli. */
    const returning = await callback(
      'crowd-40',
      await startOAuth(NOW + 505),
      NOW + 506,
      '203.0.113.100',
      'false',
    );
    assert.equal(returning.status, 302, 'fren mevcut hesabın girişini de kapatmış');
  });

  /* Sözleşme onayı. Kutu tarayıcıda; kapı sunucuda. Bu testler ikisinin
     birbirine bağlı olduğunu değil, KAPININ tek başına tuttuğunu ölçüyor —
     tarayıcıyı atlayan bir istekle. */
  test('no consent, no sign-in: the door refuses before GitHub is ever contacted', async () => {
    const unchecked = await postJson('/v1/auth/github/start', {}, { origin: ORIGIN }, NOW + 520);
    assert.equal(unchecked.status, 400, 'onaysız akış kurulabiliyor');
    assert.equal(
      (await unchecked.json() as { error: { code: string } }).error.code,
      'terms_not_accepted',
    );

    const refused = await postJson('/v1/auth/github/start', {
      acceptedTerms: false,
      termsVersion: LEGAL_LAST_UPDATED,
    }, { origin: ORIGIN }, NOW + 521);
    assert.equal(refused.status, 400, 'açıkça reddedilen onay kabul edilmiş');

    /* Eski bir sürümü onaylamak da geçmiyor. Sayfa saatlerdir açık durup
       metin bu arada değişmiş olabilir; kişinin ekranında gördüğü metin ile
       kaydettiğimiz sürüm aynı olmak zorunda. */
    const stale = await postJson('/v1/auth/github/start', {
      acceptedTerms: true,
      termsVersion: '2020-01-01',
    }, { origin: ORIGIN }, NOW + 522);
    assert.equal(stale.status, 409, 'eski sürüm onayı kabul edilmiş');
  });

  test('consent is written on registration and refreshed on every later sign-in', async () => {
    const registration = await callback(
      'crowd-50',
      await startOAuth(NOW + 530),
      NOW + 531,
      '203.0.113.120',
      'true',
    );
    assert.equal(registration.status, 302, await registration.clone().text());
    const me = await (await request('/v1/me', {
      headers: authenticatedHeaders(cookieValues(registration)),
    }, NOW + 532)).json() as { account: { id: string } };

    const first = queryDatabase<{ terms_accepted_at: number | null; terms_version: string | null }>(
      `SELECT terms_accepted_at, terms_version FROM accounts WHERE id = '${me.account.id}'`,
    )[0];
    assert.equal(first.terms_accepted_at, NOW + 530, 'kayıt anındaki onay yazılmamış');
    assert.equal(first.terms_version, LEGAL_LAST_UPDATED, 'onaylanan metnin sürümü yazılmamış');

    const relogin = await callback(
      'crowd-50',
      await startOAuth(NOW + 540),
      NOW + 541,
      '203.0.113.120',
      'true',
    );
    assert.equal(relogin.status, 302, await relogin.clone().text());
    const second = queryDatabase<{ terms_accepted_at: number | null }>(
      `SELECT terms_accepted_at FROM accounts WHERE id = '${me.account.id}'`,
    )[0];
    assert.equal(
      second.terms_accepted_at,
      NOW + 540,
      'sonraki girişte onay tazelenmemiş: kayıt "bir zamanlar kabul etmişti" demeye devam ediyor',
    );
  });
});