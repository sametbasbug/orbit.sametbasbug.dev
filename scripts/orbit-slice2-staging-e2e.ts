import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from '../src/server/identity/constants';
import {
  createOpaqueToken,
  hmacDigest,
  parseOpaqueToken,
  randomBase64Url,
} from '../src/server/identity/tokens';
import { createEntityId } from '../src/server/foundation/ids';

const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const KEYCHAIN_SERVICE = 'staging.orbit.sametbasbug';
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const CONFIG = 'wrangler.staging.jsonc';
const DATABASE = 'DB';

interface BrowserSession {
  token: string;
  csrf: string;
}

function readKeychain(binding: string): string {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', binding,
    '-w',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 0, `Missing staging Keychain binding: ${binding}`);
  const value = result.stdout.trim();
  assert.ok(value, `Empty staging Keychain binding: ${binding}`);
  return value;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function executeD1(sql: string): unknown[] {
  const result = spawnSync(process.execPath, [
    WRANGLER,
    'd1',
    'execute',
    DATABASE,
    '--remote',
    '--config',
    CONFIG,
    '--command',
    sql,
    '--json',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, 'Remote D1 command failed.');
  const parsed = JSON.parse(result.stdout) as Array<{ success: boolean; results?: unknown[] }>;
  assert.ok(parsed.every((item) => item.success), 'Remote D1 command was not successful.');
  return parsed.flatMap((item) => item.results ?? []);
}

async function createBrowserSession(
  accountId: string,
  sessionPepper: string,
  csrfPepper: string,
  now: number,
): Promise<BrowserSession> {
  const session = await createOpaqueToken('session', sessionPepper);
  const csrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${csrf}`, csrfPepper);
  executeD1(`
    INSERT INTO sessions (
      id, account_id, secret_digest, hash_version, csrf_digest,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      ${quote(session.selector)}, ${quote(accountId)}, ${quote(session.digest)}, ${session.hashVersion},
      ${quote(csrfDigest)}, ${now}, ${now}, ${now + SESSION_IDLE_TTL_MS},
      ${now + SESSION_ABSOLUTE_TTL_MS}
    )
  `);
  return { token: session.token, csrf };
}

async function seedSponsor(
  ownerAccountId: string,
  ordinal: string,
  sessionPepper: string,
  csrfPepper: string,
  now: number,
): Promise<{ accountId: string; session: BrowserSession }> {
  const accountId = createEntityId();
  const roleId = createEntityId();
  const handle = `slice2-sponsor-${ordinal}`;
  executeD1(`
    PRAGMA foreign_keys = ON;
    INSERT INTO accounts (
      id, handle, handle_normalized, display_name, avatar_url,
      status, created_at, updated_at, last_login_at
    ) VALUES (
      ${quote(accountId)}, ${quote(handle)}, ${quote(handle)}, 'Slice 2 Staging Sponsor', NULL,
      'active', ${now}, ${now}, ${now}
    );
    INSERT INTO account_roles (
      id, account_id, role, granted_by_account_id, granted_at
    ) VALUES (
      ${quote(roleId)}, ${quote(accountId)}, 'member', ${quote(ownerAccountId)}, ${now}
    );
    INSERT INTO account_quotas (
      account_id, quota_key, limit_value, updated_by_account_id, updated_at
    ) VALUES (
      ${quote(accountId)}, 'agents.max_active', 1, ${quote(ownerAccountId)}, ${now}
    )
  `);
  return {
    accountId,
    session: await createBrowserSession(accountId, sessionPepper, csrfPepper, now),
  };
}

function authHeaders(session: BrowserSession, mutation = false): Headers {
  const headers = new Headers({
    accept: 'application/json',
    cookie: `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${session.csrf}`,
  });
  if (mutation) {
    headers.set('content-type', 'application/json');
    headers.set('origin', ORIGIN);
    headers.set('X-Orbit-CSRF', session.csrf);
  }
  return headers;
}

async function api(
  method: string,
  pathname: string,
  session: BrowserSession,
  body?: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers: authHeaders(session, method !== 'GET'),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function waitForSlice2Deployment(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${ORIGIN}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
      },
      body: '{}',
    });
    if (response.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail('Slice 2 deployment did not become ready within 60 seconds.');
}

await waitForSlice2Deployment();

const sessionPepper = readKeychain('ORBIT_SESSION_PEPPER_V1');
const csrfPepper = readKeychain('ORBIT_CSRF_PEPPER_V1');
const now = Date.now();
const runSuffix = now.toString(36);

const ownerRows = executeD1(`
  SELECT a.id
  FROM accounts a
  JOIN auth_identities ai ON ai.account_id = a.id
  WHERE ai.provider = 'github' AND ai.provider_user_id = '126420524'
  LIMIT 1
`) as Array<{ id?: string }>;
const ownerAccountId = ownerRows[0]?.id;
assert.ok(ownerAccountId, 'Staging platform owner identity is missing.');

const sponsor = await seedSponsor(
  ownerAccountId,
  `${runSuffix}-a`,
  sessionPepper,
  csrfPepper,
  now,
);
const otherSponsor = await seedSponsor(
  ownerAccountId,
  `${runSuffix}-b`,
  sessionPepper,
  csrfPepper,
  now + 1,
);
const ownerSession = await createBrowserSession(
  ownerAccountId,
  sessionPepper,
  csrfPepper,
  now + 2,
);

const missingCsrf = await fetch(`${ORIGIN}/v1/agents`, {
  method: 'POST',
  headers: new Headers({
    'content-type': 'application/json',
    cookie: `__Host-orbit_session=${sponsor.session.token}; __Host-orbit_csrf=${sponsor.session.csrf}`,
    origin: ORIGIN,
  }),
  body: JSON.stringify({
    handle: `slice2-${runSuffix}`,
    displayName: 'Slice 2 Staging Agent',
    bio: 'Disposable staging verification agent.',
  }),
});
assert.equal(missingCsrf.status, 403);

const wrongOrigin = await fetch(`${ORIGIN}/v1/agents`, {
  method: 'POST',
  headers: new Headers({
    'content-type': 'application/json',
    cookie: `__Host-orbit_session=${sponsor.session.token}; __Host-orbit_csrf=${sponsor.session.csrf}`,
    origin: 'https://evil.example',
    'X-Orbit-CSRF': sponsor.session.csrf,
  }),
  body: JSON.stringify({
    handle: `slice2-${runSuffix}`,
    displayName: 'Slice 2 Staging Agent',
    bio: 'Disposable staging verification agent.',
  }),
});
assert.equal(wrongOrigin.status, 403);

const handle = `slice2-${runSuffix}`;
const created = await api('POST', '/v1/agents', sponsor.session, {
  handle,
  displayName: 'Slice 2 Staging Agent',
  bio: 'Disposable staging verification agent.',
});
assert.equal(created.status, 201);
const createdBody = await json<{ agent: { id: string; publicationMode: string; status: string } }>(created);
const agentId = createdBody.agent.id;
assert.equal(createdBody.agent.publicationMode, 'approval_required');
assert.equal(createdBody.agent.status, 'active');

const quotaResponse = await api('POST', '/v1/agents', sponsor.session, {
  handle: `slice2-second-${runSuffix}`,
  displayName: 'Forbidden Second Agent',
  bio: '',
});
assert.equal(quotaResponse.status, 409);

const publicProfile = await fetch(`${ORIGIN}/v1/agents/${handle}`);
assert.equal(publicProfile.status, 200);
assert.ok(!(await publicProfile.text()).includes('primarySponsorAccountId'));

const managedProfile = await api('GET', `/v1/agents/${agentId}/manage`, sponsor.session);
assert.equal(managedProfile.status, 200);
const managedText = await managedProfile.text();
assert.ok(!managedText.includes('secret'));
assert.ok(!managedText.includes('orb_agent_v1_'));

const profileUpdate = await api('PATCH', `/v1/agents/${agentId}`, sponsor.session, {
  displayName: 'Slice 2 Staging Agent Revised',
  bio: 'Only sponsor-editable profile fields changed.',
});
assert.equal(profileUpdate.status, 200);

for (const forbidden of [
  { handle: 'forbidden-handle' },
  { publicationMode: 'direct_publish' },
  { primarySponsorAccountId: otherSponsor.accountId },
  { agentQuota: 99 },
  { status: 'suspended' },
]) {
  const response = await api('PATCH', `/v1/agents/${agentId}`, sponsor.session, forbidden);
  assert.equal(response.status, 400);
}

const foreignRead = await api('GET', `/v1/agents/${agentId}/manage`, otherSponsor.session);
assert.equal(foreignRead.status, 404);
const foreignWrite = await api('PATCH', `/v1/agents/${agentId}`, otherSponsor.session, {
  displayName: 'Ownership bypass',
});
assert.equal(foreignWrite.status, 404);

const sponsorPolicy = await api('PATCH', `/v1/admin/agents/${agentId}/policy`, sponsor.session, {
  publicationMode: 'direct_publish',
});
assert.equal(sponsorPolicy.status, 403);

for (const publicationMode of ['read_only', 'direct_publish', 'approval_required']) {
  const policy = await api('PATCH', `/v1/admin/agents/${agentId}/policy`, ownerSession, {
    publicationMode,
  });
  assert.equal(policy.status, 200);
  const body = await json<{ agent: { publicationMode: string } }>(policy);
  assert.equal(body.agent.publicationMode, publicationMode);
}

const issued = await api('POST', `/v1/agents/${agentId}/credentials/rotate`, sponsor.session, {});
assert.equal(issued.status, 201);
assert.equal(issued.headers.get('cache-control'), 'no-store');
const issuedBody = await json<{ credential: { id: string; token?: string; scopes: string[] } }>(issued);
const firstCredentialId = issuedBody.credential.id;
assert.equal(parseOpaqueToken(issuedBody.credential.token ?? '')?.family, 'agent', 'Credential token contract failed.');
assert.deepEqual(issuedBody.credential.scopes, ['feed:read', 'records:write']);
delete issuedBody.credential.token;

const staleRotation = await api('POST', `/v1/agents/${agentId}/credentials/rotate`, sponsor.session, {
  expectedCredentialId: 'stale-credential',
});
assert.equal(staleRotation.status, 409);

const rotated = await api('POST', `/v1/agents/${agentId}/credentials/rotate`, sponsor.session, {
  expectedCredentialId: firstCredentialId,
});
assert.equal(rotated.status, 201);
assert.equal(rotated.headers.get('cache-control'), 'no-store');
const rotatedBody = await json<{ credential: { id: string; token?: string } }>(rotated);
const replacementCredentialId = rotatedBody.credential.id;
assert.notEqual(replacementCredentialId, firstCredentialId);
assert.equal(parseOpaqueToken(rotatedBody.credential.token ?? '')?.family, 'agent', 'Credential token contract failed.');
delete rotatedBody.credential.token;

const afterRotation = await api('GET', `/v1/agents/${agentId}/manage`, sponsor.session);
assert.equal(afterRotation.status, 200);
const afterRotationText = await afterRotation.text();
assert.ok(!afterRotationText.includes('orb_agent_v1_'));
const afterRotationBody = JSON.parse(afterRotationText) as { agent: { activeCredential: { id: string } | null } };
assert.equal(afterRotationBody.agent.activeCredential?.id, replacementCredentialId);

const recovered = await api('POST', `/v1/agents/${agentId}/credentials/rotate`, sponsor.session, {
  expectedCredentialId: afterRotationBody.agent.activeCredential?.id,
});
assert.equal(recovered.status, 201);
const recoveredBody = await json<{ credential: { id: string; token?: string } }>(recovered);
const recoveredCredentialId = recoveredBody.credential.id;
assert.equal(parseOpaqueToken(recoveredBody.credential.token ?? '')?.family, 'agent', 'Credential token contract failed.');
delete recoveredBody.credential.token;

const revoked = await api('POST', `/v1/agents/${agentId}/credentials/revoke`, sponsor.session, {
  expectedCredentialId: recoveredCredentialId,
});
assert.equal(revoked.status, 200);
const repeatedRevoke = await api('POST', `/v1/agents/${agentId}/credentials/revoke`, sponsor.session, {
  expectedCredentialId: recoveredCredentialId,
});
assert.equal(repeatedRevoke.status, 409);

const credentialRows = executeD1(`
  SELECT id, revoked_reason, replaced_by_credential_id,
         CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END AS is_active
  FROM agent_credentials
  WHERE agent_id = ${quote(agentId)}
  ORDER BY created_at, id
`) as Array<{
  id: string;
  revoked_reason: string | null;
  replaced_by_credential_id: string | null;
  is_active: number;
}>;
assert.equal(credentialRows.length, 3);
assert.equal(credentialRows.filter((row) => row.is_active === 1).length, 0);
const firstCredential = credentialRows.find((row) => row.id === firstCredentialId);
assert.equal(firstCredential?.revoked_reason, 'rotated');
assert.equal(firstCredential?.replaced_by_credential_id, replacementCredentialId);
const recoveredFromLostResponse = credentialRows.find((row) => row.id === replacementCredentialId);
assert.equal(recoveredFromLostResponse?.revoked_reason, 'rotated');
assert.equal(recoveredFromLostResponse?.replaced_by_credential_id, recoveredCredentialId);

const auditRows = executeD1(`
  SELECT event_type, metadata_json
  FROM audit_events
  WHERE subject_type = 'agent' AND subject_id = ${quote(agentId)}
  ORDER BY created_at, id
`) as Array<{ event_type: string; metadata_json: string }>;
const auditTypes = new Set(auditRows.map((row) => row.event_type));
for (const eventType of [
  'agent.created',
  'agent.profile_updated',
  'agent.policy_changed',
  'agent.credential_issued',
  'agent.credential_rotated',
  'agent.credential_revoked',
]) {
  assert.ok(auditTypes.has(eventType), `Missing staging audit event: ${eventType}`);
}
assert.ok(auditRows.every((row) => !row.metadata_json.includes('orb_agent_v1_')));
assert.ok(auditRows.every((row) => !row.metadata_json.toLowerCase().includes('secret')));

process.stdout.write('Orbit V6 Slice 2 staging E2E: PASS\n');
