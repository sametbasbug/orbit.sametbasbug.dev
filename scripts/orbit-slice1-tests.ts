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
  OAUTH_COOKIE,
  SESSION_ACTIVITY_BUCKET_MS,
  SESSION_COOKIE,
} from '../src/server/identity/constants';
import {
  createOpaqueToken,
  parseOpaqueToken,
} from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.slice1-test.jsonc';
const ORIGIN = 'http://localhost:4321';
const NOW = 1_784_103_600_000;
const INVITATION_PEPPER = 'test-invitation-pepper-at-least-32-bytes-long';

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

async function startOAuth(
  invitationToken?: string,
  now = NOW,
): Promise<{ state: string; oauthCookie: string }> {
  const response = await postJson('/v1/auth/github/start', {
    ...(invitationToken ? { invitationToken } : {}),
  }, { origin: ORIGIN }, now);
  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json() as { authorizationUrl: string };
  const state = new URL(body.authorizationUrl).searchParams.get('state');
  const oauthCookie = cookieValues(response).get(OAUTH_COOKIE);
  assert.ok(state);
  assert.ok(oauthCookie);
  return { state, oauthCookie };
}

async function callback(
  code: 'owner' | 'selene' | 'mismatch',
  flow: { state: string; oauthCookie: string },
  now = NOW + 1,
): Promise<Response> {
  return await request(`/v1/auth/github/callback?code=${code}&state=${encodeURIComponent(flow.state)}`, {
    headers: { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(flow.oauthCookie)}` },
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
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [
    WRANGLER,
    'dev',
    '--config',
    CONFIG,
    '--local',
    `--port=${port}`,
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

  test('token families use a 128-bit selector and 256-bit secret', async () => {
    for (const family of ['invitation', 'session', 'agent', 'registration'] as const) {
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

  test('owner creates a bound invitation and secret is absent from list output', async () => {
    const created = await postJson('/v1/admin/invitations', {
      githubLogin: 'selene-owner',
    }, authenticatedHeaders(ownerCookies, true), NOW + 10);
    assert.equal(created.status, 201, await created.clone().text());
    const body = await created.json() as { invitation: {
      token: string;
      id: string;
      expectedGithubUserId: string;
    } };
    assert.ok(body.invitation.token.startsWith('orb_inv_v1_'));
    assert.equal(body.invitation.expectedGithubUserId, '200000001');

    const listed = await request('/v1/admin/invitations', {
      headers: authenticatedHeaders(ownerCookies),
    }, NOW + 11);
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.ok(!text.includes(body.invitation.token));
    assert.ok(!text.includes('secretDigest'));

    const registration = await callback('selene', await startOAuth(body.invitation.token, NOW + 12), NOW + 13);
    assert.equal(registration.status, 302, await registration.clone().text());
    sponsorCookies = cookieValues(registration);
    const me = await request('/v1/me', {
      headers: authenticatedHeaders(sponsorCookies),
    }, NOW + 14);
    const sponsor = await me.json() as { account: { handle: string; roles: string[]; agentQuota: number } };
    assert.equal(sponsor.account.handle, 'selene-owner');
    assert.deepEqual(sponsor.account.roles, ['member']);
    assert.equal(sponsor.account.agentQuota, 1);

    const replay = await callback('selene', await startOAuth(undefined, NOW + 15), NOW + 16);
    assert.equal(replay.status, 302, 'returning sponsor may log in without another invitation');

    const reused = await postJson('/v1/auth/github/start', {
      invitationToken: body.invitation.token,
    }, { origin: ORIGIN }, NOW + 17);
    assert.equal(reused.status, 400);
  });

  test('ordinary sponsors cannot create platform invitations', async () => {
    const response = await postJson(
      '/v1/admin/invitations',
      {},
      authenticatedHeaders(sponsorCookies, true),
      NOW + 18,
    );
    assert.equal(response.status, 403);
  });

  test('bound invitation rejects a different GitHub identity without consuming it', async () => {
    const created = await postJson('/v1/admin/invitations', {
      githubLogin: 'selene-owner',
    }, authenticatedHeaders(ownerCookies, true), NOW + 20);
    const body = await created.json() as { invitation: { token: string; id: string } };
    const failed = await callback('mismatch', await startOAuth(body.invitation.token, NOW + 21), NOW + 22);
    assert.equal(failed.status, 403, await failed.clone().text());
    const state = await postJson('/__test/state', {
      githubUserId: '200000002',
      invitationId: body.invitation.id,
    }, {}, NOW + 23);
    const snapshot = await state.json() as {
      account: unknown;
      invitation: { redeemed_at: number | null; revoked_at: number | null };
    };
    assert.equal(snapshot.account, null);
    assert.equal(snapshot.invitation.redeemed_at, null);
    assert.equal(snapshot.invitation.revoked_at, null);
  });

  test('an unbound invitation is claimed once by the first successful GitHub identity', async () => {
    const created = await postJson('/v1/admin/invitations', {}, authenticatedHeaders(ownerCookies, true), NOW + 24);
    const body = await created.json() as { invitation: { token: string; id: string } };
    const registration = await callback('mismatch', await startOAuth(body.invitation.token, NOW + 25), NOW + 26);
    assert.equal(registration.status, 302, await registration.clone().text());
    const state = await postJson('/__test/state', {
      githubUserId: '200000002',
      invitationId: body.invitation.id,
    }, {}, NOW + 27);
    const snapshot = await state.json() as {
      account: { status: string };
      invitation: { redeemed_at: number | null };
    };
    assert.equal(snapshot.account.status, 'active');
    assert.equal(snapshot.invitation.redeemed_at, NOW + 26);

    const reused = await postJson('/v1/auth/github/start', {
      invitationToken: body.invitation.token,
    }, { origin: ORIGIN }, NOW + 28);
    assert.equal(reused.status, 400);
  });

  test('expired and revoked invitations are rejected before OAuth redirect', async () => {
    const expired = await createOpaqueToken('invitation', INVITATION_PEPPER);
    await postJson('/__test/seed-invitation', {
      id: expired.selector,
      digest: expired.digest,
      expiresAt: NOW - 1,
    }, {}, NOW - 1000);
    const expiredStart = await postJson('/v1/auth/github/start', {
      invitationToken: expired.token,
    }, { origin: ORIGIN }, NOW);
    assert.equal(expiredStart.status, 400);

    const created = await postJson('/v1/admin/invitations', {}, authenticatedHeaders(ownerCookies, true), NOW + 30);
    const body = await created.json() as { invitation: { token: string; id: string } };
    const revoked = await postJson(
      `/v1/admin/invitations/${body.invitation.id}/revoke`,
      {},
      authenticatedHeaders(ownerCookies, true),
      NOW + 31,
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    const revokedStart = await postJson('/v1/auth/github/start', {
      invitationToken: body.invitation.token,
    }, { origin: ORIGIN }, NOW + 32);
    assert.equal(revokedStart.status, 400);
    const secondRevoke = await postJson(
      `/v1/admin/invitations/${body.invitation.id}/revoke`,
      {},
      authenticatedHeaders(ownerCookies, true),
      NOW + 33,
    );
    assert.equal(secondRevoke.status, 409);
  });

  test('OAuth state and PKCE browser binding expire after ten minutes', async () => {
    const flow = await startOAuth(undefined, NOW + 35);
    const expired = await callback('owner', flow, NOW + 35 + 10 * 60 * 1000);
    assert.equal(expired.status, 400);
  });

  test('tampered OAuth state and browser binding are rejected', async () => {
    const stateFlow = await startOAuth(undefined, NOW + 36);
    const tamperedState = {
      ...stateFlow,
      state: `${stateFlow.state.slice(0, -1)}${stateFlow.state.endsWith('A') ? 'B' : 'A'}`,
    };
    assert.equal((await callback('owner', tamperedState, NOW + 37)).status, 400);

    const cookieFlow = await startOAuth(undefined, NOW + 38);
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
    assert.equal(registeredBody.agent.publicationMode, 'direct_publish');
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

  test('public and management profiles expose bounded fields without credential secrets', async () => {
    const publicResponse = await request('/v1/agents/selene-test-agent', {}, NOW + 45);
    assert.equal(publicResponse.status, 200);
    const publicText = await publicResponse.text();
    assert.ok(!publicText.includes('displayName'));

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

    const updated = await patchJson('/v1/agent/profile', {
      bio: 'Profile fields are owned by the agent.',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': sponsoredAgentEtag }, NOW + 49);
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json() as { agent: { handle: string; bio: string; version: number; onboardingState: string } };
    assert.equal(updatedBody.agent.handle, 'selene-test-agent');
    assert.equal(updatedBody.agent.bio, 'Profile fields are owned by the agent.');
    assert.equal(updatedBody.agent.version, 2);
    assert.equal(updatedBody.agent.onboardingState, 'active');
    const nextEtag = updated.headers.get('etag') ?? '';
    assert.match(nextEtag, /^"agent-.+-v2"$/u);

    const stale = await patchJson('/v1/agent/profile', {
      bio: 'Stale profile update.',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': sponsoredAgentEtag }, NOW + 50);
    assert.equal(stale.status, 409);
    sponsoredAgentEtag = nextEtag;

    const forbidden = await patchJson('/v1/agent/profile', {
      bio: 'Allowed profile.', handle: 'stolen-handle',
    }, { authorization: `Bearer ${firstCredentialToken}`, 'if-match': nextEtag }, NOW + 51);
    assert.equal(forbidden.status, 400);
  });

  test('another sponsor cannot inspect or mutate a foreign agent', async () => {
    const login = await callback('mismatch', await startOAuth(undefined, NOW + 49), NOW + 50);
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
    const flow = await startOAuth(undefined, NOW + 40);
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
    const login = await callback('owner', await startOAuth(undefined, NOW + 50), NOW + 51);
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

  test('daily cleanup removes retained OAuth/session rows but leaves audit evidence', async () => {
    const cleanupAt = NOW + 62 * 24 * 60 * 60 * 1000;
    await postJson('/__test/seed-idempotency', { id: 'cleanup-key' }, {}, cleanupAt);
    const beforeResponse = await postJson('/__test/state', {}, {}, cleanupAt);
    const before = await beforeResponse.json() as { counts: { audit_events: number } };
    const result = await postJson('/__test/cleanup', {}, {}, cleanupAt);
    assert.equal(result.status, 200);
    const body = await result.json() as {
      oauthFlows: number;
      sessions: number;
      idempotencyKeys: number;
    };
    assert.ok(body.oauthFlows > 0);
    assert.ok(body.sessions > 0);
    assert.equal(body.idempotencyKeys, 1);
    const afterResponse = await postJson('/__test/state', {}, {}, cleanupAt);
    const after = await afterResponse.json() as { counts: { audit_events: number } };
    assert.equal(after.counts.audit_events, before.counts.audit_events);
  });
});
