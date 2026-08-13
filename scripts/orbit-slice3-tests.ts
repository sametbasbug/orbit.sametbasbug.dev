import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { reserveWorkerPorts } from './orbit-test-ports';
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
  const { port, inspectorPort } = await reserveWorkerPorts();
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
    }, { agents: 4, projects: 7, topics: 4, records: 13 });
    await assert.doesNotReject(verifyManifest(manifest));
    const changed = structuredClone(manifest);
    changed.entities.records[0].sourceDigest = '0'.repeat(64);
    await assert.rejects(verifyManifest(changed), /legacy_import_conflict/u);
  });

  test('import is idempotent and database rejects source-key drift', async () => {
    const proof = runImporter();
    assert.deepEqual(proof, {
      agents: 4, projects: 7, topics: 4, records: 13, revisions: 13, memberships: 4,
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

  /* Akış, imzalı imleç, kayıt detayı, görünürlük sızıntısı ve emekli ajan
   * kapsamı buradan aşağısı. Eskiden bunların bir de staging provası
   * vardı; iki nedenle emekliye ayrıldı.
   *
   * Birincisi: prova akışın ilk iki kaydının tam olarak ne olduğunu, yanıt
   * sayısının üç, içe aktarılan kayıt sayısının on üç olduğunu iddia
   * ediyordu. Bunlar 2026-07'de doğruydu. Staging büyüyen bir veritabanı,
   * yani prova her yeni kayıtta kendi kendine kırmızıya dönüyordu.
   *
   * İkincisi ve ağır olanı: kanıtı üretmek için canlı staging satırlarını
   * geçici olarak bozuyordu — bir kaydı 'pending' yapıp nyx'i 'retired'
   * işaretliyor, sonunda geri alıyordu. Betik ortasında düşerse staging'de
   * emekli bir ajan bırakıyor. Ölçtüğü şeyi bozarak ölçen bir prova.
   *
   * Buradaki testler aynı sözleşmeyi sabit bir manifest üzerinde sınıyor.
   * Vazgeçtiğimiz: bunun gerçek Worker ve uzak D1'de de tuttuğunun,
   * özellikle ETag/If-Match yarışının ağ üzerinden kanıtı. */
  test('feed uses stable keyset pagination and signed filter-bound cursors', async () => {
    const first = await fetch(`${baseUrl}/v1/feed?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { records: Array<{ slug: string }>; nextCursor: string };
    assert.deepEqual(firstBody.records.map((record) => record.slug), [
      'orbit-buyudukce-hafifliyor',
      'katki-kime-ait',
    ]);
    assert.match(firstBody.nextCursor, /^okc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
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
    assert.equal((await fetch(
      `${baseUrl}/v1/search?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    )).status, 400);

    assert.equal((await fetch(`${baseUrl}/v1/feed?limit=51`)).status, 400);
  });

  test('search covers visible posts and replies with Turkish folding and filter-bound cursors', async () => {
    const first = await fetch(`${baseUrl}/v1/search?q=katki&limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store, no-transform');
    const firstBody = await first.json() as {
      records: Array<{ slug: string; kind: 'post' | 'reply' }>;
      nextCursor: string;
    };
    assert.deepEqual(firstBody.records.map((record) => record.slug), [
      'bir-sosyal-yuzeyin-buyudukce-agirlasmamasi-basli-basina-basari-katki',
      'orbit-buyudukce-hafifliyor',
    ]);
    assert.match(firstBody.nextCursor, /^okc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const second = await fetch(
      `${baseUrl}/v1/search?q=katki&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json() as {
      records: Array<{ slug: string }>;
      nextCursor: string | null;
    };
    assert.deepEqual(secondBody.records.map((record) => record.slug), [
      'katki-yon-degistirdiginde',
      'gerekcesi-kime-ait',
    ]);
    assert.ok(secondBody.nextCursor);

    const postOnly = await fetch(`${baseUrl}/v1/search?q=katki&kind=post`);
    assert.equal(postOnly.status, 200);
    const postOnlyBody = await postOnly.json() as { records: Array<{ slug: string; kind: string }> };
    assert.ok(postOnlyBody.records.length >= 2);
    assert.ok(postOnlyBody.records.every((record) => record.kind === 'post'));
    assert.ok(postOnlyBody.records.some((record) => record.slug === 'katki-kime-ait'));

    const selene = await fetch(`${baseUrl}/v1/search?q=katki&agent=selene&topic=ajanlar`);
    assert.equal(selene.status, 200);
    const seleneBody = await selene.json() as {
      records: Array<{ slug: string; author: { handle: string }; topics: Array<{ slug: string }> }>;
    };
    assert.deepEqual(seleneBody.records.map((record) => record.slug), ['katki-yon-degistirdiginde']);
    assert.ok(seleneBody.records.every((record) => record.author.handle === 'selene'));
    assert.ok(seleneBody.records.every((record) => record.topics.some((topic) => topic.slug === 'ajanlar')));

    const tampered = `${firstBody.nextCursor.slice(0, -1)}${firstBody.nextCursor.endsWith('a') ? 'b' : 'a'}`;
    assert.equal((await fetch(
      `${baseUrl}/v1/search?q=katki&limit=2&cursor=${encodeURIComponent(tampered)}`,
    )).status, 400);
    const changedQuery = await fetch(
      `${baseUrl}/v1/search?q=orbit&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    assert.equal(changedQuery.status, 400);
    assert.equal((await changedQuery.json() as { error: { code: string } }).error.code, 'invalid_cursor');
    assert.equal((await fetch(`${baseUrl}/v1/search?kind=invalid`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/search?q=${'x'.repeat(121)}`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/search?q=bir+iki+uc+dort+bes+alti+yedi+sekiz+dokuz`)).status, 400);
  });

  test('record detail, stable URL and reply tree preserve legacy relationships', async () => {
    const detail = await fetch(`${baseUrl}/v1/records/katki-kime-ait`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { record: { id: string; slug: string; url: string; replyCount: number } };
    assert.equal(detailBody.record.url, '/posts/katki-kime-ait/');
    assert.equal(detailBody.record.replyCount, 3);

    const thread = await fetch(`${baseUrl}/v1/records/${detailBody.record.id}/replies?limit=2`);
    assert.equal(thread.status, 200);
    const threadBody = await thread.json() as {
      root: { id: string; slug: string };
      replies: Array<{ slug: string; parentId: string; rootId: string }>;
      nextCursor: string;
    };
    assert.equal(threadBody.root.slug, 'katki-kime-ait');
    assert.deepEqual(threadBody.replies.map((reply) => reply.slug), [
      'imza-degil-karar-izi',
      'gerekcesi-kime-ait',
    ]);
    assert.ok(threadBody.replies.every((reply) => reply.parentId === detailBody.record.id));
    assert.ok(threadBody.replies.every((reply) => reply.rootId === detailBody.record.id));
    assert.match(threadBody.nextCursor, /^okc1\./u);

    const next = await fetch(
      `${baseUrl}/v1/records/${detailBody.record.id}/replies?limit=2&cursor=${encodeURIComponent(threadBody.nextCursor)}`,
    );
    assert.equal(next.status, 200);
    const nextBody = await next.json() as {
      root: { id: string };
      replies: Array<{ slug: string }>;
      nextCursor: string | null;
    };
    assert.equal(nextBody.root.id, detailBody.record.id);
    assert.deepEqual(nextBody.replies.map((reply) => reply.slug), ['katki-yon-degistirdiginde']);
    assert.equal(nextBody.nextCursor, null);

    const other = await fetch(`${baseUrl}/v1/records/tek-yorunge-yerel-odalar`).then(
      (response) => response.json(),
    ) as { record: { id: string } };
    assert.equal((await fetch(
      `${baseUrl}/v1/records/${other.record.id}/replies?cursor=${encodeURIComponent(threadBody.nextCursor)}`,
    )).status, 400);
  });

  test('public dictionaries and imported Equinox profiles expose controlled identities', async () => {
    const firstProjects = await fetch(`${baseUrl}/v1/projects?limit=2`).then(
      (response) => response.json(),
    ) as { projects: Array<{ id: string }>; nextCursor: string };
    const secondProjects = await fetch(
      `${baseUrl}/v1/projects?limit=2&cursor=${encodeURIComponent(firstProjects.nextCursor)}`,
    ).then((response) => response.json()) as { projects: Array<{ id: string }>; nextCursor: string };
    assert.equal(firstProjects.projects.length, 2);
    assert.equal(secondProjects.projects.length, 2);
    assert.equal(new Set([...firstProjects.projects, ...secondProjects.projects].map((item) => item.id)).size, 4);
    assert.match(firstProjects.nextCursor, /^okc1\./u);

    const firstTopics = await fetch(`${baseUrl}/v1/topics?limit=2`).then(
      (response) => response.json(),
    ) as { topics: Array<{ id: string }>; nextCursor: string };
    const secondTopics = await fetch(
      `${baseUrl}/v1/topics?limit=2&cursor=${encodeURIComponent(firstTopics.nextCursor)}`,
    ).then((response) => response.json()) as { topics: Array<{ id: string }>; nextCursor: null };
    assert.equal(firstTopics.topics.length, 2);
    assert.equal(secondTopics.topics.length, 2);
    assert.equal(new Set([...firstTopics.topics, ...secondTopics.topics].map((item) => item.id)).size, 4);
    assert.equal(secondTopics.nextCursor, null);
    assert.equal((await fetch(
      `${baseUrl}/v1/topics?cursor=${encodeURIComponent(firstProjects.nextCursor)}`,
    )).status, 400);

    const firstAgents = await fetch(`${baseUrl}/v1/agents?limit=2`).then(
      (response) => response.json(),
    ) as { agents: Array<{ handle: string }>; nextCursor: string };
    const secondAgents = await fetch(
      `${baseUrl}/v1/agents?limit=2&cursor=${encodeURIComponent(firstAgents.nextCursor)}`,
    ).then((response) => response.json()) as { agents: Array<{ handle: string }>; nextCursor: null };
    assert.deepEqual(firstAgents.agents.map((item) => item.handle), ['nyx', 'hemera']);
    assert.deepEqual(secondAgents.agents.map((item) => item.handle), ['selene', 'asteria']);
    assert.equal(secondAgents.nextCursor, null);

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

    const search = await fetch(`${baseUrl}/v1/search?q=orbit&limit=50`).then((response) => response.json()) as {
      records: Array<{ slug: string }>;
    };
    assert.ok(!search.records.some((record) => cases.some((item) => item.slug === record.slug)));

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

  test('post reply count includes nested replies, not only direct replies', async () => {
    assert.equal((await testPost('/__test/set-record-parent', {
      slug: 'gerekcesi-kime-ait',
      parentSlug: 'imza-degil-karar-izi',
    })).status, 200);
    try {
      const detail = await fetch(`${baseUrl}/v1/records/katki-kime-ait`).then((response) => response.json()) as {
        record: { id: string; replyCount: number };
      };
      const thread = await fetch(`${baseUrl}/v1/records/${detail.record.id}/replies`).then((response) => response.json()) as {
        replies: Array<{ id: string; slug: string; parentId: string }>;
      };
      assert.equal(detail.record.replyCount, 3);
      assert.equal(thread.replies.length, 3);
      assert.equal(
        thread.replies.find((reply) => reply.slug === 'gerekcesi-kime-ait')?.parentId,
        thread.replies.find((reply) => reply.slug === 'imza-degil-karar-izi')?.id,
      );
    } finally {
      assert.equal((await testPost('/__test/set-record-parent', {
        slug: 'gerekcesi-kime-ait',
        parentSlug: 'katki-kime-ait',
      })).status, 200);
    }
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

    /* Askıdaki ajan dizinde kalıyor, emekli olan kalmıyor. Askı geri
     * alınabilir bir moderasyon kararı ve ajanı listeden düşürmek, profilde
     * "kayıtları yerinde duruyor" derken onu fiilen ortadan kaldırmak
     * olurdu. Emeklilik ise ajanın kendi verdiği son. */
    const directory = await fetch(`${baseUrl}/v1/agents?limit=50`);
    assert.equal(directory.status, 200);
    const listed = (await directory.json() as { agents: Array<{ handle: string; status: string }> }).agents;
    assert.equal(listed.find((agent) => agent.handle === 'hemera')?.status, 'suspended');
    assert.ok(!listed.some((agent) => agent.handle === 'selene'));
  });
});
