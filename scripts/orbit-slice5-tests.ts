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
const agentPublicationClocks = new Map<string, number>();

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
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
  let output = '';
  const child = spawn(process.execPath, [
    WRANGLER, 'dev', '--config', CONFIG, '--local', `--port=${port}`, `--inspector-port=${inspectorPort}`, `--persist-to=${persist}`,
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

async function seedAgent(
  handle: string,
  role = '',
  publicationMode = 'direct_publish',
  onboardingState = 'active',
  scopes?: string,
): Promise<Agent> {
  const token = await createOpaqueToken('agent', AGENT_PEPPER);
  const agent = { id: createEntityId(), token: token.token, handle };
  const response = await testPost('/__test/seed-publication-agent', {
    accountId: OWNER_ID, agentId: agent.id, membershipId: createEntityId(),
    credentialId: token.selector, secretDigest: token.digest,
    handle, publicationMode, status: 'active', onboardingState,
    bio: onboardingState === 'active' ? 'Test ajanı.' : '',
    avatarAsset: onboardingState === 'active' ? 'agents/nyx.webp' : '', role, now: NOW,
    ...(scopes === undefined ? {} : { scopes }),
  });
  assert.equal(response.status, 200);
  agents.set(handle, agent);
  return agent;
}

async function agentRequest(agent: Agent, pathname: string, method = 'GET', body?: Record<string, unknown>, key?: string): Promise<Response> {
  const isRootPost = method === 'POST' && pathname === '/v1/records';
  const isReply = method === 'POST' && pathname.endsWith('/replies');
  const previousPublication = agentPublicationClocks.get(agent.id) ?? NOW;
  const requestNow = isRootPost
    ? previousPublication + 61 * 60 * 1000
    : isReply ? previousPublication + 8 * 60 * 1000 : NOW;
  if (isRootPost || isReply) agentPublicationClocks.set(agent.id, requestNow);
  const headers: Record<string, string> = {
    authorization: `Bearer ${agent.token}`,
    'x-test-now': String(requestNow),
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

async function agentAvatarRequest(
  agent: Agent,
  bytes: Uint8Array,
  type = 'image/png',
  key = randomBase64Url(18),
  now = NOW,
): Promise<Response> {
  return await fetch(`${baseUrl}/v1/agent/avatar`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agent.token}`,
      'idempotency-key': key,
      'x-test-now': String(now),
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'x-orbit-content-sha256': await imageDigest(bytes),
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
  await seedAgent('slice5-onboarding', '', 'approval_required', 'pending');
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
      { fetch: async () => new Response('<!doctype html><title>Orbit Sponsor Paneli</title><a href="/" aria-label="Equinox Orbit ana sayfa">Orbit</a><form action="/search"><input aria-label="Orbit\'te ara"></form><button>GitHub hesabımla devam et</button><span>Görsel yetkisi</span>') },
    );
    const html = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
    assert.match(html, /Orbit Sponsor Paneli/u);
    assert.match(html, /Equinox Orbit ana sayfa/u);
    assert.match(html, /Orbit'te ara/u);
    assert.match(html, /GitHub hesabımla devam et/u);
    assert.doesNotMatch(html, /Profil fotoğrafını değiştir/u);
    assert.match(html, /Görsel yetkisi/u);
    assert.doesNotMatch(html, /orb_agent_v1_/u);
  });

  test('pending agent activates after its own bio update and avatar remains optional', async () => {
    const agent = agents.get('slice5-onboarding')!;
    assert.equal((await fetch(`${baseUrl}/v1/agents/${agent.handle}`)).status, 404);
    const profile = await agentRequest(agent, '/v1/agent/profile');
    assert.equal(profile.status, 200);
    const etag = profile.headers.get('etag');
    assert.ok(etag);
    const patched = await fetch(`${baseUrl}/v1/agent/profile`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'if-match': etag,
        'x-test-now': String(NOW),
      },
      body: JSON.stringify({ bio: 'Kimliğimi kendi API erişimimle tamamlıyorum.' }),
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    assert.equal((await patched.json() as { agent: { onboardingState: string } }).agent.onboardingState, 'active');

    const png = new Uint8Array(await sharp({
      create: { width: 900, height: 900, channels: 4, background: '#735de3' },
    }).png().toBuffer());
    const avatar = await agentAvatarRequest(agent, png, 'image/png', 'onboarding-avatar');
    assert.equal(avatar.status, 201, await avatar.clone().text());
    const completed = await agentRequest(agent, '/v1/agent/profile');
    assert.equal(completed.status, 200);
    const completedBody = await completed.json() as { agent: { onboardingState: string; avatarAsset: string } };
    assert.equal(completedBody.agent.onboardingState, 'active');
    assert.match(completedBody.agent.avatarAsset, /^\/v1\/media\//u);
    assert.equal((await fetch(`${baseUrl}/v1/agents/${agent.handle}`)).status, 200);
  });

  test('avatar and post media enforce transforms, policy, privacy and quota', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 1600, height: 900, channels: 4, background: '#745cff' },
    }).png().toBuffer());
    assert.equal((await ownerImage('/v1/me/avatar', png)).status, 404);

    const direct = agents.get('slice5-equinox')!;
    assert.equal((await ownerImage(`/v1/agents/${direct.id}/avatar`, png)).status, 404);
    const agentAvatar = await agentAvatarRequest(direct, png);
    assert.equal(agentAvatar.status, 201, await agentAvatar.clone().text());
    const agentAvatarBody = await agentAvatar.json() as { media: { id: string; width: number; height: number } };
    assert.deepEqual([agentAvatarBody.media.width, agentAvatarBody.media.height], [512, 512]);
    const agentAvatarId = agentAvatarBody.media.id;
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
    assert.equal((await fetch(`${baseUrl}/v1/media/${mediaId}`, {
      headers: {
        cookie: ownerCookie,
        'x-test-now': String(NOW),
      },
    })).status, 200);
    const reviews = (await (await ownerRequest('/v1/approvals')).json() as {
      reviews: Array<{ id: string; record: { id: string }; media: { id: string } | null }>;
    }).reviews;
    const review = reviews.find((item) => item.record.id === record.id);
    assert.equal(review?.media?.id, mediaId);
    assert.equal((await ownerRequest(`/v1/approvals/${review?.id}/reject`, 'POST', { note: 'media cleanup proof' }, 'slice5-media-reject')).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/media/${mediaId}`, {
      headers: {
        cookie: ownerCookie,
        'x-test-now': String(NOW),
      },
    })).status, 404);
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
    const agent = agents.get('slice5-media-concurrent')!;
    assert.equal((await ownerRequest(`/v1/admin/media/avatar-policies/agent/${agent.id}`, 'PATCH', {
      dailyLimit: 1,
    })).status, 200);
    const agentAvatarResponses = await Promise.all([
      agentAvatarRequest(agent, png, 'image/png', 'parallel-agent-avatar-key'),
      agentAvatarRequest(agent, png, 'image/png', 'parallel-agent-avatar-key'),
    ]);
    assert.deepEqual(agentAvatarResponses.map((response) => response.status), [201, 201]);
    assert.equal(agentAvatarResponses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
    const avatarQuota = await agentAvatarRequest(agent, png, 'image/png', 'parallel-agent-avatar-new-key');
    assert.equal(avatarQuota.status, 429);
    const dailyResetAt = Date.parse('2026-07-17T00:00:00Z');
    assert.equal(avatarQuota.headers.get('retry-after'), String((dailyResetAt - NOW) / 1000));
    const avatarQuotaError = (await avatarQuota.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(avatarQuotaError.code, 'daily_avatar_quota_exceeded');
    assert.deepEqual(avatarQuotaError.details.quota, {
      key: 'avatar.daily',
      limit: 1,
      remaining: 0,
      windowSeconds: 86400,
      resetAt: dailyResetAt,
    });

    assert.equal((await ownerRequest(`/v1/admin/agents/${agent.id}/media-policy`, 'PATCH', {
      mediaEnabled: true, dailyImageLimit: 10,
    })).status, 200);
    const postResponses = await Promise.all([
      agentImageRequest(agent, png, 'image/png', 'Paralel Orbit medya görseli', 'parallel-post-media-key'),
      agentImageRequest(agent, png, 'image/png', 'Paralel Orbit medya görseli', 'parallel-post-media-key'),
    ]);
    assert.deepEqual(postResponses.map((response) => response.status), [201, 201]);
    assert.equal(postResponses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
    const expiryHeaders = postResponses.map((response) => response.headers.get('idempotency-key-expires-at'));
    assert.ok(expiryHeaders[0]);
    assert.equal(expiryHeaders[0], expiryHeaders[1]);
    const postBodies = await Promise.all(postResponses.map((response) => response.json()));
    assert.deepEqual(postBodies[0], postBodies[1]);

    const after = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as typeof before;
    assert.equal(Number(after.counts.claims), Number(before.counts.claims) + 2);
    assert.equal(Number(after.counts.attempted), Number(before.counts.attempted) + 2);
    assert.equal(Number(after.counts.media_assets), Number(before.counts.media_assets) + 2);
    const conflict = await agentImageRequest(agent, png, 'image/png', 'Farklı alt metin', 'parallel-post-media-key');
    assert.equal(conflict.status, 409);
    const conflictError = (await conflict.json() as { error: { code: string; details: Record<string, any> } }).error;
    assert.equal(conflictError.code, 'idempotency_conflict');
    assert.deepEqual(conflictError.details.recovery, {
      retryable: false,
      action: 'use_new_idempotency_key',
      retryAt: null,
    });
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
    const rejected = await agentAvatarRequest(agents.get('slice5-external')!, corrupt);
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
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        origin: 'https://evil.example',
        'x-orbit-csrf': ownerCsrf,
        'x-test-now': String(NOW),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
  });

  const directMessageText = 'Bu yalnız iki ajan arasında kalması gereken özel Orbit mesajıdır.';
  let directMessageId = '';
  test('direct messages are private, idempotent and ownership-bounded', async () => {
    const sender = agents.get('slice5-equinox')!;
    const recipient = agents.get('slice5-external')!;
    const observer = agents.get('slice5-pending')!;

    assert.equal((await fetch(`${baseUrl}/v1/direct-messages`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/direct-messages/unread-count`)).status, 401);
    assert.equal((await agentRequest(sender, '/v1/direct-messages', 'POST', {
      recipientHandle: sender.handle,
      bodyMarkdown: 'Kendime not.',
    }, 'slice5-dm-self')).status, 400);
    assert.equal((await agentRequest(sender, '/v1/direct-messages', 'POST', {
      recipientHandle: 'missing-agent',
      bodyMarkdown: 'Olmayan alıcı.',
    }, 'slice5-dm-missing')).status, 404);

    const requestBody = {
      recipientHandle: recipient.handle,
      bodyMarkdown: directMessageText,
    };
    assert.equal((await agentRequest(sender, '/v1/direct-messages', 'POST', requestBody)).status, 400);
    const sent = await agentRequest(sender, '/v1/direct-messages', 'POST', requestBody, 'slice5-dm-send');
    assert.equal(sent.status, 201, await sent.clone().text());
    const sentBody = await sent.json() as {
      directMessage: {
        id: string;
        sender: { handle: string };
        recipient: { handle: string };
        bodyMarkdown: string;
        readAt: number | null;
      };
    };
    directMessageId = sentBody.directMessage.id;
    assert.equal(sentBody.directMessage.sender.handle, sender.handle);
    assert.equal(sentBody.directMessage.recipient.handle, recipient.handle);
    assert.equal(sentBody.directMessage.bodyMarkdown, directMessageText);
    assert.equal(sentBody.directMessage.readAt, null);

    const replay = await agentRequest(sender, '/v1/direct-messages', 'POST', requestBody, 'slice5-dm-send');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.ok(sent.headers.get('idempotency-key-expires-at'));
    assert.equal(replay.headers.get('idempotency-key-expires-at'), sent.headers.get('idempotency-key-expires-at'));
    assert.deepEqual(await replay.json(), sentBody);
    const conflict = await agentRequest(sender, '/v1/direct-messages', 'POST', {
      ...requestBody,
      bodyMarkdown: 'Aynı anahtar, farklı gövde.',
    }, 'slice5-dm-send');
    assert.equal(conflict.status, 409);

    const auxiliaryMessageIds: string[] = [];
    for (const [index, auxiliarySender] of [
      observer,
      agents.get('slice5-media-concurrent')!,
    ].entries()) {
      const auxiliary = await agentRequest(auxiliarySender, '/v1/direct-messages', 'POST', {
        recipientHandle: sender.handle,
        bodyMarkdown: `Cursor sayfası için özel mesaj ${index + 1}.`,
      }, `slice5-dm-page-${index + 1}`);
      assert.equal(auxiliary.status, 201);
      auxiliaryMessageIds.push((await auxiliary.json() as {
        directMessage: { id: string };
      }).directMessage.id);
    }
    const firstInboxPage = await agentRequest(sender, '/v1/direct-messages?box=inbox&limit=1');
    const firstInboxBody = await firstInboxPage.json() as {
      directMessages: Array<{ id: string }>;
      nextCursor: string;
    };
    assert.equal(firstInboxBody.directMessages.length, 1);
    assert.match(firstInboxBody.nextCursor, /^okc1\./u);
    const secondInboxPage = await agentRequest(
      sender,
      `/v1/direct-messages?box=inbox&limit=1&cursor=${encodeURIComponent(firstInboxBody.nextCursor)}`,
    );
    const secondInboxBody = await secondInboxPage.json() as {
      directMessages: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(secondInboxBody.directMessages.length, 1);
    assert.notEqual(secondInboxBody.directMessages[0]?.id, firstInboxBody.directMessages[0]?.id);
    assert.equal(secondInboxBody.nextCursor, null);
    assert.equal((await agentRequest(
      sender,
      `/v1/direct-messages?box=sent&cursor=${encodeURIComponent(firstInboxBody.nextCursor)}`,
    )).status, 400);
    assert.equal((await agentRequest(
      recipient,
      `/v1/direct-messages?box=inbox&cursor=${encodeURIComponent(firstInboxBody.nextCursor)}`,
    )).status, 400);
    for (const id of auxiliaryMessageIds) {
      assert.equal((await agentRequest(sender, `/v1/direct-messages/${id}/read`, 'POST', {})).status, 200);
    }

    const senderUnread = await agentRequest(sender, '/v1/direct-messages/unread-count');
    const recipientUnread = await agentRequest(recipient, '/v1/direct-messages/unread-count');
    const observerUnread = await agentRequest(observer, '/v1/direct-messages/unread-count');
    assert.deepEqual(await senderUnread.json(), { unreadCount: 0 });
    assert.deepEqual(await recipientUnread.json(), { unreadCount: 1 });
    assert.deepEqual(await observerUnread.json(), { unreadCount: 0 });
    assert.match(recipientUnread.headers.get('cache-control') ?? '', /^no-store/u);

    const senderInbox = await agentRequest(sender, '/v1/direct-messages?box=inbox');
    const senderSent = await agentRequest(sender, '/v1/direct-messages?box=sent');
    const recipientInbox = await agentRequest(recipient, '/v1/direct-messages?box=inbox');
    const observerInbox = await agentRequest(observer, '/v1/direct-messages?box=inbox');
    const senderInboxRows = (await senderInbox.json() as { directMessages: Array<{ id: string }> }).directMessages;
    const senderSentRows = (await senderSent.json() as { directMessages: Array<{ id: string }> }).directMessages;
    const recipientInboxRows = (await recipientInbox.json() as { directMessages: Array<{ id: string }> }).directMessages;
    const observerInboxRows = (await observerInbox.json() as { directMessages: Array<{ id: string }> }).directMessages;
    assert.ok(!senderInboxRows.some((item) => item.id === directMessageId));
    assert.ok(senderSentRows.some((item) => item.id === directMessageId));
    assert.ok(recipientInboxRows.some((item) => item.id === directMessageId));
    assert.ok(!observerInboxRows.some((item) => item.id === directMessageId));
    assert.match(recipientInbox.headers.get('cache-control') ?? '', /^no-store/u);

    assert.equal((await agentRequest(sender, `/v1/direct-messages/${directMessageId}/read`, 'POST', {})).status, 404);
    assert.equal((await agentRequest(observer, `/v1/direct-messages/${directMessageId}/read`, 'POST', {})).status, 404);
    assert.equal((await agentRequest(recipient, `/v1/direct-messages/${directMessageId}/read`, 'POST', {})).status, 200);
    assert.equal((await agentRequest(recipient, `/v1/direct-messages/${directMessageId}/read`, 'POST', {})).status, 200);
    assert.deepEqual(
      await (await agentRequest(recipient, '/v1/direct-messages/unread-count')).json(),
      { unreadCount: 0 },
    );
    const sentAfterRead = await agentRequest(sender, '/v1/direct-messages?box=sent');
    const readMessage = (await sentAfterRead.json() as {
      directMessages: Array<{ id: string; readAt: number | null }>;
    }).directMessages.find((item) => item.id === directMessageId);
    assert.equal(readMessage?.readAt, NOW);

    const publicFeed = await fetch(`${baseUrl}/v1/feed`).then((response) => response.text());
    assert.doesNotMatch(publicFeed, new RegExp(directMessageText, 'u'));
    const rateLimited = await agentRequest(sender, '/v1/direct-messages', 'POST', {
      recipientHandle: recipient.handle,
      bodyMarkdown: 'İkinci mesaj burst sınırına takılmalı.',
    }, 'slice5-dm-burst');
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get('retry-after'), '5');
    const rateLimitedError = (await rateLimited.json() as {
      error: { code: string; details: Record<string, any> };
    }).error;
    assert.equal(rateLimitedError.code, 'direct_message_burst_limited');
    assert.deepEqual(rateLimitedError.details.recovery, {
      retryable: true,
      action: 'retry_same_request',
      retryAt: NOW + 5_000,
    });
    assert.deepEqual(rateLimitedError.details.quota, {
      key: 'direct_message.send.minimum_interval',
      limit: 1,
      remaining: 0,
      windowSeconds: 5,
      resetAt: NOW + 5_000,
    });
  });

  /* Kotalar tetikleyicide değil yazma yolunda. Burst'ü yukarıdaki test zaten
   * görüyordu — ama o test kota tetikleyicideyken de geçiyordu, yani taşımayı
   * kanıtlamıyor. Saatlik ve günlük sınırlar ise hiç sınanmamıştı; artık
   * benim yazdığım kodda yaşıyorlar. */
  test('direct message quotas are enforced on the write path and write nothing when they reject', async () => {
    // Kendi ajanları: bu test yüzden fazla mesaj yazıyor ve paylaşılan bir
    // gönderenin kutusunu kullansa sonraki testlerin aradığı mesajı ilk
    // sayfadan iterdi.
    const sender = await seedAgent('slice5-dm-quota-sender');
    const recipient = await seedAgent('slice5-dm-quota-recipient');
    // Kendi penceresi: başka testlerin mesajları ne saatlik ne günlük sayıma
    // karışsın.
    const base = NOW + 48 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;

    const send = async (at: number, key: string) => await fetch(`${baseUrl}/v1/direct-messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'content-type': 'application/json',
        'x-test-now': String(at),
        'idempotency-key': key,
      },
      body: JSON.stringify({
        recipientHandle: recipient.handle,
        bodyMarkdown: `Kota penceresi mesajı ${key}.`,
      }),
    });
    const sentCount = async () => {
      const response = await fetch(`${baseUrl}/v1/direct-messages?box=sent&limit=50`, {
        headers: { authorization: `Bearer ${sender.token}`, 'x-test-now': String(base) },
      });
      return (await response.json() as { directMessages: unknown[] }).directMessages.length;
    };

    // Beş saniyelik ara: reddedilen istek hiçbir şey yazmıyor ve kendi
    // idempotency anahtarını da tüketmiyor.
    assert.equal((await send(base, 'dm-window-1')).status, 201);
    const before = await sentCount();
    const tooSoon = await send(base + 4_999, 'dm-window-2');
    assert.equal(tooSoon.status, 429);
    assert.equal((await tooSoon.json() as { error: { code: string } }).error.code, 'direct_message_burst_limited');
    assert.equal(await sentCount(), before);
    assert.equal((await send(base + 5_000, 'dm-window-2')).status, 201);

    // Saatlik sınır. İki mesaj gitti, on sekiz tane daha yirmiye tamamlıyor.
    for (let index = 0; index < 18; index += 1) {
      const at = base + 10_000 + index * 6_000;
      assert.equal((await send(at, `dm-hour-${index}`)).status, 201, `saatlik dolum ${index}`);
    }
    const hourly = await send(base + 10_000 + 18 * 6_000, 'dm-hour-over');
    assert.equal(hourly.status, 429);
    const hourlyError = (await hourly.json() as { error: { code: string; details: { quota: unknown } } }).error;
    assert.equal(hourlyError.code, 'direct_message_hourly_limit_exceeded');
    assert.deepEqual(hourlyError.details.quota, {
      key: 'direct_message.send.rolling_hour',
      limit: 20,
      remaining: 0,
      windowSeconds: 3_600,
      resetAt: base + hour,
    });

    // Günlük sınır. İki saat aralıklı bloklar: her blok başında bir önceki
    // blok saatlik pencerenin dışında kalıyor, yani yalnız günlük sayım
    // birikiyor. Dört blok daha yüze tamamlıyor.
    for (let block = 1; block <= 4; block += 1) {
      for (let index = 0; index < 20; index += 1) {
        const at = base + block * 2 * hour + index * 6_000;
        assert.equal((await send(at, `dm-day-${block}-${index}`)).status, 201, `günlük dolum ${block}/${index}`);
      }
    }
    const daily = await send(base + 10 * hour, 'dm-day-over');
    assert.equal(daily.status, 429);
    const dailyError = (await daily.json() as { error: { code: string; details: { quota: unknown } } }).error;
    assert.equal(dailyError.code, 'direct_message_daily_limit_exceeded');
    assert.deepEqual(dailyError.details.quota, {
      key: 'direct_message.send.rolling_day',
      limit: 100,
      remaining: 0,
      windowSeconds: 86_400,
      resetAt: base + 24 * hour,
    });
  });

  test('sponsor witnesses only their own agent and reading changes nothing', async () => {
    const sender = agents.get('slice5-equinox')!;
    const recipient = agents.get('slice5-external')!;

    assert.equal((await fetch(`${baseUrl}/v1/agents/${sender.id}/direct-messages`)).status, 401);

    // Sponsor yazışmanın iki yakasını da görür: ekranın gerekçesi, karşı ajanın
    // kendi ajanına ne yazdığını insanın görebilmesi.
    const sponsorSent = await ownerRequest(`/v1/agents/${sender.id}/direct-messages?box=sent`);
    assert.equal(sponsorSent.status, 200, await sponsorSent.clone().text());
    const sponsorSentRows = (await sponsorSent.json() as {
      directMessages: Array<{ id: string; bodyMarkdown: string; sender: { handle: string } }>;
    }).directMessages;
    assert.ok(sponsorSentRows.some((item) => item.id === directMessageId));
    assert.ok(sponsorSentRows.some((item) => item.bodyMarkdown === directMessageText));

    const sponsorInbox = await ownerRequest(`/v1/agents/${recipient.id}/direct-messages?box=inbox`);
    assert.equal(sponsorInbox.status, 200);
    assert.ok((await sponsorInbox.json() as {
      directMessages: Array<{ id: string }>;
    }).directMessages.some((item) => item.id === directMessageId));

    assert.match(sponsorSent.headers.get('cache-control') ?? '', /^no-store/u);
    assert.equal((await ownerRequest(`/v1/agents/${sender.id}/direct-messages?box=archive`)).status, 400);
    assert.equal((await ownerRequest('/v1/agents/missing-agent/direct-messages')).status, 404);

    // Ekran salt okunur: insanın bakması ajanın kendi okunmadı durumunu
    // değiştirmemeli, ve buradan gönderme ya da okundu işaretleme yolu yok.
    const unreadBefore = await (await agentRequest(recipient, '/v1/direct-messages/unread-count')).json();
    await ownerRequest(`/v1/agents/${recipient.id}/direct-messages?box=inbox`);
    assert.deepEqual(
      await (await agentRequest(recipient, '/v1/direct-messages/unread-count')).json(),
      unreadBefore,
    );
    assert.equal((await ownerRequest(`/v1/agents/${sender.id}/direct-messages`, 'POST', {
      recipientHandle: recipient.handle,
      bodyMarkdown: 'İnsan Orbit\'te yazamaz.',
    }, 'slice5-dm-human-send')).status, 404);

    /*
     * Platform sahibi de atlayamaz.
     *
     * accountCanManageAgent platform sahibine her ajanı yönetme hakkı veriyor
     * ve bu uç bilerek o ölçütü kullanmıyor: okuma hakkı yönetime bağlansaydı
     * tek bir hesap platformdaki bütün özel yazışmaları okuyabilirdi. Aynı
     * hesabın yönetim ucunda hâlâ yetkili olduğunu da doğruluyoruz, yoksa test
     * ayrımı değil yalnızca bozuk bir oturumu ölçmüş olurdu.
     */
    const outsiderSession = await createOpaqueToken('session', SESSION_PEPPER);
    const outsiderCsrf = randomBase64Url(32);
    assert.equal((await testPost('/__test/seed-role-session', {
      accountId: createEntityId(),
      roleId: createEntityId(),
      handle: 'slice5-baska-sahip',
      role: 'platform_owner',
      sessionId: outsiderSession.selector,
      secretDigest: outsiderSession.digest,
      csrfDigest: await hmacDigest(
        `orbit:csrf:v1:${outsiderSession.selector}:${outsiderCsrf}`,
        CSRF_PEPPER,
      ),
    })).status, 200);
    const outsiderCookie = `__Host-orbit_session=${outsiderSession.token}; __Host-orbit_csrf=${outsiderCsrf}`;
    const outsider = async (pathname: string): Promise<Response> => await fetch(`${baseUrl}${pathname}`, {
      headers: { cookie: outsiderCookie, 'x-test-now': String(NOW) },
    });

    assert.equal((await outsider(`/v1/agents/${sender.id}/manage`)).status, 200);
    assert.equal((await outsider(`/v1/agents/${sender.id}/direct-messages`)).status, 404);
    assert.equal((await outsider(`/v1/agents/${recipient.id}/direct-messages?box=inbox`)).status, 404);
    // Aynı kapı takip akışını da koruyor; ayrı bir uç ayrı bir ölçüt kullanmasın.
    assert.equal((await outsider(`/v1/agents/${sender.id}/following-feed`)).status, 404);
  });

  let allAnnouncementId = '';
  let targetedAnnouncementId = '';
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
    targetedAnnouncementId = (await targeted.json() as { announcement: { id: string } }).announcement.id;
    assert.equal((await ownerRequest(`/v1/admin/announcements/${targetedAnnouncementId}/publish`, 'POST', {})).status, 200);

    const firstAnnouncementPage = await agentRequest(
      externalAgent,
      '/v1/announcements?limit=1',
    );
    const firstAnnouncementBody = await firstAnnouncementPage.json() as {
      announcements: Array<{ id: string }>;
      nextCursor: string;
    };
    assert.deepEqual(firstAnnouncementBody.announcements.map((item) => item.id), [targetedAnnouncementId]);
    assert.match(firstAnnouncementBody.nextCursor, /^okc1\./u);
    const secondAnnouncementPage = await agentRequest(
      externalAgent,
      `/v1/announcements?limit=1&cursor=${encodeURIComponent(firstAnnouncementBody.nextCursor)}`,
    );
    const secondAnnouncementBody = await secondAnnouncementPage.json() as {
      announcements: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.deepEqual(secondAnnouncementBody.announcements.map((item) => item.id), [allAnnouncementId]);
    assert.equal(secondAnnouncementBody.nextCursor, null);
    assert.equal((await agentRequest(
      agents.get('slice5-equinox')!,
      `/v1/announcements?cursor=${encodeURIComponent(firstAnnouncementBody.nextCursor)}`,
    )).status, 400);

    const equinoxRows = (await (await agentRequest(agents.get('slice5-equinox')!, '/v1/announcements')).json() as { announcements: Array<{ id: string }> }).announcements;
    const externalRows = (await (await agentRequest(externalAgent, '/v1/announcements')).json() as { announcements: Array<{ id: string }> }).announcements;
    assert.deepEqual(new Set(equinoxRows.map((item) => item.id)), new Set([allAnnouncementId, equinoxOnlyId]));
    assert.deepEqual(new Set(externalRows.map((item) => item.id)), new Set([allAnnouncementId, targetedAnnouncementId]));

    const equinoxUnread = await agentRequest(agents.get('slice5-equinox')!, '/v1/announcements/unread-count');
    assert.equal(equinoxUnread.status, 200);
    assert.deepEqual(await equinoxUnread.json(), {
      unreadCount: 2,
      criticalCount: 0,
      warningCount: 1,
      infoCount: 1,
      highestSeverity: 'warning',
    });
    const externalUnread = await agentRequest(externalAgent, '/v1/announcements/unread-count');
    assert.equal(externalUnread.status, 200);
    assert.deepEqual(await externalUnread.json(), {
      unreadCount: 2,
      criticalCount: 1,
      warningCount: 1,
      infoCount: 0,
      highestSeverity: 'critical',
    });

    const blocked = await agentRequest(externalAgent, '/v1/records', 'POST', {
      bodyMarkdown: 'Kritik duyuru okunmadan yayımlanmaması gereken kayıt.',
      projectSlug: null,
      topicSlugs: [],
    }, 'slice5-critical-announcement-block');
    assert.equal(blocked.status, 428);
    const blockedBody = await blocked.json() as {
      error: { code: string; details: { endpoint: string; announcementIds: string[] } };
    };
    assert.equal(blockedBody.error.code, 'critical_announcement_unread');
    assert.equal(blockedBody.error.details.endpoint, '/v1/announcements');
    assert.deepEqual(blockedBody.error.details.announcementIds, [targetedAnnouncementId]);
    const blockedDm = await agentRequest(externalAgent, '/v1/direct-messages', 'POST', {
      recipientHandle: agents.get('slice5-equinox')!.handle,
      bodyMarkdown: 'Kritik duyuru okunmadan gönderilmemesi gereken DM.',
    }, 'slice5-critical-announcement-dm-block');
    assert.equal(blockedDm.status, 428);
    assert.equal(
      (await blockedDm.json() as { error: { code: string } }).error.code,
      'critical_announcement_unread',
    );

    const publicFeed = await fetch(`${baseUrl}/v1/feed`).then((response) => response.text());
    assert.doesNotMatch(publicFeed, /Bakım penceresi|Equinox iç notu|Tek ajan notu/u);
    assert.equal((await fetch(`${baseUrl}/v1/announcements`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/announcements/unread-count`)).status, 401);
  });

  test('agent read receipt is private and idempotent', async () => {
    const agent = agents.get('slice5-external')!;
    assert.equal((await agentRequest(agent, `/v1/announcements/${allAnnouncementId}/read`, 'POST', {})).status, 200);
    assert.equal((await agentRequest(agent, `/v1/announcements/${allAnnouncementId}/read`, 'POST', {})).status, 200);
    assert.equal((await agentRequest(agent, `/v1/announcements/${targetedAnnouncementId}/read`, 'POST', {})).status, 200);
    const rows = (await (await agentRequest(agent, '/v1/announcements')).json() as { announcements: Array<{ id: string; readAt: number | null }> }).announcements;
    assert.equal(rows.find((item) => item.id === allAnnouncementId)?.readAt, NOW);
    assert.equal(rows.find((item) => item.id === targetedAnnouncementId)?.readAt, NOW);
    assert.deepEqual(
      await (await agentRequest(agent, '/v1/announcements/unread-count')).json(),
      {
        unreadCount: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        highestSeverity: null,
      },
    );
    const unblocked = await agentRequest(agent, '/v1/records', 'POST', {
      bodyMarkdown: 'Kritik duyuru okunduktan sonra yayımlanabilen kayıt.',
      projectSlug: null,
      topicSlugs: [],
    }, 'slice5-critical-announcement-unblocked');
    assert.ok(unblocked.status === 201 || unblocked.status === 202);
    const unblockedDm = await agentRequest(agent, '/v1/direct-messages', 'POST', {
      recipientHandle: agents.get('slice5-equinox')!.handle,
      bodyMarkdown: 'Kritik duyuru okunduktan sonra gönderilebilen DM.',
    }, 'slice5-critical-announcement-dm-unblocked');
    assert.equal(unblockedDm.status, 201);
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
    assert.ok(dynamicExport.tables.directMessages.some(
      (row) => row.body_markdown === directMessageText,
    ));
    const directMessageAudit = dynamicExport.tables.auditEvents.find(
      (row) => row.event_type === 'direct_message.sent' && row.subject_id === directMessageId,
    );
    assert.ok(directMessageAudit);
    assert.ok(!String(directMessageAudit.metadata_json).includes(directMessageText));
    const exported = await testPost('/__test/chunked-backup-export', { includeSessions: true })
      .then((response) => response.json()) as {
        manifest: { schema: string; checksum: { value: string }; counts: Record<string, number> };
        chunks: Array<{ rowCount: number; byteLength: number; checksum: { value: string }; rows: unknown[] }>;
      };
    assert.equal(exported.manifest.schema, 'equinox.orbit.chunked-backup.v1');
    assert.ok(exported.chunks.every((chunk) => chunk.rowCount <= 500 && chunk.byteLength <= 1024 * 1024));
    assert.ok(exported.manifest.counts.announcements >= 2);
    assert.ok(exported.manifest.counts.directMessages >= 1);
    assert.ok(exported.manifest.counts.directMessageReads >= 1);
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
      reconciled: Array<{
        id: string;
        status: string;
        error_code: string | null;
        completed_at: number | null;
      }>;
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
    assert.deepEqual(proof.reconciled, [
      {
        id: 'slice5-fresh-backup',
        status: 'running',
        error_code: null,
        completed_at: null,
      },
      {
        id: 'slice5-stale-backup',
        status: 'failed',
        error_code: 'backup_run_stale_timeout',
        completed_at: NOW,
      },
    ]);
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
    const limitAgent = agents.get('slice5-external')!;
    assert.equal((await ownerRequest(`/v1/admin/media/avatar-policies/agent/${limitAgent.id}`, 'PATCH', {
      dailyLimit: 50,
    })).status, 200);
    await testPost('/__test/media-transform-limit', { month: '2026-07', attempted: 4499 });
    const png = new Uint8Array(await sharp({
      create: { width: 900, height: 1400, channels: 4, background: '#1d4ed8' },
    }).png().toBuffer());
    assert.equal((await agentAvatarRequest(limitAgent, png, 'image/png', randomBase64Url(18), limitNow)).status, 201);
    const atLimit = await testPost('/__test/media-transform-state', { month: '2026-07' }).then((response) => response.json()) as {
      counts: { media_assets: number; claims: number; attempted: number };
      objectCount: number;
    };
    assert.equal(Number(atLimit.counts.attempted), 4500);
    const blocked = await agentAvatarRequest(limitAgent, png, 'image/png', randomBase64Url(18), limitNow + 1);
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

  test('following is a filter, never an ordering', async () => {
    const follower = agents.get('slice5-equinox')!;
    const followed = agents.get('slice5-external')!;

    // Yazma ajanın işi: insan oturumu ve kimliksiz istek buradan geçemez.
    assert.equal((await fetch(`${baseUrl}/v1/agent/follows/${followed.handle}`, { method: 'PUT' })).status, 401);
    assert.equal((await ownerRequest(`/v1/agent/follows/${followed.handle}`, 'PUT', {}, 'slice5-follow-human')).status, 401);

    // Kapsam gerçekten kapı: social:write taşımayan bir kimlik takip edemez.
    const legacy = await seedAgent(
      'slice5-eski-kapsam', '', 'direct_publish', 'active',
      'feed:read records:write media:write profile:write',
    );
    assert.equal((await agentRequest(legacy, `/v1/agent/follows/${followed.handle}`, 'PUT')).status, 403);

    assert.equal((await agentRequest(follower, `/v1/agent/follows/${follower.handle}`, 'PUT')).status, 409);
    assert.equal((await agentRequest(follower, '/v1/agent/follows/olmayan-ajan', 'PUT')).status, 404);

    const followed1 = await agentRequest(follower, `/v1/agent/follows/${followed.handle}`, 'PUT');
    assert.equal(followed1.status, 200, await followed1.clone().text());
    assert.deepEqual(await followed1.json(), { follow: { handle: followed.handle, following: true } });
    // Tekrar eden PUT yeni bir takip değil, aynı durumun tekrar söylenmesi.
    assert.equal((await agentRequest(follower, `/v1/agent/follows/${followed.handle}`, 'PUT')).status, 200);

    const own = await agentRequest(follower, '/v1/agent/follows?box=following');
    assert.equal(own.status, 200);
    const ownRows = (await own.json() as { follows: Array<{ agent: { handle: string } }> }).follows;
    assert.deepEqual(ownRows.map((row) => row.agent.handle), [followed.handle]);
    assert.equal((await agentRequest(follower, '/v1/agent/follows?box=arsiv')).status, 400);

    // Grafik public: takipçi listesi karşı taraftan da okunur, kimlik gerekmez.
    const publicFollowers = await fetch(`${baseUrl}/v1/agents/${followed.handle}/follows?box=followers`);
    assert.equal(publicFollowers.status, 200);
    assert.deepEqual(
      (await publicFollowers.json() as { follows: Array<{ agent: { handle: string } }> })
        .follows.map((row) => row.agent.handle),
      [follower.handle],
    );
    assert.equal((await fetch(`${baseUrl}/v1/agents/olmayan-ajan/follows`)).status, 404);

    /*
     * Grafik public, akış değil.
     *
     * Kimin kimi takip ettiği açık bilgi; ama o takiplerden derlenen akış
     * ajanın neyi okuduğunu gösteriyor ve bu ajanın kendi alanı. Public akışta
     * takip diye bir süzgeç yok, ve olmadığı test ediliyor: parametre sessizce
     * yok sayılırsa akış daralmaz.
     */
    const everything = await fetch(`${baseUrl}/v1/feed?limit=50`);
    assert.equal(everything.status, 200);
    const allRecords = (await everything.json() as {
      records: Array<{ id: string; author: { handle: string } }>;
    }).records;
    const publicAttempt = await fetch(`${baseUrl}/v1/feed?following=${follower.handle}&limit=50`);
    assert.equal(publicAttempt.status, 200);
    assert.deepEqual(
      (await publicAttempt.json() as { records: Array<{ id: string }> }).records.map((record) => record.id),
      allRecords.map((record) => record.id),
    );
    assert.equal((await fetch(`${baseUrl}/v1/agents/${follower.id}/following-feed`)).status, 401);

    /*
     * Asıl iddia: takip akışı daraltır ama sıralamaya karışmaz.
     *
     * Süzgeçli akışı, süzgeçsiz akışın aynı yazara daraltılmış haliyle
     * karşılaştırıyoruz. Takip bir sıralama sinyali olsaydı iki liste
     * ayrışırdı; burada birebir aynı olmaları gerekiyor.
     */
    const followingFeed = await agentRequest(follower, '/v1/agent/feed/following?limit=50');
    assert.equal(followingFeed.status, 200, await followingFeed.clone().text());
    const followingRecords = (await followingFeed.json() as {
      records: Array<{ id: string; author: { handle: string } }>;
    }).records;

    assert.ok(followingRecords.length > 0, 'takip edilen ajanın kaydı akışa girmedi');
    assert.deepEqual(
      followingRecords.map((record) => record.id),
      allRecords.filter((record) => record.author.handle === followed.handle).map((record) => record.id),
    );
    assert.ok(followingRecords.every((record) => record.author.handle === followed.handle));

    // Sponsor aynı akışı görür; başka bir ajanın akışını göremez.
    const sponsorFeed = await ownerRequest(`/v1/agents/${follower.id}/following-feed?limit=50`);
    assert.equal(sponsorFeed.status, 200);
    assert.deepEqual(
      (await sponsorFeed.json() as { records: Array<{ id: string }> }).records.map((record) => record.id),
      followingRecords.map((record) => record.id),
    );
    assert.equal((await ownerRequest('/v1/agents/missing-agent/following-feed')).status, 404);

    // Takip edilmeyen bir ajanın akışı boş; boş takip listesi "her şey" demek değil.
    const empty = await agentRequest(followed, '/v1/agent/feed/following?limit=50');
    assert.deepEqual((await empty.json() as { records: unknown[] }).records, []);

    /*
     * Bırakmak ilişkiyi siler ve akış anında daralır.
     *
     * Buradaki asıl tuzak veritabanı değil önbellek: akış public okuma
     * yüzeyinden geçiyor ve takip mutasyonu önbelleği düşürmezse, bırakılan
     * ajan akışta durmaya devam ediyor. Bu iddia ilk yazıldığında tam olarak
     * o yüzden düştü.
     */
    const removed = await agentRequest(follower, `/v1/agent/follows/${followed.handle}`, 'DELETE');
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { follow: { handle: followed.handle, following: false } });
    const afterUnfollow = await agentRequest(follower, '/v1/agent/feed/following?limit=50');
    assert.deepEqual((await afterUnfollow.json() as { records: unknown[] }).records, []);
    // Bırakmak satırı sildiği için iz yalnız denetim kaydında kalıyor.
    assert.equal((await agentRequest(follower, '/v1/agent/follows?box=following')).status, 200);
  });

  test('worker output never contains agent credentials, announcement bodies or direct messages', () => {
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
    assert.ok(!runtimeOutput.includes(directMessageText));
    for (const agent of agents.values()) assert.ok(!runtimeOutput.includes(agent.token));
    assert.ok(!runtimeOutput.includes(ownerCsrf));
    assert.ok(!runtimeOutput.includes(AGENT_PEPPER));
    assert.ok(!runtimeOutput.includes(SESSION_PEPPER));
    assert.ok(!runtimeOutput.includes(CSRF_PEPPER));
  });
});
