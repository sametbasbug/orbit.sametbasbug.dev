import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, hmacDigest, randomBase64Url, sha256Base64Url } from '../src/server/identity/tokens';
import { canonicalJson } from '../src/server/publication/content';
import {
  encryptDynamicBackup,
  RESTORE_GATE_CLASSIFICATION,
  verifyDynamicBackup,
  type DynamicBackup,
} from '../src/server/backup/dynamic-backup';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CONFIG = 'wrangler.slice1-test.jsonc';
const DATABASE = 'orbit-v6-local';
const AGENT_PEPPER = 'test-agent-pepper-at-least-32-bytes-long';
const SESSION_PEPPER = 'test-session-pepper-at-least-32-bytes-long';
const CSRF_PEPPER = 'test-csrf-pepper-at-least-32-bytes-long';
const OWNER_ID = '019f64d2-0109-7644-9a4e-a0d25df888e2';
const MODERATOR_ID = '019f64d2-0109-7644-9a4e-a0d25df888e3';
const MEMBER_ID = '019f64d2-0109-7644-9a4e-a0d25df888e4';
const NOW = Date.parse('2026-07-16T09:30:00Z');

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let workerOutput = '';
let ownerCookie = '';
let ownerCsrf = '';
let moderatorCookie = '';
let moderatorCsrf = '';
let memberCookie = '';
let memberCsrf = '';
const agentClocks = new Map<string, number>();

interface SeededAgent {
  id: string;
  token: string;
  handle: string;
}

const agents = new Map<string, SeededAgent>();

function wrangler(args: string[], expectSuccess = true) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (expectSuccess && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}

function migrate(persist: string): void {
  wrangler([
    'd1','migrations','apply',DATABASE,'--config',CONFIG,'--local',`--persist-to=${persist}`,
  ]);
}

function importLegacy(persist: string): void {
  const result = spawnSync(process.execPath, [
    TSX, 'scripts/orbit-slice3-import.ts', '--local', `--database=${DATABASE}`,
    `--config=${CONFIG}`, `--persist-to=${persist}`,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
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

async function startWorker(persist: string): Promise<{ process: ChildProcessWithoutNullStreams; url: string; output: () => string }> {
  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`, `--inspector-port=${inspectorPort}`, `--persist-to=${persist}`,
  ], { cwd: ROOT, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe','pipe','pipe'] });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try {
      if ((await fetch(`${url}/v1/feed?limit=1`)).status === 200) return { process: child, url, output: () => output };
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler timeout:\n${output}`);
}

async function stopWorker(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
}

async function testPost(pathname: string, body: Record<string, unknown>, url = baseUrl): Promise<Response> {
  return await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
    body: JSON.stringify(body),
  });
}

async function seedAgent(handle: string, publicationMode: string, status = 'active'): Promise<SeededAgent> {
  const token = await createOpaqueToken('agent', AGENT_PEPPER);
  const agent = { id: createEntityId(), token: token.token, handle };
  const response = await testPost('/__test/seed-publication-agent', {
    accountId: OWNER_ID,
    agentId: agent.id,
    membershipId: createEntityId(),
    credentialId: token.selector,
    secretDigest: token.digest,
    handle,
    publicationMode,
    status,
    now: NOW,
  });
  assert.equal(response.status, 200);
  agents.set(handle, agent);
  return agent;
}

async function agentWrite(
  agent: SeededAgent,
  pathname: string,
  body: Record<string, unknown>,
  key: string,
  method = 'POST',
  exactNow?: number,
): Promise<Response> {
  const previous = agentClocks.get(agent.id) ?? NOW;
  const isRootPost = method === 'POST' && pathname === '/v1/records';
  const isReply = method === 'POST' && pathname.endsWith('/replies');
  const requestNow = exactNow ?? previous + (isRootPost ? 61 * 60 * 1000 : isReply ? 8 * 60 * 1000 : 16_000);
  agentClocks.set(agent.id, Math.max(previous, requestNow));
  return await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${agent.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-test-now': String(requestNow),
    },
    body: JSON.stringify(body),
  });
}

async function agentRead(
  agent: SeededAgent,
  pathname: string,
  exactNow = NOW,
): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    headers: {
      authorization: `Bearer ${agent.token}`,
      'x-test-now': String(exactNow),
    },
  });
}

async function humanRequest(
  cookie: string,
  csrf: string,
  pathname: string,
  method = 'GET',
  body?: Record<string, unknown>,
  key?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie,
    'x-test-now': String(NOW),
  };
  if (method !== 'GET') {
    headers.origin = 'http://localhost:4321';
    headers['x-orbit-csrf'] = csrf;
    headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
  }
  return await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ownerRequest = (pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string) =>
  humanRequest(ownerCookie, ownerCsrf, pathname, method, body, key);

const moderatorRequest = (pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string) =>
  humanRequest(moderatorCookie, moderatorCsrf, pathname, method, body, key);

const memberRequest = (pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string) =>
  humanRequest(memberCookie, memberCsrf, pathname, method, body, key);

async function seedRoleSession(accountId: string, handle: string, role: 'member' | 'moderator') {
  const session = await createOpaqueToken('session', SESSION_PEPPER);
  const csrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${csrf}`, CSRF_PEPPER);
  assert.equal((await testPost('/__test/seed-role-session', {
    accountId,
    handle,
    role,
    roleId: createEntityId(),
    sessionId: session.selector,
    secretDigest: session.digest,
    csrfDigest,
  })).status, 200);
  return { cookie: `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${csrf}`, csrf };
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice4-'));
  migrate(persistDirectory);
  importLegacy(persistDirectory);
  const started = await startWorker(persistDirectory);
  worker = started.process;
  baseUrl = started.url;
  const capture = started.output;
  Object.defineProperty(globalThis, '__orbitWorkerOutput', { value: capture, configurable: true });

  const session = await createOpaqueToken('session', SESSION_PEPPER);
  ownerCsrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${ownerCsrf}`, CSRF_PEPPER);
  assert.equal((await testPost('/__test/seed-human-session', {
    sessionId: session.selector, secretDigest: session.digest, csrfDigest,
    accountId: OWNER_ID,
  })).status, 200);
  ownerCookie = `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${ownerCsrf}`;

  const moderator = await seedRoleSession(MODERATOR_ID, 'slice4-moderator', 'moderator');
  moderatorCookie = moderator.cookie;
  moderatorCsrf = moderator.csrf;
  const member = await seedRoleSession(MEMBER_ID, 'slice4-member', 'member');
  memberCookie = member.cookie;
  memberCsrf = member.csrf;

  await seedAgent('slice4-direct', 'direct_publish');
  await seedAgent('slice4-review', 'approval_required');
  await seedAgent('slice4-readonly', 'read_only');
  await seedAgent('slice4-suspended', 'direct_publish', 'suspended');
  await seedAgent('slice4-quota', 'direct_publish');
  await seedAgent('slice4-hourly', 'direct_publish');
  await seedAgent('slice4-burst', 'direct_publish');
  await seedAgent('slice4-pending-limits', 'approval_required');
});

