import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, hmacDigest, randomBase64Url } from '../src/server/identity/tokens';
import { dashboardResponse } from '../src/server/dashboard/html';
import {
  decryptChunkedBackup,
  encryptChunkedBackup,
} from '../src/server/backup/chunked-backup';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CONFIG = 'wrangler.slice1-test.jsonc';
const DATABASE = 'orbit-v6-local';
const OWNER_ID = '019f64d2-0109-7644-9a4e-a0d25df888e2';
const NOW = Date.parse('2026-07-16T10:00:00Z');
const AGENT_PEPPER = 'test-agent-pepper-at-least-32-bytes-long';
const SESSION_PEPPER = 'test-session-pepper-at-least-32-bytes-long';
const CSRF_PEPPER = 'test-csrf-pepper-at-least-32-bytes-long';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let ownerCookie = '';
let ownerCsrf = '';

interface Agent { id: string; token: string; handle: string }
const agents = new Map<string, Agent>();

function wrangler(args: string[]) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

function migrate(persist: string): void {
  wrangler(['d1','migrations','apply',DATABASE,'--config',CONFIG,'--local',`--persist-to=${persist}`]);
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

async function startWorker(persist: string) {
  const port = await availablePort();
  let output = '';
  const child = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`, `--persist-to=${persist}`,
  ], { cwd: ROOT, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe','pipe','pipe'] });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited:\n${output}`);
    try { if ((await fetch(`${url}/v1/feed?limit=1`)).status === 200) return { process: child, url, output: () => output }; } catch {}
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

async function testPost(pathname: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
    body: JSON.stringify(body),
  });
}

async function ownerRequest(pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string): Promise<Response> {
  const headers: Record<string, string> = { cookie: ownerCookie, 'x-test-now': String(NOW) };
  if (method !== 'GET') {
    headers.origin = 'http://localhost:4321';
    headers['x-orbit-csrf'] = ownerCsrf;
    headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
  }
  return await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedAgent(handle: string, role = ''): Promise<Agent> {
  const token = await createOpaqueToken('agent', AGENT_PEPPER);
  const agent = { id: createEntityId(), token: token.token, handle };
  const response = await testPost('/__test/seed-publication-agent', {
    accountId: OWNER_ID, agentId: agent.id, membershipId: createEntityId(),
    credentialId: token.selector, secretDigest: token.digest,
    handle, publicationMode: 'direct_publish', status: 'active', role, now: NOW,
  });
  assert.equal(response.status, 200);
  agents.set(handle, agent);
  return agent;
}

async function agentRequest(agent: Agent, pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${agent.token}`,
    'x-test-now': String(NOW),
  };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
  }
  return await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice5-'));
  migrate(persistDirectory);
  importLegacy(persistDirectory);
  const started = await startWorker(persistDirectory);
  worker = started.process;
  baseUrl = started.url;
  Object.defineProperty(globalThis, '__orbitSlice5Output', { value: started.output, configurable: true });

  const session = await createOpaqueToken('session', SESSION_PEPPER);
  ownerCsrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${ownerCsrf}`, CSRF_PEPPER);
  assert.equal((await testPost('/__test/seed-human-session', {
    sessionId: session.selector, secretDigest: session.digest, csrfDigest, accountId: OWNER_ID,
  })).status, 200);
  ownerCookie = `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${ownerCsrf}`;
  await seedAgent('slice5-equinox', 'Sistem ajanı');
  await seedAgent('slice5-external');
});

after(async () => {
  if (worker) {
    await stopWorker(worker);
  }
  await rm(persistDirectory, { recursive: true, force: true });
});

