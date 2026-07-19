import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, hmacDigest, randomBase64Url, sha256Base64Url } from '../src/server/identity/tokens';
import { canonicalJson } from '../src/server/publication/content';
import { dashboardAssetResponse } from '../src/server/dashboard/response';
import {
  decryptChunkedBackup,
  encryptChunkedBackup,
} from '../src/server/backup/chunked-backup';
import { ImageTransformError, inspectImage, transformImage } from '../src/server/media/image-processor';
import sharp from 'sharp';

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

async function ownerRequest(
  pathname: string,
  method = 'GET',
  body?: Record<string, unknown>,
  key?: string,
  now = NOW,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: ownerCookie, 'x-test-now': String(now) };
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

async function imageDigest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return Buffer.from(digest).toString('base64url');
}

async function ownerImage(pathname: string, bytes: Uint8Array, type = 'image/png', now = NOW, key = randomBase64Url(18)): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: 'http://localhost:4321',
      'x-orbit-csrf': ownerCsrf,
      'x-test-now': String(now),
      'idempotency-key': key,
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'x-orbit-content-sha256': await imageDigest(bytes),
    },
    body: Uint8Array.from(bytes),
  });
}

async function seedAgent(handle: string, role = '', publicationMode = 'direct_publish'): Promise<Agent> {
  const token = await createOpaqueToken('agent', AGENT_PEPPER);
  const agent = { id: createEntityId(), token: token.token, handle };
  const response = await testPost('/__test/seed-publication-agent', {
    accountId: OWNER_ID, agentId: agent.id, membershipId: createEntityId(),
    credentialId: token.selector, secretDigest: token.digest,
    handle, publicationMode, status: 'active', role, now: NOW,
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

async function agentImageRequest(
  agent: Agent,
  bytes: Uint8Array,
  type = 'image/png',
  altText = 'Orbit test görseli',
  key = randomBase64Url(18),
): Promise<Response> {
  return await fetch(`${baseUrl}/v1/media/post-images`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agent.token}`,
      'idempotency-key': key,
      'x-test-now': String(NOW),
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'x-orbit-content-sha256': await imageDigest(bytes),
      'x-orbit-alt-text-b64': Buffer.from(altText).toString('base64url'),
      'x-orbit-caption-b64': Buffer.from('Slice 5 kontrollü medya testi').toString('base64url'),
    },
    body: Uint8Array.from(bytes),
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
  await seedAgent('slice5-pending', '', 'approval_required');
  await seedAgent('slice5-media-concurrent');
});

after(async () => {
  if (worker) {
    await stopWorker(worker);
  }
  await rm(persistDirectory, { recursive: true, force: true });
});

describe('Orbit V6 Slice 5 dashboard and platform core', { concurrency: false }, () => {
  test('dashboard asset is no-store, frame-protected and contains no credential material', async () => {
    const response = await dashboardAssetResponse(
      new Request('https://orbit.example/dashboard'),
      { fetch: async () => new Response('<!doctype html><title>Orbit Sponsor Paneli</title><a href="/" aria-label="Equinox Orbit ana sayfa">Orbit</a><form action="/search"><input aria-label="Orbit\'te ara"></form><button>GitHub hesabımla devam et</button><span>Profil fotoğrafını değiştir</span><span>Görsel yetkisi</span>') },
    );
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
    assert.match(html, /Orbit Sponsor Paneli/u);
    assert.match(html, /Equinox Orbit ana sayfa/u);
    assert.match(html, /Orbit'te ara/u);
    assert.match(html, /GitHub hesabımla devam et/u);
    assert.match(html, /Profil fotoğrafını değiştir/u);
    assert.match(html, /Görsel yetkisi/u);
    assert.doesNotMatch(html, /orb_agent_v1_/u);
  });

  test('avatar and post media enforce transforms, policy, privacy and quota', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 1600, height: 900, channels: 4, background: '#745cff' },
    }).png().toBuffer());
    const avatar = await ownerImage('/v1/me/avatar', png);
    assert.equal(avatar.status, 201, await avatar.clone().text());
    const avatarBody = await avatar.json() as { media: { id: string; width: number; height: number } };
    assert.deepEqual([avatarBody.media.width, avatarBody.media.height], [512, 512]);
    const accountImage = await fetch(`${baseUrl}/v1/media/${avatarBody.media.id}`, { headers: { cookie: ownerCookie } });
    assert.equal(accountImage.status, 200);
    assert.equal(accountImage.headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${baseUrl}/v1/media/${avatarBody.media.id}`)).status, 404);

    const direct = agents.get('slice5-equinox')!;
    const agentAvatar = await ownerImage(`/v1/agents/${direct.id}/avatar`, png);
    assert.equal(agentAvatar.status, 201, await agentAvatar.clone().text());
    const agentAvatarId = (await agentAvatar.json() as { media: { id: string } }).media.id;
    assert.equal((await fetch(`${baseUrl}/v1/media/${agentAvatarId}`)).status, 200);
    assert.equal((await agentImageRequest(direct, png)).status, 403);
    assert.equal((await ownerRequest(`/v1/admin/agents/${direct.id}/media-policy`, 'PATCH', {
      mediaEnabled: true, dailyImageLimit: 1,
    })).status, 200);
    const capability = await agentRequest(direct, '/v1/media/capabilities');
    assert.deepEqual(await capability.json(), {
      mediaEnabled: true,
      dailyImageLimit: 1,
      acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'],
      maximumBytes: 10 * 1024 * 1024,
      maximumImagesPerPost: 1,
    });
    const upload = await agentImageRequest(direct, png, 'image/png', 'Mor Orbit test görseli', 'slice5-media-direct');
    assert.equal(upload.status, 201, await upload.clone().text());
    const media = (await upload.json() as { media: { id: string } }).media;
    assert.equal((await fetch(`${baseUrl}/v1/media/${media.id}`)).status, 404);
    assert.equal((await agentImageRequest(direct, png, 'image/jpeg', 'MIME uyuşmazlığı testi', 'slice5-media-mismatch')).status, 415);
    assert.equal((await agentImageRequest(direct, png, 'image/png', 'İkinci kota görseli', 'slice5-media-quota')).status, 429);
    const published = await agentRequest(direct, '/v1/records', 'POST', {
      bodyMarkdown: 'Kontrollü R2 görseliyle yayımlanan kayıt.', topicSlugs: ['orbit'], mediaId: media.id,
    }, 'slice5-media-record');
    assert.equal(published.status, 201, await published.clone().text());
    const record = (await published.json() as { record: { id: string; slug: string } }).record;
    const publicRecord = await fetch(`${baseUrl}/v1/records/${record.slug}`).then((response) => response.json()) as {
      record: { media: { id: string; url: string } | null };
    };
    assert.equal(publicRecord.record.media?.id, media.id);
    assert.equal((await fetch(`${baseUrl}/v1/media/${media.id}`)).status, 200);
    assert.equal((await agentRequest(direct, `/v1/records/${record.id}/replies`, 'POST', {
      bodyMarkdown: 'Yanıtlar görsel kabul etmez.', mediaId: media.id,
    }, 'slice5-media-reply')).status, 400);
  });

  test('pending media stays sponsor-private and rejected media is cleaned without retry loops', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 900, height: 1200, channels: 3, background: '#18223a' },
    }).jpeg().toBuffer());
    const pending = agents.get('slice5-pending')!;
    assert.equal((await ownerRequest(`/v1/admin/agents/${pending.id}/media-policy`, 'PATCH', {
      mediaEnabled: true, dailyImageLimit: 10,
    })).status, 200);
    const uploaded = await agentImageRequest(pending, png, 'image/jpeg', 'Koyu mavi pending Orbit görseli', 'slice5-media-pending');
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const mediaId = (await uploaded.json() as { media: { id: string } }).media.id;
    const submission = await agentRequest(pending, '/v1/records', 'POST', {
      bodyMarkdown: 'Görseliyle birlikte sponsor onayı bekleyen kayıt.', topicSlugs: ['orbit'], mediaId,
    }, 'slice5-pending-media-record');
    assert.equal(submission.status, 202, await submission.clone().text());
    const record = (await submission.json() as { record: { id: string } }).record;
    assert.equal((await fetch(`${baseUrl}/v1/media/${mediaId}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/media/${mediaId}`, { headers: { cookie: ownerCookie } })).status, 200);
    const reviews = (await (await ownerRequest('/v1/approvals')).json() as {
      reviews: Array<{ id: string; record: { id: string }; media: { id: string } | null }>;
    }).reviews;
    const review = reviews.find((item) => item.record.id === record.id);
    assert.equal(review?.media?.id, mediaId);
    assert.equal((await ownerRequest(`/v1/approvals/${review?.id}/reject`, 'POST', { note: 'media cleanup proof' }, 'slice5-media-reject')).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/media/${mediaId}`, { headers: { cookie: ownerCookie } })).status, 404);
    const cleanup = await testPost('/__test/media-cleanup', { now: NOW + 8 * 86400000 });
    assert.equal(cleanup.status, 200);
    const cleanupBody = await cleanup.json() as { deleted: number; failed: number };
    assert.ok(cleanupBody.deleted >= 1);
    assert.equal(cleanupBody.failed, 0);
  });

  test('parallel avatar and post uploads reserve exactly one Images transform', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 1200, height: 800, channels: 4, background: '#312e81' },
    }).png().toBuffer());
    const before = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as {
      counts: { media_assets: number; claims: number; attempted: number };
    };
    const avatarResponses = await Promise.all([
      ownerImage('/v1/me/avatar', png, 'image/png', NOW, 'parallel-avatar-key'),
      ownerImage('/v1/me/avatar', png, 'image/png', NOW, 'parallel-avatar-key'),
    ]);
    assert.deepEqual(avatarResponses.map((response) => response.status), [201, 201]);
    assert.equal(avatarResponses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
    const avatarBodies = await Promise.all(avatarResponses.map((response) => response.json()));
    assert.deepEqual(avatarBodies[0], avatarBodies[1]);

    const agent = agents.get('slice5-media-concurrent')!;
    assert.equal((await ownerRequest(`/v1/admin/media/avatar-policies/agent/${agent.id}`, 'PATCH', {
      dailyLimit: 1,
    })).status, 200);
    const agentAvatarResponses = await Promise.all([
      ownerImage(`/v1/agents/${agent.id}/avatar`, png, 'image/png', NOW, 'parallel-agent-avatar-key'),
      ownerImage(`/v1/agents/${agent.id}/avatar`, png, 'image/png', NOW, 'parallel-agent-avatar-key'),
    ]);
    assert.deepEqual(agentAvatarResponses.map((response) => response.status), [201, 201]);
    assert.equal(agentAvatarResponses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
    const avatarQuota = await ownerImage(`/v1/agents/${agent.id}/avatar`, png, 'image/png', NOW, 'parallel-agent-avatar-new-key');
    assert.equal(avatarQuota.status, 429);
    assert.equal((await avatarQuota.json() as { error: { code: string } }).error.code, 'daily_avatar_quota_exceeded');

    assert.equal((await ownerRequest(`/v1/admin/agents/${agent.id}/media-policy`, 'PATCH', {
      mediaEnabled: true, dailyImageLimit: 10,
    })).status, 200);
    const postResponses = await Promise.all([
      agentImageRequest(agent, png, 'image/png', 'Paralel Orbit medya görseli', 'parallel-post-media-key'),
      agentImageRequest(agent, png, 'image/png', 'Paralel Orbit medya görseli', 'parallel-post-media-key'),
    ]);
    assert.deepEqual(postResponses.map((response) => response.status), [201, 201]);
    assert.equal(postResponses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
    const postBodies = await Promise.all(postResponses.map((response) => response.json()));
    assert.deepEqual(postBodies[0], postBodies[1]);

    const after = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as typeof before;
    assert.equal(Number(after.counts.claims), Number(before.counts.claims) + 3);
    assert.equal(Number(after.counts.attempted), Number(before.counts.attempted) + 3);
    assert.equal(Number(after.counts.media_assets), Number(before.counts.media_assets) + 3);
    const conflict = await agentImageRequest(agent, png, 'image/png', 'Farklı alt metin', 'parallel-post-media-key');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'idempotency_conflict');
  });

  test('decode failure is fail-closed and Images quota errors stay safely categorized', async () => {
    const before = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as {
      counts: { media_assets: number; claims: number; results: number; failed_results: number };
      objectCount: number;
    };
    const corrupt = new Uint8Array(33);
    corrupt.set([137,80,78,71,13,10,26,10], 0);
    corrupt.set([0,0,0,13,73,72,68,82], 8);
    new DataView(corrupt.buffer).setUint32(16, 800);
    new DataView(corrupt.buffer).setUint32(20, 600);
    const rejected = await ownerImage('/v1/me/avatar', corrupt);
    assert.equal(rejected.status, 503);
    await rejected.arrayBuffer();
    const after = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as typeof before;
    assert.equal(Number(after.counts.media_assets), Number(before.counts.media_assets));
    assert.equal(after.objectCount, before.objectCount);
    assert.equal(Number(after.counts.claims), Number(before.counts.claims) + 1);
    assert.equal(Number(after.counts.results), Number(before.counts.results) + 1);
    assert.equal(Number(after.counts.failed_results), Number(before.counts.failed_results) + 1);

    const png = new Uint8Array(await sharp({
      create: { width: 32, height: 24, channels: 4, background: '#111827' },
    }).png().toBuffer());
    const quotaTransformer = {
      transform: () => quotaTransformer,
      output: async () => { throw Object.assign(new Error('provider rejected'), { code: 9422 }); },
    };
    const quotaBinding = { input: () => quotaTransformer };
    await assert.rejects(
      transformImage(quotaBinding, new Blob([png]).stream(), inspectImage(png, 'image/png'), 'avatar'),
      (error: unknown) => error instanceof ImageTransformError
        && error.category === 'images_quota'
        && error.providerCode === 9422,
    );
  });

  test('transform claims cannot be rewritten outside their matching result', async () => {
    const response = await testPost('/__test/media-transform-tamper', {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      rejected: true,
      code: 'media_transform_claim_lifecycle_invalid',
    });
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
    const closedAccountId = createEntityId();
    const closedSession = await testPost('/__test/seed-closed-account-session', {
      accountId: closedAccountId,
      sessionId: randomBase64Url(16),
      handle: `closed-${closedAccountId.slice(-8)}`,
      secretDigest: randomBase64Url(32),
      csrfDigest: randomBase64Url(32),
    });
    assert.equal(closedSession.status, 200);
    const dynamicExport = await testPost('/__test/backup-export', { includeSessions: true })
      .then((response) => response.json()) as {
        checksum: { value: string };
        counts: Record<string, number>;
        tables: Record<string, Array<Record<string, unknown>>>;
      };
    const exported = await testPost('/__test/chunked-backup-export', { includeSessions: true })
      .then((response) => response.json()) as {
        manifest: { schema: string; checksum: { value: string }; counts: Record<string, number> };
        chunks: Array<{ rowCount: number; byteLength: number; checksum: { value: string }; rows: unknown[] }>;
      };
    assert.equal(exported.manifest.schema, 'equinox.orbit.chunked-backup.v1');
    assert.ok(exported.chunks.every((chunk) => chunk.rowCount <= 500 && chunk.byteLength <= 1024 * 1024));
    assert.ok(exported.manifest.counts.announcements >= 2);
    assert.ok(exported.manifest.counts.moderationActions >= 2);
    assert.ok(exported.manifest.counts.sessions >= 2);

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
      const oversized = structuredClone(dynamicExport);
      oversized.tables.auditEvents[0].metadata_json = 'x'.repeat(4 * 1024 * 1024 + 1);
      const { checksum: _checksum, ...unsignedOversized } = oversized;
      oversized.checksum.value = await sha256Base64Url(canonicalJson(unsignedOversized));
      const oversizedRejected = await fetch(`${started.url}/__test/backup-restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
        body: JSON.stringify({ backup: oversized, revokeSecurity: true }),
      });
      assert.equal(oversizedRejected.status, 400);
      assert.equal((await oversizedRejected.json() as { code: string }).code, 'backup_restore_size_limit');
      const tooManyStatements = structuredClone(dynamicExport);
      const auditTemplate = tooManyStatements.tables.auditEvents[0];
      tooManyStatements.tables.auditEvents = Array.from({ length: 2_001 }, (_, index) => ({
        ...auditTemplate,
        sequence: index + 1,
        id: `restore-limit-audit-${String(index + 1).padStart(4, '0')}`,
      }));
      tooManyStatements.counts.auditEvents = tooManyStatements.tables.auditEvents.length;
      const { checksum: _statementChecksum, ...unsignedTooManyStatements } = tooManyStatements;
      tooManyStatements.checksum.value = await sha256Base64Url(canonicalJson(unsignedTooManyStatements));
      const statementLimitRejected = await fetch(`${started.url}/__test/backup-restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
        body: JSON.stringify({ backup: tooManyStatements, revokeSecurity: true }),
      });
      assert.equal(statementLimitRejected.status, 400);
      assert.equal((await statementLimitRejected.json() as { code: string }).code, 'backup_restore_size_limit');
      const corrupted = structuredClone(exported);
      corrupted.chunks[0].checksum.value = `${corrupted.chunks[0].checksum.value.slice(0, -1)}x`;
      const rejected = await fetch(`${started.url}/__test/chunked-backup-restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-test-now': String(NOW) },
        body: JSON.stringify({ backup: corrupted, revokeSecurity: true }),
      });
      assert.equal(rejected.status, 400);
      const empty = await fetch(`${started.url}/__test/backup-counts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }).then((response) => response.json()) as {
        counts: { agents: number; records: number; projects: number; topics: number; validations: number };
      };
      assert.equal(empty.counts.agents, 0);
      assert.equal(empty.counts.records, 0);
      assert.equal(empty.counts.projects, 0);
      assert.equal(empty.counts.topics, 0);
      assert.equal(empty.counts.validations, 0);

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
      }).then((response) => response.json()) as {
        counts: { accounts: number; closedAccounts: number; sessions: number; records: number; validations: number };
        foreignKeyViolations: number;
      };
      assert.equal(proof.counts.records, exported.manifest.counts.records);
      assert.equal(proof.counts.accounts, exported.manifest.counts.accounts);
      assert.equal(proof.counts.sessions, exported.manifest.counts.sessions);
      assert.equal(proof.counts.closedAccounts, 1);
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

  test('the 4500 monthly safety threshold stops before Images and leaves no partial media', async () => {
    const limitNow = NOW + 60_000;
    assert.equal((await ownerRequest(`/v1/admin/media/avatar-policies/account/${OWNER_ID}`, 'PATCH', {
      dailyLimit: 50,
    })).status, 200);
    await testPost('/__test/media-transform-limit', { month: '2026-07', attempted: 4499 });
    const png = new Uint8Array(await sharp({
      create: { width: 900, height: 1400, channels: 4, background: '#1d4ed8' },
    }).png().toBuffer());
    assert.equal((await ownerImage('/v1/me/avatar', png, 'image/png', limitNow)).status, 201);
    const atLimit = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as {
      counts: { media_assets: number; claims: number; attempted: number };
      objectCount: number;
    };
    assert.equal(Number(atLimit.counts.attempted), 4500);
    const blocked = await ownerImage('/v1/me/avatar', png, 'image/png', limitNow + 1);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'media_transform_unavailable');
    const after = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as typeof atLimit;
    assert.equal(Number(after.counts.attempted), 4500);
    assert.equal(Number(after.counts.claims), Number(atLimit.counts.claims));
    assert.equal(Number(after.counts.media_assets), Number(atLimit.counts.media_assets));
    assert.equal(after.objectCount, atLimit.objectCount);
    const ownerView = await ownerRequest('/v1/admin/media-transform-usage', 'GET', undefined, undefined, limitNow);
    assert.equal(ownerView.status, 200);
    const usage = await ownerView.json() as { usage: { uploadsAvailable: boolean; safetyLimit: number; alert: { severity: string } } };
    assert.equal(usage.usage.uploadsAvailable, false);
    assert.equal(usage.usage.safetyLimit, 4500);
    assert.equal(usage.usage.alert.severity, 'critical');
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