after(async () => {
  if (worker) {
    workerOutput = (globalThis as typeof globalThis & { __orbitWorkerOutput?: () => string }).__orbitWorkerOutput?.() ?? '';
    await stopWorker(worker);
  }
  await rm(persistDirectory, { recursive: true, force: true });
});

describe('Orbit V6 Slice 4 publication and backup core', { concurrency: false }, () => {
  let directRecordId = '';
  let directSlug = '';
  let reviewRecordId = '';
  let rejectedRecordId = '';
  let withdrawnRecordId = '';

  test('direct publish derives identity, slug, summary and replays idempotently', async () => {
    const agent = agents.get('slice4-direct')!;
    const requestBody = {
      bodyMarkdown: 'Dinamik Orbit yayını artık sunucu tarafında güvenli biçimde doğuyor.\n\nİkinci paragraf.',
      projectSlug: 'orbit', topicSlugs: ['sistemler'],
    };
    const first = await agentWrite(agent, '/v1/records', requestBody, 'direct-post-1');
    assert.equal(first.status, 201);
    const keyExpiresAt = first.headers.get('idempotency-key-expires-at');
    assert.ok(keyExpiresAt);
    assert.equal(Date.parse(keyExpiresAt), NOW + 61 * 60 * 1000 + 24 * 60 * 60 * 1000);
    const body = await first.json() as { record: { id: string; slug: string; lifecycleState: string; revisionId: string } };
    directRecordId = body.record.id;
    directSlug = body.record.slug;
    assert.equal(body.record.lifecycleState, 'published');
    assert.match(directSlug, /^dinamik-orbit-yayini/u);

    const replay = await agentWrite(agent, '/v1/records', requestBody, 'direct-post-1');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(replay.headers.get('idempotency-key-expires-at'), keyExpiresAt);
    assert.deepEqual(await replay.json(), body);

    const conflict = await agentWrite(agent, '/v1/records', { ...requestBody, bodyMarkdown: 'Farklı gövde' }, 'direct-post-1');
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as {
      error: {
        code: string;
        details: {
          recovery: { retryable: boolean; action: string; retryAt: number | null };
          idempotency: { state: string; keyExpiresAt: number; reuseKey: boolean };
        };
      };
    };
    assert.equal(conflictBody.error.code, 'idempotency_conflict');
    assert.deepEqual(conflictBody.error.details.recovery, {
      retryable: false,
      action: 'use_new_idempotency_key',
      retryAt: null,
    });
    assert.deepEqual(conflictBody.error.details.idempotency, {
      state: 'conflict',
      keyExpiresAt: NOW + 61 * 60 * 1000 + 24 * 60 * 60 * 1000,
      reuseKey: false,
    });

    const detail = await fetch(`${baseUrl}/v1/records/${directSlug}`).then((response) => response.json()) as {
      record: { bodyMarkdown: string; summary: string; author: { handle: string } };
    };
    assert.equal(detail.record.author.handle, 'slice4-direct');
    assert.equal(detail.record.summary, 'Dinamik Orbit yayını artık sunucu tarafında güvenli biçimde doğuyor.');
  });

  test('agent owns role, color and exactly one visible pinned post', async () => {
    const agent = agents.get('slice4-direct')!;
    const profile = await fetch(`${baseUrl}/v1/agent/profile`, {
      headers: {
        authorization: `Bearer ${agent.token}`,
        'x-test-now': String(NOW + 1),
      },
    });
    assert.equal(profile.status, 200);
    const etag = profile.headers.get('etag');
    assert.ok(etag);

    const updated = await fetch(`${baseUrl}/v1/agent/profile`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'if-match': etag,
        'x-test-now': String(NOW + 2),
      },
      body: JSON.stringify({
        role: 'Sistem araştırma ajanı',
        accent: '#4c9c88',
        pinnedRecordId: directRecordId,
      }),
    });
    assert.equal(updated.status, 200, await updated.clone().text());
    const body = await updated.json() as {
      agent: { role: string; accent: string; pinnedRecordId: string | null };
    };
    assert.equal(body.agent.role, 'Sistem araştırma ajanı');
    assert.equal(body.agent.accent, '#4c9c88');
    assert.equal(body.agent.pinnedRecordId, directRecordId);

    const publicProfile = await fetch(`${baseUrl}/v1/agents/slice4-direct?limit=2`);
    assert.equal(publicProfile.status, 200);
    const publicBody = await publicProfile.json() as {
      agent: { founder: boolean; pinnedRecordId: string | null };
      activity: Array<{ id: string; metadata: { pinned?: boolean } }>;
    };
    assert.equal(publicBody.agent.founder, false);
    assert.equal(publicBody.agent.pinnedRecordId, directRecordId);
    assert.equal(publicBody.activity[0]?.id, directRecordId);
    assert.equal(publicBody.activity[0]?.metadata.pinned, true);

    const foreign = agents.get('slice4-review')!;
    const foreignProfile = await fetch(`${baseUrl}/v1/agent/profile`, {
      headers: {
        authorization: `Bearer ${foreign.token}`,
        'x-test-now': String(NOW + 3),
      },
    });
    const rejected = await fetch(`${baseUrl}/v1/agent/profile`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${foreign.token}`,
        'content-type': 'application/json',
        'if-match': foreignProfile.headers.get('etag') ?? '',
        'x-test-now': String(NOW + 4),
      },
      body: JSON.stringify({ pinnedRecordId: directRecordId }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'invalid_pinned_record');
  });

  test('reply root and parent are server-derived', async () => {
    const agent = agents.get('slice4-direct')!;
    const response = await agentWrite(agent, `/v1/records/${directRecordId}/replies`, {
      bodyMarkdown: 'Bu cevap kök ve ebeveyn bağını istemciden almıyor.',
      topicSlugs: ['sistemler'],
    }, 'direct-reply-1');
    assert.equal(response.status, 201);
    const body = await response.json() as { record: { parentId: string; rootId: string; id: string } };
    assert.equal(body.record.parentId, directRecordId);
    assert.equal(body.record.rootId, directRecordId);

    const nested = await agentWrite(agent, `/v1/records/${body.record.id}/replies`, {
      bodyMarkdown: 'Yanıta yanıt da aynı kökü koruyor.',
    }, 'direct-reply-2');
    const nestedBody = await nested.json() as { record: { parentId: string; rootId: string } };
    assert.equal(nestedBody.record.parentId, body.record.id);
    assert.equal(nestedBody.record.rootId, directRecordId);
  });

  test('approval-required content stays hidden until moderator approval while ordinary members are denied', async () => {
    const agent = agents.get('slice4-review')!;
    const pending = await agentWrite(agent, '/v1/records', {
      bodyMarkdown: 'Sponsor onayı bekleyen kayıt.', projectSlug: 'orbit', topicSlugs: ['orbit'],
    }, 'review-post-1');
    assert.equal(pending.status, 202);
    const pendingBody = await pending.json() as { record: { id: string; slug: string; lifecycleState: string } };
    reviewRecordId = pendingBody.record.id;
    assert.equal(pendingBody.record.lifecycleState, 'pending');
    assert.equal((await fetch(`${baseUrl}/v1/records/${reviewRecordId}`)).status, 404);

    assert.equal((await memberRequest('/v1/approvals')).status, 403);
    const queue = await moderatorRequest('/v1/approvals');
    assert.equal(queue.status, 200);
    const queueBody = await queue.json() as { reviews: Array<{ id: string; record: { id: string } }> };
    const review = queueBody.reviews.find((item) => item.record.id === reviewRecordId);
    assert.ok(review);
    const approved = await moderatorRequest(`/v1/approvals/${review.id}/approve`, 'POST', { note: 'Uygun.' }, 'approve-1');
    assert.equal(approved.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${reviewRecordId}`)).status, 200);

    const replay = await moderatorRequest(`/v1/approvals/${review.id}/approve`, 'POST', { note: 'Uygun.' }, 'approve-1');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  });

  test('sponsor rejection keeps a pending record private', async () => {
    const agent = agents.get('slice4-review')!;
    const pending = await agentWrite(agent, '/v1/records', {
      bodyMarkdown: 'Sponsor tarafından reddedilecek kayıt.',
    }, 'review-reject-create').then((response) => response.json()) as { record: { id: string } };
    rejectedRecordId = pending.record.id;
    const queue = await ownerRequest('/v1/approvals').then((response) => response.json()) as {
      reviews: Array<{ id: string; record: { id: string } }>;
    };
    const review = queue.reviews.find((item) => item.record.id === pending.record.id);
    assert.ok(review);
    const detail = await ownerRequest(`/v1/approvals/${review.id}`);
    assert.equal(detail.status, 200);
    assert.equal((await ownerRequest(`/v1/approvals/${review.id}/reject`, 'POST', {
      note: 'Bu sürüm yayınlanmayacak.',
    }, 'reject-1')).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${pending.record.id}`)).status, 404);
  });

  test('pending edit preserves current public revision until approval', async () => {
    const agent = agents.get('slice4-review')!;
    const before = await fetch(`${baseUrl}/v1/records/${reviewRecordId}`).then((response) => response.json()) as {
      record: { bodyMarkdown: string };
    };
    const edit = await agentWrite(agent, `/v1/records/${reviewRecordId}`, {
      bodyMarkdown: 'Sponsor onayıyla görünür olacak yeni revision.',
    }, 'review-edit-1', 'PATCH');
    assert.equal(edit.status, 202);
    const during = await fetch(`${baseUrl}/v1/records/${reviewRecordId}`).then((response) => response.json()) as {
      record: { bodyMarkdown: string };
    };
    assert.equal(during.record.bodyMarkdown, before.record.bodyMarkdown);

    const queue = await ownerRequest('/v1/approvals').then((response) => response.json()) as {
      reviews: Array<{ id: string; record: { id: string }; revision: { number: number } }>;
    };
    const review = queue.reviews.find((item) => item.record.id === reviewRecordId);
    assert.ok(review);
    assert.equal(review.revision.number, 2);
    assert.equal((await ownerRequest(`/v1/approvals/${review.id}/approve`, 'POST', {}, 'approve-edit-1')).status, 200);
    const after = await fetch(`${baseUrl}/v1/records/${reviewRecordId}`).then((response) => response.json()) as {
      record: { bodyMarkdown: string };
    };
    assert.equal(after.record.bodyMarkdown, 'Sponsor onayıyla görünür olacak yeni revision.');
  });

  test('withdrawing a pending edit leaves the current published revision intact', async () => {
    const agent = agents.get('slice4-review')!;
    const edit = await agentWrite(agent, `/v1/records/${reviewRecordId}`, {
      bodyMarkdown: 'Geri çekilecek yeni revision.',
    }, 'review-edit-withdraw', 'PATCH');
    assert.equal(edit.status, 202);
    assert.equal((await agentWrite(agent, `/v1/records/${reviewRecordId}/withdraw`, {}, 'withdraw-edit')).status, 200);
    const publicRecord = await fetch(`${baseUrl}/v1/records/${reviewRecordId}`).then((response) => response.json()) as {
      record: { bodyMarkdown: string };
    };
    assert.equal(publicRecord.record.bodyMarkdown, 'Sponsor onayıyla görünür olacak yeni revision.');
  });

  test('pending author withdrawal never becomes public', async () => {
    const agent = agents.get('slice4-review')!;
    const pending = await agentWrite(agent, '/v1/records', {
      bodyMarkdown: 'Geri çekilecek pending kayıt.',
    }, 'withdraw-create-1').then((response) => response.json()) as { record: { id: string } };
    withdrawnRecordId = pending.record.id;
    const withdrawal = await agentWrite(agent, `/v1/records/${pending.record.id}/withdraw`, {}, 'withdraw-1');
    assert.equal(withdrawal.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${pending.record.id}`)).status, 404);
  });

  test('agent control plane rediscovers private history, review outcomes and filter-bound pages', async () => {
    const agent = agents.get('slice4-review')!;
    assert.equal((await fetch(`${baseUrl}/v1/agent/state`)).status, 401);

    const stateResponse = await agentRead(agent, '/v1/agent/state');
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as {
      agent: { id: string; handle: string; status: string; publicationMode: string };
      credential: { id: string; scopes: string[]; expiresAt: number | null };
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
    assert.equal(state.agent.id, agent.id);
    assert.equal(state.agent.handle, agent.handle);
    assert.equal(state.agent.status, 'active');
    assert.equal(state.agent.publicationMode, 'approval_required');
    assert.ok(state.credential.id);
    assert.ok(state.credential.scopes.includes('feed:read'));
    assert.equal(state.credential.expiresAt, null);
    assert.ok(state.recordCounts.total >= 3);
    assert.ok(state.recordCounts.published >= 1);
    assert.ok(state.recordCounts.rejected >= 1);
    assert.ok(state.recordCounts.deleted >= 1);
    assert.equal(state.recordCounts.pendingReview, 0);

    const firstPageResponse = await agentRead(agent, '/v1/agent/records?limit=1');
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as {
      records: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(firstPage.records.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPageResponse = await agentRead(
      agent,
      `/v1/agent/records?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json() as {
      records: Array<{ id: string }>;
    };
    assert.equal(secondPage.records.length, 1);
    assert.notEqual(secondPage.records[0].id, firstPage.records[0].id);

    const reboundCursor = await agentRead(
      agent,
      `/v1/agent/records?limit=1&state=published&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    assert.equal(reboundCursor.status, 400);
    assert.equal(
      (await reboundCursor.json() as { error: { code: string } }).error.code,
      'invalid_cursor',
    );

    const rejectedList = await agentRead(
      agent,
      '/v1/agent/records?state=rejected&reviewStatus=rejected',
    ).then((response) => response.json()) as {
      records: Array<{ id: string }>;
    };
    assert.ok(rejectedList.records.some((record) => record.id === rejectedRecordId));

    const rejectedDetailResponse = await agentRead(
      agent,
      `/v1/agent/records/${rejectedRecordId}`,
    );
    assert.equal(rejectedDetailResponse.status, 200);
    const rejectedDetail = await rejectedDetailResponse.json() as {
      record: {
        lifecycleState: string;
        publicUrl: string | null;
        currentRevision: unknown;
        pendingRevision: unknown;
        latestReview: {
          status: string;
          reviewNote: string | null;
          revision: { bodyMarkdown: string; state: string };
        };
      };
    };
    assert.equal(rejectedDetail.record.lifecycleState, 'rejected');
    assert.equal(rejectedDetail.record.publicUrl, null);
    assert.equal(rejectedDetail.record.currentRevision, null);
    assert.equal(rejectedDetail.record.pendingRevision, null);
    assert.equal(rejectedDetail.record.latestReview.status, 'rejected');
    assert.equal(rejectedDetail.record.latestReview.reviewNote, 'Bu sürüm yayınlanmayacak.');
    assert.equal(rejectedDetail.record.latestReview.revision.state, 'rejected');
    assert.equal(
      rejectedDetail.record.latestReview.revision.bodyMarkdown,
      'Sponsor tarafından reddedilecek kayıt.',
    );

    const withdrawnDetail = await agentRead(
      agent,
      `/v1/agent/records/${withdrawnRecordId}`,
    ).then((response) => response.json()) as {
      record: {
        lifecycleState: string;
        latestReview: { status: string; reviewNote: string | null };
        deletion: unknown;
      };
    };
    assert.equal(withdrawnDetail.record.lifecycleState, 'deleted');
    assert.equal(withdrawnDetail.record.latestReview.status, 'cancelled');
    assert.equal(withdrawnDetail.record.latestReview.reviewNote, 'withdrawn_by_author');
    assert.equal(withdrawnDetail.record.deletion, null);

    const foreignDetail = await agentRead(
      agents.get('slice4-direct')!,
      `/v1/agent/records/${rejectedRecordId}`,
    );
    assert.equal(foreignDetail.status, 404);
    assert.equal(
      (await foreignDetail.json() as { error: { code: string } }).error.code,
      'agent_record_not_found',
    );

    const suspendedState = await agentRead(
      agents.get('slice4-suspended')!,
      '/v1/agent/state',
    );
    assert.equal(suspendedState.status, 200);
    assert.equal(
      (await suspendedState.json() as { agent: { status: string } }).agent.status,
      'suspended',
    );
  });

  test('read-only, suspended, raw HTML, dictionaries and privileged fields are rejected', async () => {
    assert.equal((await agentWrite(agents.get('slice4-readonly')!, '/v1/records', { bodyMarkdown: 'Yazamaz.' }, 'ro-1')).status, 403);
    assert.equal((await agentWrite(agents.get('slice4-suspended')!, '/v1/records', { bodyMarkdown: 'Yazamaz.' }, 'suspended-1')).status, 403);
    assert.equal((await agentWrite(agents.get('slice4-direct')!, '/v1/records', { bodyMarkdown: '<script>alert(1)</script>' }, 'html-1')).status, 400);
    assert.equal((await agentWrite(agents.get('slice4-direct')!, '/v1/records', { bodyMarkdown: 'Sözlük.', topicSlugs: ['olmayan-konu'] }, 'dictionary-1')).status, 400);
    const privileged = await agentWrite(agents.get('slice4-direct')!, '/v1/records', {
      bodyMarkdown: 'Alan ihlali.', author: 'nyx', lifecycleState: 'published',
    }, 'privileged-1');
    assert.equal(privileged.status, 400);
  });

  test('concurrent idempotency produces one mutation for every publication transition', async () => {
    const direct = await seedAgent('slice4-concurrent', 'direct_publish');
    const reviewAgent = await seedAgent('slice4-concurrent-review', 'approval_required');
    const pair = async (operation: () => Promise<Response>, expectedStatus: number) => {
      const responses = await Promise.all([operation(), operation()]);
      assert.deepEqual(responses.map((response) => response.status), [expectedStatus, expectedStatus]);
      assert.equal(responses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      assert.deepEqual(bodies[0], bodies[1]);
      return bodies[0] as { record?: { id: string }; review?: { id: string } };
    };

    const post = await pair(() => agentWrite(direct, '/v1/records', {
      bodyMarkdown: 'Paralel idempotency gönderisi.', topicSlugs: ['orbit'],
    }, 'concurrent-post'), 201);
    const postId = post.record!.id;
    await pair(() => agentWrite(direct, `/v1/records/${postId}/replies`, {
      bodyMarkdown: 'Paralel idempotency yanıtı.',
    }, 'concurrent-reply'), 201);
    await pair(() => agentWrite(direct, `/v1/records/${postId}`, {
      bodyMarkdown: 'Paralel idempotency revision.',
    }, 'concurrent-revision', 'PATCH'), 200);

    const slugRace = await Promise.all([
      agentWrite(direct, '/v1/records', { bodyMarkdown: 'Aynı anda üretilen slug.' }, 'concurrent-slug-a'),
      agentWrite(direct, '/v1/records', { bodyMarkdown: 'Aynı anda üretilen slug.' }, 'concurrent-slug-b'),
    ]);
    assert.deepEqual(slugRace.map((response) => response.status), [201, 201]);
    const slugBodies = await Promise.all(slugRace.map((response) => response.json())) as Array<{
      record: { id: string; slug: string };
    }>;
    assert.notEqual(slugBodies[0].record.id, slugBodies[1].record.id);
    assert.notEqual(slugBodies[0].record.slug, slugBodies[1].record.slug);
    assert.ok(slugBodies.some((item) => item.record.slug === 'ayni-anda-uretilen-slug'));
    assert.ok(slugBodies.some((item) => item.record.slug.endsWith(item.record.id.replaceAll('-', '').slice(-12))));

    const pending = async (text: string, key: string) => {
      const response = await agentWrite(reviewAgent, '/v1/records', { bodyMarkdown: text }, key);
      assert.equal(response.status, 202);
      return (await response.json() as { record: { id: string } }).record.id;
    };
    const reviewFor = async (recordId: string) => {
      const queue = await ownerRequest('/v1/approvals').then((response) => response.json()) as {
        reviews: Array<{ id: string; record: { id: string } }>;
      };
      return queue.reviews.find((item) => item.record.id === recordId)!.id;
    };
    const approveRecord = await pending('Paralel onay kaydı.', 'concurrent-approve-create');
    const approveReview = await reviewFor(approveRecord);
    await pair(() => ownerRequest(`/v1/approvals/${approveReview}/approve`, 'POST', { note: 'parallel' }, 'concurrent-approve'), 200);

    const rejectRecord = await pending('Paralel ret kaydı.', 'concurrent-reject-create');
    const rejectReview = await reviewFor(rejectRecord);
    await pair(() => ownerRequest(`/v1/approvals/${rejectReview}/reject`, 'POST', { note: 'parallel' }, 'concurrent-reject'), 200);

    const withdrawRecord = await pending('Paralel geri çekme kaydı.', 'concurrent-withdraw-create');
    await pair(() => agentWrite(reviewAgent, `/v1/records/${withdrawRecord}/withdraw`, {}, 'concurrent-withdraw'), 200);

    const deleteAgent = await seedAgent('slice4-concurrent-delete', 'direct_publish');
    const agentDelete = await agentWrite(deleteAgent, '/v1/records', { bodyMarkdown: 'Paralel ajan silme kaydı.' }, 'concurrent-agent-delete-create')
      .then((response) => response.json()) as { record: { id: string } };
    await pair(() => agentWrite(deleteAgent, `/v1/records/${agentDelete.record.id}/delete`, { reason: 'parallel' }, 'concurrent-agent-delete'), 200);

    const sponsorDelete = await agentWrite(deleteAgent, '/v1/records', { bodyMarkdown: 'Paralel sponsor silme kaydı.' }, 'concurrent-sponsor-delete-create')
      .then((response) => response.json()) as { record: { id: string } };
    await pair(() => ownerRequest(`/v1/manage/records/${sponsorDelete.record.id}/delete`, 'POST', { reason: 'parallel' }, 'concurrent-sponsor-delete'), 200);
  });

  test('hourly post and reply quotas reject atomically', async () => {
    const agent = agents.get('slice4-hourly')!;
    const requestNow = NOW + 10 * 60 * 60 * 1000;
    const hourUtc = new Date(requestNow).toISOString().slice(0, 13);
    await testPost('/__test/set-hourly-usage', {
      agentId: agent.id,
      hourUtc,
      postsCreated: 2,
      repliesCreated: 0,
      lastRecordCreatedAt: requestNow - 15_000,
    });
    const post = await agentWrite(agent, '/v1/records', { bodyMarkdown: 'Saatlik üçüncü gönderi.' }, 'hourly-post', 'POST', requestNow);
    assert.equal(post.status, 429);
    const postResetAt = Date.UTC(2026, 6, 16, 20);
    assert.equal(post.headers.get('retry-after'), String((postResetAt - requestNow) / 1000));
    const postError = (await post.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(postError.code, 'hourly_quota_exceeded');
    assert.deepEqual(postError.details.recovery, {
      retryable: true,
      action: 'retry_same_request',
      retryAt: postResetAt,
    });
    assert.deepEqual(postError.details.quota, {
      key: 'publication.post.hourly',
      limit: 2,
      remaining: 0,
      windowSeconds: 3600,
      resetAt: postResetAt,
    });

    await testPost('/__test/set-hourly-usage', {
      agentId: agent.id,
      hourUtc,
      postsCreated: 0,
      repliesCreated: 8,
      lastRecordCreatedAt: requestNow - 15_000,
    });
    const reply = await agentWrite(agent, `/v1/records/${directRecordId}/replies`, {
      bodyMarkdown: 'Saatlik dokuzuncu yanıt.',
    }, 'hourly-reply', 'POST', requestNow);
    assert.equal(reply.status, 429);
    assert.equal(reply.headers.get('retry-after'), String((postResetAt - requestNow) / 1000));
    const replyError = (await reply.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(replyError.code, 'hourly_quota_exceeded');
    assert.deepEqual(replyError.details.quota, {
      key: 'publication.reply.hourly',
      limit: 8,
      remaining: 0,
      windowSeconds: 3600,
      resetAt: postResetAt,
    });
    const usage = await testPost('/__test/usage', { agentId: agent.id }).then((response) => response.json()) as {
      rows: unknown[];
      hourly: Array<{ hour_utc: string; posts_created: number; replies_created: number }>;
    };
    assert.deepEqual(usage.rows, []);
    assert.deepEqual(usage.hourly, [{ hour_utc: hourUtc, posts_created: 0, replies_created: 8 }]);
  });

  test('publication burst and pending queue limits reject atomically', async () => {
    const burstAgent = agents.get('slice4-burst')!;
    const burstNow = NOW + 12 * 60 * 60 * 1000;
    const burstResponses = await Promise.all([
      agentWrite(burstAgent, '/v1/records', { bodyMarkdown: 'Burst gönderisi A.' }, 'burst-a', 'POST', burstNow),
      agentWrite(burstAgent, '/v1/records', { bodyMarkdown: 'Burst gönderisi B.' }, 'burst-b', 'POST', burstNow),
    ]);
    assert.deepEqual(burstResponses.map((response) => response.status).sort(), [201, 429]);
    const burstError = burstResponses.find((response) => response.status === 429)!;
    assert.equal(burstError.headers.get('retry-after'), '15');
    const burstErrorBody = (await burstError.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(burstErrorBody.code, 'publication_burst_limited');
    assert.deepEqual(burstErrorBody.details.recovery, {
      retryable: true,
      action: 'retry_same_request',
      retryAt: burstNow + 15_000,
    });
    assert.deepEqual(burstErrorBody.details.quota, {
      key: 'publication.create.minimum_interval',
      limit: 1,
      remaining: 0,
      windowSeconds: 15,
      resetAt: burstNow + 15_000,
    });
    const burstUsage = await testPost('/__test/usage', { agentId: burstAgent.id }).then((response) => response.json()) as {
      rows: Array<{ posts_created: number }>;
      hourly: Array<{ posts_created: number }>;
    };
    assert.equal(burstUsage.rows.at(-1)?.posts_created, 1);
    assert.equal(burstUsage.hourly.at(-1)?.posts_created, 1);

    const pendingAgent = agents.get('slice4-pending-limits')!;
    const pendingBase = NOW + 14 * 60 * 60 * 1000;
    for (let index = 0; index < 2; index += 1) {
      const response = await agentWrite(pendingAgent, '/v1/records', {
        bodyMarkdown: `Bekleyen gönderi ${index + 1}.`,
      }, `pending-limit-post-${index + 1}`, 'POST', pendingBase + index * 61 * 60 * 1000);
      assert.equal(response.status, 202);
    }
    const thirdPost = await agentWrite(pendingAgent, '/v1/records', {
      bodyMarkdown: 'Bekleyen üçüncü gönderi.',
    }, 'pending-limit-post-3', 'POST', pendingBase + 2 * 61 * 60 * 1000);
    assert.equal(thirdPost.status, 429);
    assert.equal(thirdPost.headers.get('retry-after'), null);
    const thirdPostError = (await thirdPost.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(thirdPostError.code, 'pending_queue_full');
    assert.deepEqual(thirdPostError.details.recovery, {
      retryable: false,
      action: 'resolve_pending_queue',
      retryAt: null,
    });
    assert.deepEqual(thirdPostError.details.quota, {
      key: 'publication.post.pending',
      limit: 2,
      remaining: 0,
      windowSeconds: null,
      resetAt: null,
    });

    const replyBase = pendingBase + 4 * 60 * 60 * 1000;
    for (let index = 0; index < 5; index += 1) {
      const response = await agentWrite(pendingAgent, `/v1/records/${directRecordId}/replies`, {
        bodyMarkdown: `Bekleyen yanıt ${index + 1}.`,
      }, `pending-limit-reply-${index + 1}`, 'POST', replyBase + index * 16_000);
      assert.equal(response.status, 202);
    }
    const sixthReply = await agentWrite(pendingAgent, `/v1/records/${directRecordId}/replies`, {
      bodyMarkdown: 'Bekleyen altıncı yanıt.',
    }, 'pending-limit-reply-6', 'POST', replyBase + 5 * 16_000);
    assert.equal(sixthReply.status, 429);
    assert.equal(sixthReply.headers.get('retry-after'), null);
    const sixthReplyError = (await sixthReply.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(sixthReplyError.code, 'pending_queue_full');
    assert.deepEqual(sixthReplyError.details.quota, {
      key: 'publication.reply.pending',
      limit: 5,
      remaining: 0,
      windowSeconds: null,
      resetAt: null,
    });
  });

  test('daily post and reply quotas roll the entire write back', async () => {
    const agent = agents.get('slice4-quota')!;
    const dayUtc = new Date(NOW).toISOString().slice(0, 10);
    await testPost('/__test/set-usage', { agentId: agent.id, dayUtc, postsCreated: 5, repliesCreated: 0 });
    const post = await agentWrite(agent, '/v1/records', { bodyMarkdown: 'Altıncı post.' }, 'quota-post', 'POST', NOW);
    assert.equal(post.status, 429);
    const resetAt = Date.parse('2026-07-17T00:00:00Z');
    assert.equal(post.headers.get('retry-after'), String((resetAt - NOW) / 1000));
    const postError = (await post.json() as { error: { details: Record<string, any> } }).error;
    assert.deepEqual(postError.details.quota, {
      key: 'publication.post.daily',
      limit: 5,
      remaining: 0,
      windowSeconds: 86400,
      resetAt,
    });

    await testPost('/__test/set-usage', { agentId: agent.id, dayUtc, postsCreated: 0, repliesCreated: 30 });
    const reply = await agentWrite(agent, `/v1/records/${directRecordId}/replies`, { bodyMarkdown: 'Otuz birinci yanıt.' }, 'quota-reply', 'POST', NOW);
    assert.equal(reply.status, 429);
    const replyError = (await reply.json() as { error: { details: Record<string, any> } }).error;
    assert.deepEqual(replyError.details.quota, {
      key: 'publication.reply.daily',
      limit: 30,
      remaining: 0,
      windowSeconds: 86400,
      resetAt,
    });
    const usage = await testPost('/__test/usage', { agentId: agent.id }).then((response) => response.json()) as {
      rows: Array<{ posts_created: number; replies_created: number }>;
    };
    assert.deepEqual(usage.rows.at(-1), { day_utc: dayUtc, posts_created: 0, replies_created: 30, write_attempts: 0 });
  });

  test('author soft delete removes content from every public surface', async () => {
    const agent = agents.get('slice4-direct')!;
    const deleted = await agentWrite(agent, `/v1/records/${directRecordId}/delete`, { reason: 'Yazar geri çekti.' }, 'delete-1');
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${directRecordId}`)).status, 404);
    const feed = await fetch(`${baseUrl}/v1/feed?limit=50`).then((response) => response.json()) as { records: Array<{ id: string }> };
    assert.ok(!feed.records.some((record) => record.id === directRecordId));
    const profile = await fetch(`${baseUrl}/v1/agent/profile`, {
      headers: { authorization: `Bearer ${agent.token}` },
    }).then((response) => response.json()) as { agent: { pinnedRecordId: string | null } };
    assert.equal(profile.agent.pinnedRecordId, null);
    const privateRecord = await agentRead(
      agent,
      `/v1/agent/records/${directRecordId}`,
    ).then((response) => response.json()) as {
      record: {
        lifecycleState: string;
        publicUrl: string | null;
        deletion: { actorType: string; reason: string; deletedAt: number };
      };
    };
    assert.equal(privateRecord.record.lifecycleState, 'deleted');
    assert.equal(privateRecord.record.publicUrl, null);
    assert.equal(privateRecord.record.deletion.actorType, 'agent');
    assert.equal(privateRecord.record.deletion.reason, 'Yazar geri çekti.');
    assert.ok(Number.isSafeInteger(privateRecord.record.deletion.deletedAt));
  });

  test('sponsor soft delete creates moderation and audit evidence', async () => {
    const agent = agents.get('slice4-direct')!;
    const created = await agentWrite(agent, '/v1/records', {
      bodyMarkdown: 'Sponsor tarafından kaldırılacak kayıt.',
    }, 'managed-delete-create').then((response) => response.json()) as { record: { id: string } };
    const deleted = await ownerRequest(`/v1/manage/records/${created.record.id}/delete`, 'POST', {
      reason: 'Sponsor kaldırma provası.',
    }, 'managed-delete-1');
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${created.record.id}`)).status, 404);
    const evidence = await testPost('/__test/publication-evidence', { recordId: created.record.id })
      .then((response) => response.json()) as { audits: Array<{ event_type: string }>; moderation: Array<{ action: string }> };
    assert.ok(evidence.audits.some((item) => item.event_type === 'record.soft_deleted'));
    assert.deepEqual(evidence.moderation.map((item) => item.action), ['record.soft_deleted']);
    const privateRecord = await agentRead(
      agent,
      `/v1/agent/records/${created.record.id}`,
    ).then((response) => response.json()) as {
      record: {
        latestModeration: {
          action: string;
          reason: string;
          reversedAt: number | null;
        };
      };
    };
    assert.equal(privateRecord.record.latestModeration.action, 'record.soft_deleted');
    assert.equal(privateRecord.record.latestModeration.reason, 'Sponsor kaldırma provası.');
    assert.equal(privateRecord.record.latestModeration.reversedAt, null);
  });

  test('platform owner deletes a root post and its complete reply tree atomically', async () => {
    const author = await seedAgent('slice4-thread-owner', 'direct_publish');
    const participant = await seedAgent('slice4-thread-participant', 'direct_publish');
    const root = await agentWrite(author, '/v1/records', {
      bodyMarkdown: 'Yönetici arayüzünden bütün yanıtlarıyla kaldırılacak kök gönderi.',
      topicSlugs: ['sistemler'],
    }, 'thread-delete-root').then((response) => response.json()) as {
      record: { id: string; slug: string };
    };
    const directReply = await agentWrite(participant, `/v1/records/${root.record.id}/replies`, {
      bodyMarkdown: 'Kök gönderinin doğrudan yanıtı.',
    }, 'thread-delete-direct-reply').then((response) => response.json()) as {
      record: { id: string };
    };
    const nestedReply = await agentWrite(author, `/v1/records/${directReply.record.id}/replies`, {
      bodyMarkdown: 'Doğrudan yanıta bağlı iç içe yanıt.',
    }, 'thread-delete-nested-reply').then((response) => response.json()) as {
      record: { id: string };
    };

    const deleted = await ownerRequest(
      `/v1/manage/records/${root.record.id}/delete`,
      'POST',
      { reason: 'Yönetici görsel arayüz thread silme testi.' },
      'managed-thread-delete',
    );
    assert.equal(deleted.status, 200);
    const body = await deleted.json() as {
      record: {
        id: string;
        kind: string;
        status: string;
        scope: string;
        deletedCount: number;
        deletedReplyCount: number;
      };
    };
    assert.deepEqual(body.record, {
      id: root.record.id,
      kind: 'post',
      status: 'deleted',
      scope: 'thread',
      deletedCount: 3,
      deletedReplyCount: 2,
    });

    for (const recordId of [root.record.id, directReply.record.id, nestedReply.record.id]) {
      assert.equal((await fetch(`${baseUrl}/v1/records/${recordId}`)).status, 404);
      const evidence = await testPost('/__test/publication-evidence', { recordId })
        .then((response) => response.json()) as {
          audits: Array<{ event_type: string; metadata_json: string }>;
          moderation: Array<{ action: string }>;
        };
      assert.deepEqual(evidence.moderation.map((item) => item.action), ['record.soft_deleted']);
      assert.ok(evidence.audits.some((item) => (
        item.event_type === 'record.soft_deleted'
        && JSON.parse(item.metadata_json).scope === 'thread'
      )));
    }
    assert.equal((await fetch(`${baseUrl}/v1/records/${root.record.slug}`)).status, 404);

    const lateReply = await agentWrite(participant, `/v1/records/${root.record.id}/replies`, {
      bodyMarkdown: 'Silinmiş thread altında yeni yanıt oluşmamalı.',
    }, 'thread-delete-late-reply');
    assert.equal(lateReply.status, 404);

    const replay = await ownerRequest(
      `/v1/manage/records/${root.record.id}/delete`,
      'POST',
      { reason: 'Yönetici görsel arayüz thread silme testi.' },
      'managed-thread-delete',
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replay.json(), body);
  });

  test('every insert gate on a backed-up table is classified for restore', async () => {
    const files = (await readdir(path.join(ROOT, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
    const sources = await Promise.all(
      files.map((name) => readFile(path.join(ROOT, 'migrations', name), 'utf8')),
    );
    const pattern = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)[^;]*?\s+ON\s+(\w+)|DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
    const live = new Map<string, string | null>();
    for (const match of sources.join('\n').matchAll(pattern)) {
      const [, created, timing, event, table, dropped] = match;
      if (dropped) live.delete(dropped);
      else live.set(created, /before/i.test(timing) && /insert/i.test(event) ? table : null);
    }
    const backedUp = new Set(RESTORE_GATE_CLASSIFICATION.tables);
    const gates = [...live].filter(([, table]) => table !== null && backedUp.has(table))
      .map(([name]) => name).sort();
    const classified = [
      ...RESTORE_GATE_CLASSIFICATION.suspended,
      ...RESTORE_GATE_CLASSIFICATION.armed,
    ].sort();
    assert.deepEqual(
      gates,
      classified,
      'Yedeklenen bir tabloya BEFORE INSERT kapısı eklendi ya da kalktı. '
      + 'dynamic-backup.ts içindeki RESTORE_SUSPENDED_GATES / RESTORE_ARMED_GATES '
      + 'listelerinden birine yaz: kapı geçmişi mi yargılıyor, satırı mı?',
    );
  });

  test('versioned application backup rejects corruption atomically and restores in two phases', async () => {
    const exported = await testPost('/__test/backup-export', { includeSessions: true }).then((response) => response.json()) as {
      schema: string; checksum: { value: string }; counts: Record<string, number>;
      security: { containsPlaintextSecrets: boolean };
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    assert.equal(exported.schema, 'equinox.orbit.dynamic-backup.v1');
    assert.equal(exported.security.containsPlaintextSecrets, false);
    assert.ok(exported.counts.records > 13);
    assert.ok(exported.tables.agentCredentials.every((row) => 'secret_digest' in row && !('token' in row)));
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const encrypted = await encryptDynamicBackup(exported as DynamicBackup, encryptionKey, 'test-key-v1');
    assert.equal(encrypted.algorithm, 'AES-GCM-256');
    assert.ok(!encrypted.ciphertext.includes('slice4-direct'));

    // Yedek, canlının bugünkü kurallarını değil geçmişin kendisini taşır:
    // sonradan askıya alınmış bir ajanın mesajı, sonradan gizlenmiş bir
    // başlığın altındaki yanıt. İkisi de bugün yapılamaz, ikisi de geri
    // yüklenmek zorunda.
    const history = structuredClone(exported) as DynamicBackup;
    const suspended = history.tables.agents.find((row) => row.handle === 'slice4-direct');
    assert.ok(suspended, 'yedekte slice4-direct yok');
    suspended.status = 'suspended';
    const partner = history.tables.agents.find((row) => row.id !== suspended.id);
    assert.ok(partner, 'yedekte ikinci ajan yok');
    const removedPost = history.tables.records.find((row) => (
      row.kind === 'post' && history.tables.records.some((reply) => reply.parent_id === row.id)
    ));
    assert.ok(removedPost, 'yedekte yanıtı olan gönderi yok');
    removedPost.moderation_state = 'removed';
    removedPost.moderated_at = NOW;
    for (const agent of history.tables.agents) {
      if (agent.pinned_record_id === removedPost.id) agent.pinned_record_id = null;
    }
    history.tables.directMessages.push({
      id: createEntityId(),
      sender_agent_id: suspended.id,
      recipient_agent_id: partner.id,
      body_markdown: 'Arşivden bir mesaj.',
      created_at: NOW - 1000,
    });
    history.counts.directMessages = history.tables.directMessages.length;
    const { checksum: _replaced, ...unsigned } = history;
    history.checksum = { algorithm: 'sha256', value: await sha256Base64Url(canonicalJson(unsigned)) };

    const restorePersist = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice4-restore-'));
    let restoreWorker: ChildProcessWithoutNullStreams | undefined;
    try {
      migrate(restorePersist);
      const started = await startWorker(restorePersist);
      restoreWorker = started.process;
      const freshTriggers = await testPost('/__test/schema-triggers', {}, started.url)
        .then((response) => response.json()) as { triggers: Array<{ name: string; sql: string }> };
      const corrupted = structuredClone(exported);
      corrupted.checksum.value = `${corrupted.checksum.value.slice(0, -1)}x`;
      const rejected = await testPost('/__test/backup-restore', { backup: corrupted, revokeSecurity: true }, started.url);
      assert.equal(rejected.status, 400);
      const empty = await testPost('/__test/backup-counts', {}, started.url).then((response) => response.json()) as {
        counts: { agents: number; records: number; projects: number; topics: number; validations: number };
      };
      assert.equal(empty.counts.agents, 0);
      assert.equal(empty.counts.records, 0);
      assert.equal(empty.counts.projects, 0);
      assert.equal(empty.counts.topics, 0);
      assert.equal(empty.counts.validations, 0);

      const restored = await testPost('/__test/backup-restore', { backup: history, revokeSecurity: true }, started.url);
      assert.equal(restored.status, 200, await restored.clone().text());
      const proof = await restored.json() as { proof: { foreignKeyViolations: number; counts: Record<string, number> } };
      assert.equal(proof.proof.foreignKeyViolations, 0);
      assert.equal(proof.proof.counts.records, history.counts.records);
      const restoredExport = await testPost('/__test/backup-export', { includeSessions: true }, started.url)
        .then((response) => response.json()) as { tables: Record<string, Array<Record<string, unknown>>> };
      assert.ok(restoredExport.tables.agentCredentials.every((row) => row.revoked_at !== null));
      assert.ok(restoredExport.tables.sessions.every((row) => row.revoked_at !== null));

      // Geçmiş olduğu gibi geri geldi.
      assert.equal(restoredExport.tables.directMessages.length, history.counts.directMessages);
      assert.ok(restoredExport.tables.directMessages.some((row) => row.sender_agent_id === suspended.id));
      assert.equal(
        restoredExport.tables.records.find((row) => row.id === removedPost.id)?.moderation_state,
        'removed',
      );
      assert.ok(restoredExport.tables.records.some((row) => row.parent_id === removedPost.id));

      // Geri yükleme bir kere olmaz. Geri yüklenmiş bir veritabanından alınan
      // yedek de kendi doğrulamasından geçmek zorunda, yoksa ilk felaketten
      // sonra ikincisine karşı savunmasız kalırız.
      await verifyDynamicBackup(restoredExport);

      // Askıya alınan kapılar aynı SQL ile geri kondu: geri yüklenmiş
      // veritabanının tetikleyici kümesi taze şemadan ayırt edilemez.
      const afterTriggers = await testPost('/__test/schema-triggers', {}, started.url)
        .then((response) => response.json()) as { triggers: Array<{ name: string; sql: string }> };
      assert.deepEqual(afterTriggers.triggers, freshTriggers.triggers);
    } finally {
      if (restoreWorker) await stopWorker(restoreWorker);
      await rm(restorePersist, { recursive: true, force: true });
    }
  });

  test('agent credentials never enter Worker output', () => {
    const output = (globalThis as typeof globalThis & { __orbitWorkerOutput?: () => string }).__orbitWorkerOutput?.() ?? workerOutput;
    for (const agent of agents.values()) assert.equal(output.includes(agent.token), false);
  });
});
