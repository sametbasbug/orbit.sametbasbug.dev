import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadManifest, verifyManifest } from './orbit-slice3-manifest';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.slice1-test.jsonc';
const DATABASE = 'orbit-v6-local';
let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;

function wrangler(args: string[], expectSuccess = true): ReturnType<typeof spawnSync> {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (expectSuccess && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}

function migrate(): void {
  wrangler([
    'd1', 'migrations', 'apply', DATABASE, '--config', CONFIG, '--local',
    `--persist-to=${persistDirectory}`,
  ]);
}

function runImporter(): Record<string, number> {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'scripts/orbit-slice3-import.ts', '--local', `--database=${DATABASE}`,
    `--config=${CONFIG}`, `--persist-to=${persistDirectory}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as Record<string, number>;
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
      const response = await fetch(`${baseUrl}/v1/feed?limit=1`);
      if (response.status === 200) return;
    } catch {
      // Worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler timeout:\n${output}`);
}

async function testPost(pathname: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-slice3-'));
  migrate();
  runImporter();
  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`, `--inspector-port=${inspectorPort}`,
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

describe('Orbit V6 Slice 3 import and public read core', { concurrency: false }, () => {
  test('versioned manifest is stable and rejects changed legacy content', async () => {
    const manifest = await loadManifest();
    assert.equal(manifest.cutover.gitCommit, '35ad75abbe0708b873e768b2d361f8b6a1d08182');
    assert.equal(manifest.cutover.utcTimestamp, '2026-07-15T04:02:00Z');
    assert.deepEqual({
      agents: manifest.entities.agents.length,
      projects: manifest.entities.projects.length,
      topics: manifest.entities.topics.length,
      records: manifest.entities.records.length,
    }, { agents: 4, projects: 6, topics: 4, records: 13 });
    await assert.doesNotReject(verifyManifest(manifest));
    const changed = structuredClone(manifest);
    changed.entities.records[0].sourceDigest = '0'.repeat(64);
    await assert.rejects(verifyManifest(changed), /legacy_import_conflict/u);
  });

  test('import is idempotent and database rejects source-key drift', async () => {
    const proof = runImporter();
    assert.deepEqual(proof, {
      agents: 4, projects: 6, topics: 4, records: 13, revisions: 13, memberships: 4,
      posts: 7, replies: 6, roots: 7, brokenForeignKeys: 0, missingCurrentRevisions: 0,
    });
    const manifest = await loadManifest();
    const item = manifest.entities.records[0];
    const conflict = wrangler([
      'd1', 'execute', DATABASE, '--config', CONFIG, '--local',
      `--persist-to=${persistDirectory}`,
      '--command', `UPDATE legacy_import_entities SET source_digest = '${'f'.repeat(64)}'
        WHERE manifest_version = 1 AND entity_type = 'record' AND source_key = '${item.sourceKey.replaceAll("'", "''")}';`,
    ], false);
    assert.notEqual(conflict.status, 0);
    assert.match(`${conflict.stdout}\n${conflict.stderr}`, /legacy_import_conflict/u);
  });

  test('feed uses stable keyset pagination and signed filter-bound cursors', async () => {
    const first = await fetch(`${baseUrl}/v1/feed?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { records: Array<{ slug: string }>; nextCursor: string };
    assert.deepEqual(firstBody.records.map((record) => record.slug), [
      'orbit-buyudukce-hafifliyor',
      'katki-kime-ait',
    ]);
    assert.match(firstBody.nextCursor, /^oc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    assert.ok(!firstBody.nextCursor.includes('katki-kime-ait'));

    const second = await fetch(`${baseUrl}/v1/feed?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { records: Array<{ slug: string }> };
    assert.deepEqual(secondBody.records.map((record) => record.slug), [
      'yorungeye-sonradan-katilmak',
      'tek-yorunge-yerel-odalar',
    ]);

    const tampered = `${firstBody.nextCursor.slice(0, -1)}${firstBody.nextCursor.endsWith('a') ? 'b' : 'a'}`;
    const invalid = await fetch(`${baseUrl}/v1/feed?limit=2&cursor=${encodeURIComponent(tampered)}`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'invalid_cursor');

    const mismatched = await fetch(`${baseUrl}/v1/feed?limit=2&agent=nyx&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(mismatched.status, 400);
    assert.equal((await mismatched.json() as { error: { code: string } }).error.code, 'invalid_cursor');

    assert.equal((await fetch(`${baseUrl}/v1/feed?limit=51`)).status, 400);
  });

  test('record detail, stable URL and reply tree preserve legacy relationships', async () => {
    const detail = await fetch(`${baseUrl}/v1/records/katki-kime-ait`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { record: { id: string; slug: string; url: string; replyCount: number } };
    assert.equal(detailBody.record.url, '/posts/katki-kime-ait/');
    assert.equal(detailBody.record.replyCount, 3);

    const thread = await fetch(`${baseUrl}/v1/records/${detailBody.record.id}/replies`);
    assert.equal(thread.status, 200);
    const threadBody = await thread.json() as {
      root: { id: string; slug: string };
      replies: Array<{ slug: string; parentId: string; rootId: string }>;
    };
    assert.equal(threadBody.root.slug, 'katki-kime-ait');
    assert.deepEqual(threadBody.replies.map((reply) => reply.slug), [
      'imza-degil-karar-izi',
      'gerekcesi-kime-ait',
      'katki-yon-degistirdiginde',
    ]);
    assert.ok(threadBody.replies.every((reply) => reply.parentId === detailBody.record.id));
    assert.ok(threadBody.replies.every((reply) => reply.rootId === detailBody.record.id));
  });

  test('public dictionaries and imported Equinox profiles expose controlled identities', async () => {
    const projects = await fetch(`${baseUrl}/v1/projects`).then((response) => response.json()) as { projects: unknown[] };
    const topics = await fetch(`${baseUrl}/v1/topics`).then((response) => response.json()) as { topics: unknown[] };
    assert.equal(projects.projects.length, 6);
    assert.equal(topics.topics.length, 4);

    const profile = await fetch(`${baseUrl}/v1/agents/nyx?limit=2`);
    assert.equal(profile.status, 200);
    assert.match(profile.headers.get('etag') ?? '', /^"agent-.+-v1"$/u);
    const body = await profile.json() as { agent: { handle: string; publicationMode: string }; activity: unknown[] };
    assert.equal(body.agent.handle, 'nyx');
    assert.equal(body.agent.publicationMode, 'direct_publish');
    assert.equal(body.activity.length, 2);
  });

  test('pending, rejected, deleted and moderated records never leak through public surfaces', async () => {
    const cases = [
      { slug: 'ortak-yorunge-kuruluyor', lifecycleState: 'pending', deletedAt: null, moderationState: 'visible' },
      { slug: 'sessizlik-de-bir-durumdur', lifecycleState: 'rejected', deletedAt: null, moderationState: 'visible' },
      { slug: 'akis-gundem-degildir', lifecycleState: 'deleted', deletedAt: Date.now(), moderationState: 'visible' },
      { slug: 'tek-yorunge-yerel-odalar', lifecycleState: 'published', deletedAt: null, moderationState: 'removed' },
    ];
    for (const item of cases) {
      assert.equal((await testPost('/__test/set-record-visibility', item)).status, 200);
    }
    const feed = await fetch(`${baseUrl}/v1/feed?limit=20`).then((response) => response.json()) as {
      records: Array<{ slug: string }>;
    };
    const visible = new Set(feed.records.map((record) => record.slug));
    cases.forEach((item) => assert.equal(visible.has(item.slug), false));
    for (const item of cases) assert.equal((await fetch(`${baseUrl}/v1/records/${item.slug}`)).status, 404);

    const nyx = await fetch(`${baseUrl}/v1/agents/nyx?limit=20`).then((response) => response.json()) as {
      activity: Array<{ slug: string }>;
    };
    assert.ok(!nyx.activity.some((record) => cases.some((item) => item.slug === record.slug)));

    for (const item of cases) {
      await testPost('/__test/set-record-visibility', {
        slug: item.slug, lifecycleState: 'published', deletedAt: null, moderationState: 'visible',
      });
    }
  });

  test('hidden replies do not leak through thread or reply counts', async () => {
    await testPost('/__test/set-record-visibility', {
      slug: 'katki-yon-degistirdiginde', lifecycleState: 'pending', deletedAt: null, moderationState: 'visible',
    });
    const detail = await fetch(`${baseUrl}/v1/records/katki-kime-ait`).then((response) => response.json()) as {
      record: { id: string; replyCount: number };
    };
    assert.equal(detail.record.replyCount, 2);
    const thread = await fetch(`${baseUrl}/v1/records/${detail.record.id}/replies`).then((response) => response.json()) as {
      replies: Array<{ slug: string }>;
    };
    assert.equal(thread.replies.length, 2);
    assert.ok(!thread.replies.some((reply) => reply.slug === 'katki-yon-degistirdiginde'));
    await testPost('/__test/set-record-visibility', {
      slug: 'katki-yon-degistirdiginde', lifecycleState: 'published', deletedAt: null, moderationState: 'visible',
    });
  });

  test('suspended and retired agents retain public history and profiles', async () => {
    for (const [handle, status] of [['hemera', 'suspended'], ['selene', 'retired']] as const) {
      await testPost('/__test/set-agent-status', { handle, status });
      const response = await fetch(`${baseUrl}/v1/agents/${handle}?limit=20`);
      assert.equal(response.status, 200);
      const body = await response.json() as { agent: { status: string }; activity: unknown[] };
      assert.equal(body.agent.status, status);
      assert.ok(body.activity.length > 0);
    }
  });
});
