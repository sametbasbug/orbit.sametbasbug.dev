import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, hmacDigest, randomBase64Url } from '../src/server/identity/tokens';
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from '../src/server/identity/constants';

const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const SERVICE = 'staging.orbit.sametbasbug';
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const CONFIG = 'wrangler.staging.jsonc';
const DATABASE = 'DB';

function keychain(name: string): string {
  const result = spawnSync('security', ['find-generic-password','-s',SERVICE,'-a',name,'-w'], {
    encoding: 'utf8', stdio: ['ignore','pipe','ignore'],
  });
  assert.equal(result.status, 0, `Missing staging binding: ${name}`);
  return result.stdout.trim();
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [
    WRANGLER,'d1','execute',DATABASE,'--remote','--config',CONFIG,'--command',sql,'--json',
  ], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  assert.equal(result.status, 0, 'Remote D1 command failed.');
  const parsed = JSON.parse(result.stdout) as Array<{ success: boolean; results?: Array<Record<string, unknown>> }>;
  assert.ok(parsed.every((item) => item.success));
  return parsed.flatMap((item) => item.results ?? []);
}

async function waitReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${ORIGIN}/v1/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (response.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail('Slice 4 deployment readiness timeout.');
}

async function seedAgent(
  ownerId: string,
  handle: string,
  mode: 'direct_publish' | 'approval_required' | 'read_only',
  pepper: string,
  now: number,
) {
  const agentId = createEntityId();
  const credential = await createOpaqueToken('agent', pepper);
  execute(`
    INSERT INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at, version,
      role, short_bio, motto, accent, responsibility, links_json
    ) VALUES (
      ${quote(agentId)}, ${quote(handle)}, ${quote(handle)}, ${quote(handle)}, '',
      'agents/default.webp', ${quote(mode)}, 'active', ${now}, ${now}, 1,
      '', '', '', '#6f63e8', '', '[]'
    );
    INSERT INTO agent_memberships (
      id, agent_id, account_id, role, created_by_account_id, created_at
    ) VALUES (
      ${quote(createEntityId())}, ${quote(agentId)}, ${quote(ownerId)},
      'primary_sponsor', ${quote(ownerId)}, ${now}
    );
    INSERT INTO agent_credentials (
      id, agent_id, secret_digest, hash_version, scopes,
      created_by_account_id, created_at
    ) VALUES (
      ${quote(credential.selector)}, ${quote(agentId)}, ${quote(credential.digest)},
      ${credential.hashVersion}, 'feed:read records:write', ${quote(ownerId)}, ${now}
    )
  `);
  return { id: agentId, token: credential.token, credentialId: credential.selector };
}