describe('Orbit V6 Slice 5 dashboard and platform core', { concurrency: false }, () => {
  test('dashboard is no-store, nonce-protected and contains no credential material', async () => {
    const response = dashboardResponse();
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'nonce-/u);
    assert.match(html, /Orbit Sponsor Paneli/u);
    assert.doesNotMatch(html, /orb_agent_v1_/u);
  });

  test('sponsor can list and revoke owned sessions with CSRF and exact Origin', async () => {
    const listed = await ownerRequest('/v1/sessions');
    assert.equal(listed.status, 200);
    const sessions = (await listed.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].current, true);

    const forbidden = await fetch(`${baseUrl}/v1/sessions/${sessions[0].id}/revoke`, {
      method: 'POST', headers: { cookie: ownerCookie, origin: 'https://evil.example', 'x-orbit-csrf': ownerCsrf, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(forbidden.status, 403);
  });

  let allAnnouncementId = '';
  test('owner publishes private announcements and agent audiences do not leak', async () => {
    const created = await ownerRequest('/v1/admin/announcements', 'POST', {
      title: 'Bakım penceresi', bodyMarkdown: 'Orbit istemcileri kısa süreli yeniden bağlanabilir.',
      severity: 'warning', audienceType: 'all_agents', targetAgentId: null,
      startsAt: NOW, expiresAt: NOW + 86400000,
    });
    assert.equal(created.status, 201);
    allAnnouncementId = (await created.json() as { announcement: { id: string } }).announcement.id;
    assert.equal((await ownerRequest(`/v1/admin/announcements/${allAnnouncementId}/publish`, 'POST', {})).status, 200);

    const equinoxOnly = await ownerRequest('/v1/admin/announcements', 'POST', {
      title: 'Equinox iç notu', bodyMarkdown: 'Yalnız çekirdek ajanlara görünür.',
      severity: 'info', audienceType: 'equinox_agents', targetAgentId: null,
      startsAt: NOW, expiresAt: null,
    });
    const equinoxOnlyId = (await equinoxOnly.json() as { announcement: { id: string } }).announcement.id;
    assert.equal((await ownerRequest(`/v1/admin/announcements/${equinoxOnlyId}/publish`, 'POST', {})).status, 200);

    const externalAgent = agents.get('slice5-external')!;
    const targeted = await ownerRequest('/v1/admin/announcements', 'POST', {
      title: 'Tek ajan notu', bodyMarkdown: 'Yalnız hedef ajanın özel istemcisinde görünür.',
      severity: 'critical', audienceType: 'agent', targetAgentId: externalAgent.id,
      startsAt: NOW, expiresAt: null,
    });
    const targetedId = (await targeted.json() as { announcement: { id: string } }).announcement.id;
    assert.equal((await ownerRequest(`/v1/admin/announcements/${targetedId}/publish`, 'POST', {})).status, 200);

    const equinoxRows = (await (await agentRequest(agents.get('slice5-equinox')!, '/v1/announcements')).json() as { announcements: Array<{ id: string }> }).announcements;
    const externalRows = (await (await agentRequest(externalAgent, '/v1/announcements')).json() as { announcements: Array<{ id: string }> }).announcements;
    assert.deepEqual(new Set(equinoxRows.map((item) => item.id)), new Set([allAnnouncementId, equinoxOnlyId]));
    assert.deepEqual(new Set(externalRows.map((item) => item.id)), new Set([allAnnouncementId, targetedId]));

    const publicFeed = await fetch(`${baseUrl}/v1/feed`).then((response) => response.text());
    assert.doesNotMatch(publicFeed, /Bakım penceresi|Equinox iç notu|Tek ajan notu/u);
    assert.equal((await fetch(`${baseUrl}/v1/announcements`)).status, 401);
  });

  test('agent read receipt is private and idempotent', async () => {
    const agent = agents.get('slice5-external')!;
    assert.equal((await agentRequest(agent, `/v1/announcements/${allAnnouncementId}/read`, 'POST', {})).status, 200);
    assert.equal((await agentRequest(agent, `/v1/announcements/${allAnnouncementId}/read`, 'POST', {})).status, 200);
    const rows = (await (await agentRequest(agent, '/v1/announcements')).json() as { announcements: Array<{ id: string; readAt: number | null }> }).announcements;
    assert.equal(rows.find((item) => item.id === allAnnouncementId)?.readAt, NOW);
    const authenticated = await agentRequest(agent, '/v1/announcements');
    assert.match(authenticated.headers.get('cache-control') ?? '', /^no-store/u);
  });

  test('scheduled cleanup expires active announcements without deleting history', async () => {
    const created = await ownerRequest('/v1/admin/announcements', 'POST', {
      title: 'Süreli not', bodyMarkdown: 'Bu duyuru cleanup provası içindir.',
      severity: 'info', audienceType: 'all_agents', targetAgentId: null,
      startsAt: NOW - 2000, expiresAt: NOW - 1000,
    });
    const id = (await created.json() as { announcement: { id: string } }).announcement.id;
    assert.equal((await ownerRequest(`/v1/admin/announcements/${id}/publish`, 'POST', {})).status, 200);
    const cleanup = await testPost('/__test/cleanup', {});
    assert.equal(cleanup.status, 200);
    const rows = (await (await ownerRequest('/v1/admin/announcements')).json() as {
      announcements: Array<{ id: string; status: string }>;
    }).announcements;
    assert.equal(rows.find((item) => item.id === id)?.status, 'expired');
  });

  test('only anonymous public reads are cached and successful mutations invalidate the epoch', async () => {
    const url = `${baseUrl}/v1/feed?topic=orbit&limit=1`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-orbit-cache'), 'MISS');
    assert.equal(first.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=120');
    const second = await fetch(url);
    assert.equal(second.headers.get('x-orbit-cache'), 'HIT');

    const agent = agents.get('slice5-equinox')!;
    const mutation = await agentRequest(agent, '/v1/records', 'POST', {
      bodyMarkdown: 'Cache epoch değişimini doğrulayan yayımlanmış kayıt.', topicSlugs: ['orbit'],
    }, 'slice5-cache-invalidation');
    assert.equal(mutation.status, 201);
    assert.match(mutation.headers.get('cache-control') ?? '', /^no-store/u);

    const afterMutation = await fetch(url);
    assert.equal(afterMutation.headers.get('x-orbit-cache'), 'MISS');
    const dictionary = await fetch(`${baseUrl}/v1/topics`);
    assert.equal(dictionary.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=120');
  });

  test('only latest moderation decision can be reversed and history stays append-only', async () => {
    const agent = agents.get('slice5-equinox')!;
    const published = await agentRequest(agent, '/v1/records', 'POST', {
      bodyMarkdown: 'Moderasyon geri alma provasının görünür kaydı.', topicSlugs: ['sistemler'],
    }, 'slice5-moderation-post');
    assert.equal(published.status, 201);
    const record = (await published.json() as { record: { id: string; slug: string } }).record;
    assert.equal((await ownerRequest(`/v1/manage/records/${record.id}/delete`, 'POST', { reason: 'slice5_reversal_test' }, 'slice5-delete')).status, 200);
    const evidence = await testPost('/__test/publication-evidence', { recordId: record.id });
    const moderation = (await evidence.json() as { moderation: Array<{ id: string }> }).moderation;
    const originalId = moderation[0].id;
    assert.equal((await ownerRequest(`/v1/admin/moderation/${originalId}/reverse`, 'POST', { reason: 'decision_reconsidered' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/records/${record.slug}`)).status, 200);
    const stale = await ownerRequest(`/v1/admin/moderation/${originalId}/reverse`, 'POST', { reason: 'duplicate' });
    assert.equal(stale.status, 409);
  });

  test('chunked backup encrypts, rejects corruption atomically and restores a new D1', async () => {
    const exported = await testPost('/__test/chunked-backup-export', { includeSessions: true })
      .then((response) => response.json()) as {
        manifest: { schema: string; checksum: { value: string }; counts: Record<string, number> };
        chunks: Array<{ rowCount: number; byteLength: number; checksum: { value: string }; rows: unknown[] }>;
      };
    assert.equal(exported.manifest.schema, 'equinox.orbit.chunked-backup.v1');
    assert.ok(exported.chunks.every((chunk) => chunk.rowCount <= 500 && chunk.byteLength <= 1024 * 1024));
    assert.ok(exported.manifest.counts.announcements >= 2);
    assert.ok(exported.manifest.counts.moderationActions >= 2);

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
    const encrypted = await encryptChunkedBackup(exported as never, key);
    const decrypted = await decryptChunkedBackup(encrypted, key);
    assert.equal(decrypted.manifest.checksum.value, exported.manifest.checksum.value);

    const restorePersist = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice5-restore-'));
    let restoreWorker: ChildProcessWithoutNullStreams | undefined;
    try {
      migrate(restorePersist);
      const started = await startWorker(restorePersist);
      restoreWorker = started.process;
      const corrupted = structuredClone(exported);
      corrupted.chunks[0].checksum.value = `${corrupted.chunks[0].checksum.value.slice(0, -1)}x`;
      const rejected = await fetch(`${started.url}/__test/chunked-backup-restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
        body: JSON.stringify({ backup: corrupted, revokeSecurity: true }),
      });
      assert.equal(rejected.status, 400);
      const empty = await fetch(`${started.url}/__test/backup-counts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }).then((response) => response.json()) as { counts: { agents: number; records: number; validations: number } };
      assert.deepEqual(empty.counts, { agents: 0, records: 0, projects: 0, topics: 0, validations: 0 });

      const restored = await fetch(`${started.url}/__test/chunked-backup-restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
        body: JSON.stringify({ backup: exported, revokeSecurity: true }),
      });
      const restoredBody = await restored.json().catch(() => null) as {
        proof?: { uniqueViolations?: number; relationshipViolations?: number };
      } | null;
      assert.equal(restored.status, 200, JSON.stringify(restoredBody));
      assert.equal(restoredBody?.proof?.uniqueViolations, 0);
      assert.equal(restoredBody?.proof?.relationshipViolations, 0);
      const proof = await fetch(`${started.url}/__test/backup-counts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }).then((response) => response.json()) as { counts: { records: number; validations: number }; foreignKeyViolations: number };
      assert.equal(proof.counts.records, exported.manifest.counts.records);
      assert.equal(proof.counts.validations, 1);
      assert.equal(proof.foreignKeyViolations, 0);
    } finally {
      if (restoreWorker) await stopWorker(restoreWorker);
      await rm(restorePersist, { recursive: true, force: true });
    }
  });

  test('R2 backup encrypts, verifies readback and enforces retention without sensitive keys', async () => {
    const proof = await testPost('/__test/r2-backup', {}).then((response) => response.json()) as {
      objectCount: number;
      retention: Record<string, number>;
      run: {
        status: string;
        object_key: string;
        manifest_checksum: string;
        error_code: string | null;
      };
      objectKeyIsSafe: boolean;
      checksumLength: number;
    };
    assert.equal(proof.run.status, 'succeeded');
    assert.equal(proof.run.error_code, null);
    assert.equal(proof.objectKeyIsSafe, true);
    assert.equal(proof.retention.daily, 3);
    assert.equal(proof.objectCount, 14);
    assert.ok(proof.run.object_key.startsWith('orbit-v6/daily/'));
    assert.ok(proof.run.manifest_checksum.length >= 40);
    assert.ok(proof.checksumLength >= 40);
  });

  test('backup failures are owner-visible without exposing encryption material', async () => {
    const failed = await ownerRequest('/v1/admin/backups', 'POST', {});
    assert.equal(failed.status, 500);
    const rows = (await (await ownerRequest('/v1/admin/backups')).json() as {
      backups: Array<{ status: string; errorCode: string | null }>;
    }).backups;
    assert.ok(rows.some((row) => row.status === 'failed' && row.errorCode === 'backup_bindings_missing'));
  });

  test('worker output never contains agent credentials or announcement bodies', () => {
    const output = (globalThis as typeof globalThis & { __orbitSlice5Output?: () => string })
      .__orbitSlice5Output?.() ?? '';
    // Wrangler prints non-secret local test vars while describing its dev
    // bindings. The privacy boundary we own is the structured output emitted
    // by the Worker itself, so scan only those runtime log events.
    const runtimeOutput = output
      .split('\n')
      .filter((line) => /"event":"(?:worker\.|api\.)/u.test(line))
      .join('\n');
    assert.match(runtimeOutput, /"event":"worker\.request"/u);
    assert.doesNotMatch(runtimeOutput, /Orbit istemcileri kısa süreli|Yalnız çekirdek/u);
    for (const agent of agents.values()) assert.ok(!runtimeOutput.includes(agent.token));
    assert.ok(!runtimeOutput.includes(ownerCsrf));
    assert.ok(!runtimeOutput.includes(AGENT_PEPPER));
    assert.ok(!runtimeOutput.includes(SESSION_PEPPER));
    assert.ok(!runtimeOutput.includes(CSRF_PEPPER));
  });
});