async function ownerSession(ownerId: string, sessionPepper: string, csrfPepper: string, now: number) {
  const session = await createOpaqueToken('session', sessionPepper);
  const csrf = randomBase64Url(32);
  const digest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${csrf}`, csrfPepper);
  execute(`
    INSERT INTO sessions (
      id, account_id, secret_digest, hash_version, csrf_digest,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      ${quote(session.selector)}, ${quote(ownerId)}, ${quote(session.digest)},
      ${session.hashVersion}, ${quote(digest)}, ${now}, ${now},
      ${now + SESSION_IDLE_TTL_MS}, ${now + SESSION_ABSOLUTE_TTL_MS}
    )
  `);
  return { token: session.token, csrf, id: session.selector };
}

async function agentWrite(token: string, path: string, body: Record<string, unknown>, key: string, method = 'POST') {
  return await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
}

async function ownerRequest(
  session: { token: string; csrf: string },
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  key?: string,
) {
  const headers: Record<string, string> = {
    cookie: `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${session.csrf}`,
  };
  if (method !== 'GET') {
    headers.origin = ORIGIN;
    headers['x-orbit-csrf'] = session.csrf;
    headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
  }
  return await fetch(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

await waitReady();
const now = Date.now();
const suffix = now.toString(36);
const agentPepper = keychain('ORBIT_AGENT_CREDENTIAL_PEPPER_V1');
const sessionPepper = keychain('ORBIT_SESSION_PEPPER_V1');
const csrfPepper = keychain('ORBIT_CSRF_PEPPER_V1');
const owner = execute(`
  SELECT a.id FROM accounts a JOIN auth_identities ai ON ai.account_id = a.id
  WHERE ai.provider = 'github' AND ai.provider_user_id = '126420524' LIMIT 1
`)[0]?.id;
assert.equal(typeof owner, 'string');
const ownerId = String(owner);
const direct = await seedAgent(ownerId, `slice4-direct-${suffix}`, 'direct_publish', agentPepper, now);
const approval = await seedAgent(ownerId, `slice4-review-${suffix}`, 'approval_required', agentPepper, now + 1);
const readonly = await seedAgent(ownerId, `slice4-readonly-${suffix}`, 'read_only', agentPepper, now + 2);
const concurrentDirect = await seedAgent(ownerId, `slice4-concurrent-${suffix}`, 'direct_publish', agentPepper, now + 3);
const concurrentReview = await seedAgent(ownerId, `slice4-concurrent-review-${suffix}`, 'approval_required', agentPepper, now + 4);
const session = await ownerSession(ownerId, sessionPepper, csrfPepper, now + 3);
const createdRecordIds: string[] = [];
const cleanupRecordIds: string[] = [];

const directResponse = await agentWrite(direct.token, '/v1/records', {
  bodyMarkdown: 'Staging Slice 4 doğrudan yayın provası.',
  projectSlug: 'orbit', topicSlugs: ['sistemler'],
}, `slice4-${suffix}-direct`);
assert.equal(directResponse.status, 201);
const directBody = await directResponse.json() as { record: { id: string; slug: string } };
createdRecordIds.push(directBody.record.id);
cleanupRecordIds.push(directBody.record.id);
assert.equal((await fetch(`${ORIGIN}/v1/records/${directBody.record.id}`)).status, 200);

const replay = await agentWrite(direct.token, '/v1/records', {
  bodyMarkdown: 'Staging Slice 4 doğrudan yayın provası.',
  projectSlug: 'orbit', topicSlugs: ['sistemler'],
}, `slice4-${suffix}-direct`);
assert.equal(replay.status, 201);
assert.equal(replay.headers.get('idempotency-replayed'), 'true');

const reply = await agentWrite(direct.token, `/v1/records/${directBody.record.id}/replies`, {
  bodyMarkdown: 'Staging reply kökünü sunucudan alıyor.',
}, `slice4-${suffix}-reply`);
assert.equal(reply.status, 201);
const replyBody = await reply.json() as { record: { id: string; parentId: string; rootId: string } };
createdRecordIds.push(replyBody.record.id);
cleanupRecordIds.push(replyBody.record.id);
assert.equal(replyBody.record.parentId, directBody.record.id);
assert.equal(replyBody.record.rootId, directBody.record.id);

const pending = await agentWrite(approval.token, '/v1/records', {
  bodyMarkdown: 'Staging sponsor onayı bekleyen kayıt.', topicSlugs: ['orbit'],
}, `slice4-${suffix}-pending`);
assert.equal(pending.status, 202);
const pendingBody = await pending.json() as { record: { id: string } };
createdRecordIds.push(pendingBody.record.id);
cleanupRecordIds.push(pendingBody.record.id);
assert.equal((await fetch(`${ORIGIN}/v1/records/${pendingBody.record.id}`)).status, 404);
const queue = await ownerRequest(session, '/v1/approvals').then((response) => response.json()) as {
  reviews: Array<{ id: string; record: { id: string } }>;
};
const review = queue.reviews.find((item) => item.record.id === pendingBody.record.id);
assert.ok(review);
assert.equal((await ownerRequest(session, `/v1/approvals/${review.id}/approve`, 'POST', {
  note: 'Staging approval.',
}, `slice4-${suffix}-approve`)).status, 200);
assert.equal((await fetch(`${ORIGIN}/v1/records/${pendingBody.record.id}`)).status, 200);

const edit = await agentWrite(approval.token, `/v1/records/${pendingBody.record.id}`, {
  bodyMarkdown: 'Staging onay bekleyen ikinci revision.',
}, `slice4-${suffix}-edit`, 'PATCH');
assert.equal(edit.status, 202);
const oldDetail = await fetch(`${ORIGIN}/v1/records/${pendingBody.record.id}`).then((response) => response.text());
assert.ok(!oldDetail.includes('ikinci revision'));
const editQueue = await ownerRequest(session, '/v1/approvals').then((response) => response.json()) as {
  reviews: Array<{ id: string; record: { id: string } }>;
};
const editReview = editQueue.reviews.find((item) => item.record.id === pendingBody.record.id);
assert.ok(editReview);
assert.equal((await ownerRequest(session, `/v1/approvals/${editReview.id}/approve`, 'POST', {}, `slice4-${suffix}-edit-approve`)).status, 200);
assert.ok((await fetch(`${ORIGIN}/v1/records/${pendingBody.record.id}`).then((response) => response.text())).includes('ikinci revision'));

assert.equal((await agentWrite(readonly.token, '/v1/records', {
  bodyMarkdown: 'Bu yazma reddedilmeli.',
}, `slice4-${suffix}-readonly`)).status, 403);

const pair = async (operation: () => Promise<Response>, expectedStatus: number) => {
  const responses = await Promise.all([operation(), operation()]);
  assert.deepEqual(responses.map((response) => response.status), [expectedStatus, expectedStatus]);
  assert.equal(responses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(bodies[0], bodies[1]);
  return bodies[0] as { record?: { id: string }; review?: { id: string } };
};

const concurrentPost = await pair(() => agentWrite(concurrentDirect.token, '/v1/records', {
  bodyMarkdown: `Staging paralel idempotency gönderisi ${suffix}.`, topicSlugs: ['orbit'],
}, `slice4-${suffix}-concurrent-post`), 201);
const concurrentPostId = concurrentPost.record!.id;
createdRecordIds.push(concurrentPostId);
cleanupRecordIds.push(concurrentPostId);
const concurrentReply = await pair(() => agentWrite(
  concurrentDirect.token,
  `/v1/records/${concurrentPostId}/replies`,
  { bodyMarkdown: `Staging paralel idempotency yanıtı ${suffix}.` },
  `slice4-${suffix}-concurrent-reply`,
), 201);
createdRecordIds.push(concurrentReply.record!.id);
cleanupRecordIds.push(concurrentReply.record!.id);
await pair(() => agentWrite(concurrentDirect.token, `/v1/records/${concurrentPostId}`, {
  bodyMarkdown: `Staging paralel idempotency revision ${suffix}.`,
}, `slice4-${suffix}-concurrent-revision`, 'PATCH'), 200);

const slugRace = await Promise.all([
  agentWrite(concurrentDirect.token, '/v1/records', {
    bodyMarkdown: `Staging aynı anda üretilen slug ${suffix}.`,
  }, `slice4-${suffix}-slug-a`),
  agentWrite(concurrentDirect.token, '/v1/records', {
    bodyMarkdown: `Staging aynı anda üretilen slug ${suffix}.`,
  }, `slice4-${suffix}-slug-b`),
]);
assert.deepEqual(slugRace.map((response) => response.status), [201, 201]);
const slugBodies = await Promise.all(slugRace.map((response) => response.json())) as Array<{
  record: { id: string; slug: string };
}>;
assert.notEqual(slugBodies[0].record.slug, slugBodies[1].record.slug);
assert.ok(slugBodies.some((item) => item.record.slug.endsWith(item.record.id.replaceAll('-', '').slice(-12))));
createdRecordIds.push(...slugBodies.map((item) => item.record.id));
cleanupRecordIds.push(...slugBodies.map((item) => item.record.id));

const createPending = async (bodyMarkdown: string, key: string) => {
  const response = await agentWrite(concurrentReview.token, '/v1/records', { bodyMarkdown }, key);
  assert.equal(response.status, 202);
  const body = await response.json() as { record: { id: string } };
  createdRecordIds.push(body.record.id);
  return body.record.id;
};
const reviewFor = async (recordId: string) => {
  const reviews = await ownerRequest(session, '/v1/approvals').then((response) => response.json()) as {
    reviews: Array<{ id: string; record: { id: string } }>;
  };
  const match = reviews.reviews.find((item) => item.record.id === recordId);
  assert.ok(match);
  return match.id;
};
const approveId = await createPending(`Staging paralel onay ${suffix}.`, `slice4-${suffix}-approve-create`);
const approveReview = await reviewFor(approveId);
await pair(() => ownerRequest(session, `/v1/approvals/${approveReview}/approve`, 'POST', {
  note: 'parallel staging approval',
}, `slice4-${suffix}-concurrent-approve`), 200);
cleanupRecordIds.push(approveId);

const rejectId = await createPending(`Staging paralel ret ${suffix}.`, `slice4-${suffix}-reject-create`);
const rejectReview = await reviewFor(rejectId);
await pair(() => ownerRequest(session, `/v1/approvals/${rejectReview}/reject`, 'POST', {
  note: 'parallel staging rejection',
}, `slice4-${suffix}-concurrent-reject`), 200);

const withdrawId = await createPending(`Staging paralel geri çekme ${suffix}.`, `slice4-${suffix}-withdraw-create`);
await pair(() => agentWrite(
  concurrentReview.token,
  `/v1/records/${withdrawId}/withdraw`,
  {},
  `slice4-${suffix}-concurrent-withdraw`,
), 200);

const agentDeleteRecord = await agentWrite(concurrentDirect.token, '/v1/records', {
  bodyMarkdown: `Staging paralel ajan silme ${suffix}.`,
}, `slice4-${suffix}-agent-delete-create`).then((response) => response.json()) as { record: { id: string } };
createdRecordIds.push(agentDeleteRecord.record.id);
await pair(() => agentWrite(
  concurrentDirect.token,
  `/v1/records/${agentDeleteRecord.record.id}/delete`,
  { reason: 'parallel staging agent delete' },
  `slice4-${suffix}-concurrent-agent-delete`,
), 200);

const sponsorDeleteRecord = await agentWrite(concurrentDirect.token, '/v1/records', {
  bodyMarkdown: `Staging paralel sponsor silme ${suffix}.`,
}, `slice4-${suffix}-sponsor-delete-create`).then((response) => response.json()) as { record: { id: string } };
createdRecordIds.push(sponsorDeleteRecord.record.id);
await pair(() => ownerRequest(
  session,
  `/v1/manage/records/${sponsorDeleteRecord.record.id}/delete`,
  'POST',
  { reason: 'parallel staging sponsor delete' },
  `slice4-${suffix}-concurrent-sponsor-delete`,
), 200);

const evidence = execute(`
  SELECT
    (SELECT COUNT(*) FROM records WHERE id IN (${createdRecordIds.map(quote).join(',')})) AS records,
    (SELECT COUNT(*) FROM audit_events WHERE subject_type = 'record' AND subject_id IN (${createdRecordIds.map(quote).join(',')})) AS audits,
    (SELECT COUNT(*) FROM idempotency_keys WHERE
      (principal_type = 'agent' AND principal_id IN (${quote(direct.id)}, ${quote(approval.id)}, ${quote(concurrentDirect.id)}, ${quote(concurrentReview.id)}))
      OR (principal_type = 'account' AND principal_id = ${quote(ownerId)})
    ) AS idempotency_rows
`)[0] as { records: number; audits: number; idempotency_rows: number };
assert.equal(Number(evidence.records), createdRecordIds.length);
assert.ok(Number(evidence.audits) >= 15);
assert.ok(Number(evidence.idempotency_rows) >= 15);

for (const recordId of cleanupRecordIds) {
  const ownerDelete = await ownerRequest(session, `/v1/manage/records/${recordId}/delete`, 'POST', {
    reason: 'Slice 4 staging cleanup.',
  }, `slice4-${suffix}-delete-${recordId}`);
  assert.equal(ownerDelete.status, 200);
}
execute(`
  UPDATE agent_credentials SET revoked_at = ${Date.now()}, revoked_reason = 'staging_test_cleanup'
  WHERE id IN (${quote(direct.credentialId)}, ${quote(approval.credentialId)}, ${quote(readonly.credentialId)},
    ${quote(concurrentDirect.credentialId)}, ${quote(concurrentReview.credentialId)});
  UPDATE agents SET status = 'retired', updated_at = ${Date.now()}
  WHERE id IN (${quote(direct.id)}, ${quote(approval.id)}, ${quote(readonly.id)},
    ${quote(concurrentDirect.id)}, ${quote(concurrentReview.id)});
  UPDATE sessions SET revoked_at = ${Date.now()}, revoked_reason = 'staging_test_cleanup'
  WHERE id = ${quote(session.id)}
`);

process.stdout.write(JSON.stringify({
  ok: true,
  runId: createEntityId(),
  publication: 'pass', replyRoot: 'pass', approval: 'pass', revision: 'pass',
  idempotency: 'concurrent-pass', slugRace: 'suffix-pass', readOnly: 'pass', cleanup: 'soft-delete',
}));
