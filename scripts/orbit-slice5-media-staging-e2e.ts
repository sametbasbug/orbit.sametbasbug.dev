import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, hmacDigest, randomBase64Url } from '../src/server/identity/tokens';
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from '../src/server/identity/constants';
import sharp from 'sharp';

const ROOT = process.cwd();
const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const SERVICE = 'staging.orbit.sametbasbug';
const CONFIG = 'wrangler.staging.jsonc';
const DATABASE = 'DB';
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DATABASE_ID = '378e09e4-23e9-4112-abb8-90152a302502';
const ACCOUNT_SUBDOMAIN = 'samett33710';
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const cleanupWorker = `orbit-v6-media-cleanup-${suffix}`;
let cleanupOrigin = `https://${cleanupWorker}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
const cleanupToken = randomBase64Url(32);
const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-media-e2e-'));
const cleanupConfig = path.join(temp, 'wrangler.json');
const now = Date.now();
const nativeFetch = globalThis.fetch;
const fetch = (input: RequestInfo | URL, init: RequestInit = {}) => nativeFetch(input, {
  ...init,
  signal: init.signal ?? AbortSignal.timeout(120_000),
});
const stage = (name: string) => process.stderr.write(`[media-e2e] ${name}\n`);

interface Fixture {
  path: string;
  type: 'image/png' | 'image/jpeg';
  name: string;
}

async function statusOf(response: Response): Promise<number> {
  const status = response.status;
  await response.arrayBuffer();
  return status;
}

function keychain(name: string): string {
  const result = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 0, `Missing staging binding: ${name}`);
  return result.stdout.trim();
}

function runWrangler(args: string[], input?: string): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('wrangler_command_failed');
  return `${result.stdout}\n${result.stderr}`;
}

function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function execute(sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'execute', DATABASE, '--remote', '--config', CONFIG, '--command', sql, '--json',
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(result.status, 0, 'Remote D1 command failed.');
  const parsed = JSON.parse(result.stdout) as Array<{ success: boolean; results?: Array<Record<string, unknown>> }>;
  assert.ok(parsed.every((item) => item.success));
  return parsed.flatMap((item) => item.results ?? []);
}

async function session(accountId: string, sessionPepper: string, csrfPepper: string, createdAt: number) {
  const token = await createOpaqueToken('session', sessionPepper);
  const csrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${token.selector}:${csrf}`, csrfPepper);
  execute(`
    INSERT INTO sessions (
      id, account_id, secret_digest, hash_version, csrf_digest,
      created_at, last_seen_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      ${quote(token.selector)}, ${quote(accountId)}, ${quote(token.digest)}, ${token.hashVersion}, ${quote(csrfDigest)},
      ${createdAt}, ${createdAt}, ${createdAt + SESSION_IDLE_TTL_MS}, ${createdAt + SESSION_ABSOLUTE_TTL_MS}
    )
  `);
  return { token: token.token, csrf, id: token.selector };
}

async function seedAgent(ownerId: string, handle: string, mode: 'direct_publish' | 'approval_required', pepper: string, createdAt: number) {
  const id = createEntityId();
  const credential = await createOpaqueToken('agent', pepper);
  execute(`
    INSERT INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at, version,
      role, short_bio, motto, accent, responsibility, links_json
    ) VALUES (
      ${quote(id)}, ${quote(handle)}, ${quote(handle)}, ${quote(handle)}, '', 'agents/default.webp',
      ${quote(mode)}, 'active', ${createdAt}, ${createdAt}, 1,
      '', '', '', '#6f63e8', '', '[]'
    );
    INSERT INTO agent_memberships (
      id, agent_id, account_id, role, created_by_account_id, created_at
    ) VALUES (
      ${quote(createEntityId())}, ${quote(id)}, ${quote(ownerId)}, 'primary_sponsor', ${quote(ownerId)}, ${createdAt}
    );
    INSERT INTO agent_credentials (
      id, agent_id, secret_digest, hash_version, scopes, created_by_account_id, created_at
    ) VALUES (
      ${quote(credential.selector)}, ${quote(id)}, ${quote(credential.digest)}, ${credential.hashVersion},
      'feed:read records:write media:write', ${quote(ownerId)}, ${createdAt}
    )
  `);
  return { id, token: credential.token, credentialId: credential.selector };
}

function humanHeaders(current: { token: string; csrf: string }, mutation = false): Headers {
  const headers = new Headers({
    cookie: `__Host-orbit_session=${current.token}; __Host-orbit_csrf=${current.csrf}`,
    accept: 'application/json',
  });
  if (mutation) {
    headers.set('origin', ORIGIN);
    headers.set('x-orbit-csrf', current.csrf);
  }
  return headers;
}

async function humanJson(
  current: { token: string; csrf: string },
  pathname: string,
  method: string,
  body: unknown,
  idempotencyKey?: string,
) {
  const headers = humanHeaders(current, true);
  headers.set('content-type', 'application/json');
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return await fetch(`${ORIGIN}${pathname}`, { method, headers, body: JSON.stringify(body) });
}

async function uploadAvatar(
  current: { token: string; csrf: string },
  pathname: string,
  fixture: Fixture,
) {
  const form = new FormData();
  form.set('file', new File([await readFile(fixture.path)], fixture.name, { type: fixture.type }));
  return await fetch(`${ORIGIN}${pathname}`, {
    method: 'POST', headers: humanHeaders(current, true), body: form,
  });
}

async function uploadPostImage(
  token: string,
  key: string,
  fixture: Fixture,
  declaredType: string = fixture.type,
) {
  const form = new FormData();
  form.set('file', new File([await readFile(fixture.path)], fixture.name, { type: declaredType }));
  form.set('altText', 'Orbit staging medya doğrulama görseli');
  form.set('caption', 'Yalnız staging E2E kanıtı.');
  return await fetch(`${ORIGIN}/v1/media/post-images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    body: form,
  });
}

async function assertWebp(
  response: Response,
  expected: { width?: number; height?: number; longEdge?: number },
): Promise<{ width: number; height: number; byteSize: number }> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'webp');
  assert.ok(metadata.width && metadata.height);
  if (expected.width !== undefined) assert.equal(metadata.width, expected.width);
  if (expected.height !== undefined) assert.equal(metadata.height, expected.height);
  if (expected.longEdge !== undefined) assert.equal(Math.max(metadata.width, metadata.height), expected.longEdge);
  return { width: metadata.width, height: metadata.height, byteSize: bytes.byteLength };
}

async function agentJson(token: string, pathname: string, body: unknown, key: string) {
  return await fetch(`${ORIGIN}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
}

async function waitReady(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${ORIGIN}/v1/media/capabilities`).catch(() => null);
    if (response?.status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail('Media staging deployment readiness timeout.');
}

async function deployCleanupWorker(): Promise<void> {
  await writeFile(cleanupConfig, JSON.stringify({
    $schema: path.join(ROOT, 'node_modules', 'wrangler', 'config-schema.json'),
    name: cleanupWorker,
    main: path.join(ROOT, 'scripts', 'orbit-slice5-media-cleanup-worker.ts'),
    compatibility_date: '2026-07-15',
    workers_dev: true,
    preview_urls: false,
    vars: { ORBIT_MEDIA_ENABLED: 'true' },
    d1_databases: [{
      binding: 'DB', database_name: 'orbit-v6-staging', database_id: DATABASE_ID,
      migrations_dir: path.join(ROOT, 'migrations'),
    }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'orbit-v6-staging-media' }],
    observability: { enabled: false },
  }, null, 2), { mode: 0o600 });
  await chmod(cleanupConfig, 0o600);
  const deployment = runWrangler(['deploy', '--config', cleanupConfig, '--message', 'Disposable Slice 5 media cleanup proof']);
  const deployedUrls = deployment.match(/https:\/\/[^\s]+\.workers\.dev/gu) ?? [];
  cleanupOrigin = deployedUrls.at(-1)?.replace(/[),.;]+$/u, '') ?? cleanupOrigin;
  runWrangler(['secret', 'put', 'ORBIT_STAGING_CLEANUP_TOKEN', '--config', cleanupConfig], `${cleanupToken}\n`);
  cleanupDeployed = true;
}

async function cleanupRequest(pathname: '/cleanup' | '/count'): Promise<Response> {
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${cleanupOrigin}${pathname}`, {
      method: 'POST', headers: { 'x-orbit-cleanup-token': cleanupToken },
    }).catch(() => null);
    lastStatus = response?.status ?? 0;
    if (response?.status === 200) return response;
    lastBody = response ? (await response.text()).slice(0, 160) : 'network_error';
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`temporary_media_cleanup_worker_not_ready:${lastStatus}:${lastBody}`);
}

async function mediaObjectCount(): Promise<number> {
  const response = await cleanupRequest('/count');
  return Number((await response.json() as { count: number }).count);
}

async function runCleanup(): Promise<{ candidates: number; deleted: number; failed: number }> {
  const response = await cleanupRequest('/cleanup');
  return (await response.json() as { result: { candidates: number; deleted: number; failed: number } }).result;
}

async function buildFixtures(): Promise<{
  avatarPng: Fixture;
  avatarJpeg: Fixture;
  nearLimitPng: Fixture;
  postPng: Fixture;
  postJpeg: Fixture;
  corruptPng: Fixture;
}> {
  const fixture = (name: string, type: Fixture['type']): Fixture => ({
    path: path.join(temp, name), type, name,
  });
  const avatarPng = fixture('avatar-wide-3000x1800.png', 'image/png');
  const avatarJpeg = fixture('avatar-tall-1800x3000.jpg', 'image/jpeg');
  const nearLimitPng = fixture('avatar-near-5mib.png', 'image/png');
  const postPng = fixture('post-wide-3600x2200.png', 'image/png');
  const postJpeg = fixture('post-tall-2200x3600.jpg', 'image/jpeg');
  const corruptPng = fixture('corrupt-but-shaped.png', 'image/png');
  await sharp({ create: { width: 3000, height: 1800, channels: 4, background: '#6d5dfc' } }).png().toFile(avatarPng.path);
  await sharp({ create: { width: 1800, height: 3000, channels: 3, background: '#0f172a' } }).jpeg({ quality: 92 }).toFile(avatarJpeg.path);
  await sharp({ create: { width: 3600, height: 2200, channels: 4, background: '#14b8a6' } }).png().toFile(postPng.path);
  await sharp({ create: { width: 2200, height: 3600, channels: 3, background: '#f97316' } }).jpeg({ quality: 94 }).toFile(postJpeg.path);
  const noise = randomBytes(1250 * 1250 * 3);
  const nearLimit = await sharp(noise, { raw: { width: 1250, height: 1250, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  assert.ok(nearLimit.byteLength >= 4 * 1024 * 1024 && nearLimit.byteLength < 5 * 1024 * 1024);
  await writeFile(nearLimitPng.path, nearLimit);
  const corrupt = new Uint8Array(33);
  corrupt.set([137,80,78,71,13,10,26,10], 0);
  corrupt.set([0,0,0,13,73,72,68,82], 8);
  new DataView(corrupt.buffer).setUint32(16, 800);
  new DataView(corrupt.buffer).setUint32(20, 600);
  await writeFile(corruptPng.path, corrupt);
  return { avatarPng, avatarJpeg, nearLimitPng, postPng, postJpeg, corruptPng };
}

let cleanupDeployed = false;
try {
  const fixtures = await buildFixtures();
  stage('readiness');
  await waitReady();
  await deployCleanupWorker();
  stage('prior-run-cleanup');
  execute(`
    UPDATE media_assets
    SET state = 'orphaned', orphan_reason = 'staging_prior_run_cleanup',
        orphaned_at = ${now - 8 * 24 * 60 * 60 * 1000}, activated_at = NULL
    WHERE state != 'deleted' AND (
      owner_account_id IN (SELECT id FROM accounts WHERE handle LIKE 'media-account-%')
      OR owner_agent_id IN (SELECT id FROM agents WHERE handle LIKE 'media-%')
    );
  `);
  await runCleanup();
  execute(`
    UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, ${now}),
      revoked_reason = COALESCE(revoked_reason, 'staging_prior_run_cleanup')
    WHERE agent_id IN (SELECT id FROM agents WHERE handle LIKE 'media-%');
    UPDATE agents SET status = 'retired', updated_at = ${now}
    WHERE handle LIKE 'media-%' AND status != 'retired';
    UPDATE sessions SET revoked_at = COALESCE(revoked_at, ${now}),
      revoked_reason = COALESCE(revoked_reason, 'staging_prior_run_cleanup')
    WHERE account_id IN (SELECT id FROM accounts WHERE handle LIKE 'media-account-%');
    UPDATE accounts SET status = 'closed', updated_at = ${now}
    WHERE handle LIKE 'media-account-%' AND status != 'closed';
  `);
  const sessionPepper = keychain('ORBIT_SESSION_PEPPER_V1');
  const csrfPepper = keychain('ORBIT_CSRF_PEPPER_V1');
  const agentPepper = keychain('ORBIT_AGENT_CREDENTIAL_PEPPER_V1');
  const ownerId = String(execute(`
    SELECT a.id FROM accounts a JOIN auth_identities ai ON ai.account_id = a.id
    WHERE ai.provider = 'github' AND ai.provider_user_id = '126420524' LIMIT 1
  `)[0]?.id ?? '');
  assert.ok(ownerId);

  const testAccountId = createEntityId();
  execute(`
    INSERT INTO accounts (
      id, handle, handle_normalized, display_name, avatar_url, status, created_at, updated_at
    ) VALUES (
      ${quote(testAccountId)}, ${quote(`media-account-${suffix}`)}, ${quote(`media-account-${suffix}`)},
      'Media staging account', NULL, 'active', ${now}, ${now}
    )
  `);
  const ownerSession = await session(ownerId, sessionPepper, csrfPepper, now + 1);
  const accountSession = await session(testAccountId, sessionPepper, csrfPepper, now + 2);
  const direct = await seedAgent(ownerId, `media-direct-${suffix}`, 'direct_publish', agentPepper, now + 3);
  const approval = await seedAgent(ownerId, `media-review-${suffix}`, 'approval_required', agentPepper, now + 4);
  const unauthorized = await seedAgent(ownerId, `media-denied-${suffix}`, 'direct_publish', agentPepper, now + 5);

  stage('large-png-account-avatar');
  const accountAvatarResponse = await uploadAvatar(accountSession, '/v1/me/avatar', fixtures.avatarPng);
  assert.equal(accountAvatarResponse.status, 201);
  const accountAvatar = await accountAvatarResponse.json() as { media: { id: string; url: string; width: number; height: number } };
  assert.deepEqual([accountAvatar.media.width, accountAvatar.media.height], [512, 512]);
  assert.equal(await statusOf(await fetch(`${ORIGIN}${accountAvatar.media.url}`)), 404);
  const accountAvatarOutput = await assertWebp(
    await fetch(`${ORIGIN}${accountAvatar.media.url}`, { headers: humanHeaders(accountSession) }),
    { width: 512, height: 512 },
  );

  stage('near-limit-png-avatar');
  const nearLimitResponse = await uploadAvatar(accountSession, '/v1/me/avatar', fixtures.nearLimitPng);
  assert.equal(nearLimitResponse.status, 201);
  const nearLimitAvatar = await nearLimitResponse.json() as { media: { id: string; url: string; width: number; height: number } };
  assert.deepEqual([nearLimitAvatar.media.width, nearLimitAvatar.media.height], [512, 512]);
  const nearLimitOutput = await assertWebp(
    await fetch(`${ORIGIN}${nearLimitAvatar.media.url}`, { headers: humanHeaders(accountSession) }),
    { width: 512, height: 512 },
  );

  stage('large-jpeg-agent-avatar');
  const agentAvatarResponse = await uploadAvatar(ownerSession, `/v1/agents/${direct.id}/avatar`, fixtures.avatarJpeg);
  assert.equal(agentAvatarResponse.status, 201);
  const agentAvatar = await agentAvatarResponse.json() as { media: { id: string; url: string; width: number; height: number } };
  assert.deepEqual([agentAvatar.media.width, agentAvatar.media.height], [512, 512]);
  const publicAvatar = await fetch(`${ORIGIN}${agentAvatar.media.url}`);
  const agentAvatarOutput = await assertWebp(publicAvatar, { width: 512, height: 512 });

  stage('media-policy');
  assert.equal(await statusOf(await humanJson(ownerSession, `/v1/admin/agents/${direct.id}/media-policy`, 'PATCH', {
    mediaEnabled: true, dailyImageLimit: 2,
  })), 200);
  assert.equal(await statusOf(await humanJson(ownerSession, `/v1/admin/agents/${approval.id}/media-policy`, 'PATCH', {
    mediaEnabled: true, dailyImageLimit: 1,
  })), 200);

  stage('media-capabilities');
  const capabilities = await fetch(`${ORIGIN}/v1/media/capabilities`, {
    headers: { authorization: `Bearer ${direct.token}` },
  }).then((response) => response.json()) as { mediaEnabled: boolean; dailyImageLimit: number };
  assert.deepEqual(capabilities, {
    ...capabilities, mediaEnabled: true, dailyImageLimit: 2,
  });

  stage('mime-mismatch');
  const mismatch = await uploadPostImage(direct.token, `media-${suffix}-mismatch`, fixtures.postJpeg, 'image/png');
  assert.equal(mismatch.status, 415);
  await mismatch.arrayBuffer();

  stage('unauthorized-agent');
  const denied = await uploadPostImage(unauthorized.token, `media-${suffix}-denied`, fixtures.postPng);
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();

  stage('decode-failure-no-residue');
  const beforeFailure = execute(`
    SELECT
      (SELECT COUNT(*) FROM media_assets) AS media_rows,
      (SELECT COUNT(*) FROM media_transform_claims) AS transform_claims,
      (SELECT COUNT(*) FROM media_transform_results WHERE status = 'failed') AS failed_transforms
  `)[0] as { media_rows: number; transform_claims: number; failed_transforms: number };
  const objectsBeforeFailure = await mediaObjectCount();
  const corrupt = await uploadPostImage(direct.token, `media-${suffix}-corrupt`, fixtures.corruptPng);
  assert.equal(corrupt.status, 503);
  await corrupt.arrayBuffer();
  const afterFailure = execute(`
    SELECT
      (SELECT COUNT(*) FROM media_assets) AS media_rows,
      (SELECT COUNT(*) FROM media_transform_claims) AS transform_claims,
      (SELECT COUNT(*) FROM media_transform_results WHERE status = 'failed') AS failed_transforms
  `)[0] as typeof beforeFailure;
  assert.equal(Number(afterFailure.media_rows), Number(beforeFailure.media_rows));
  assert.equal(Number(afterFailure.transform_claims), Number(beforeFailure.transform_claims) + 1);
  assert.equal(Number(afterFailure.failed_transforms), Number(beforeFailure.failed_transforms) + 1);
  assert.equal(await mediaObjectCount(), objectsBeforeFailure);

  stage('large-png-direct-upload');
  const directUpload = await uploadPostImage(direct.token, `media-${suffix}-direct`, fixtures.postPng);
  assert.equal(directUpload.status, 201);
  const directMedia = await directUpload.json() as { media: { id: string; width: number; height: number } };
  assert.equal(Math.max(directMedia.media.width, directMedia.media.height), 2400);
  assert.equal(await statusOf(await fetch(`${ORIGIN}/v1/media/${directMedia.media.id}`)), 404);
  const attemptsBeforeReplay = Number(execute(`
    SELECT attempted_count FROM media_transform_usage_monthly WHERE month_utc = strftime('%Y-%m', 'now')
  `)[0]?.attempted_count ?? 0);
  const uploadReplay = await uploadPostImage(direct.token, `media-${suffix}-direct`, fixtures.postPng);
  assert.equal(uploadReplay.status, 201);
  assert.equal(uploadReplay.headers.get('idempotency-replayed'), 'true');
  await uploadReplay.arrayBuffer();
  const attemptsAfterReplay = Number(execute(`
    SELECT attempted_count FROM media_transform_usage_monthly WHERE month_utc = strftime('%Y-%m', 'now')
  `)[0]?.attempted_count ?? 0);
  assert.equal(attemptsAfterReplay, attemptsBeforeReplay);

  const directPost = await agentJson(direct.token, '/v1/records', {
    bodyMarkdown: 'Staging R2 medya doğrudan yayın kanıtı.',
    projectSlug: 'orbit', topicSlugs: ['sistemler'], mediaId: directMedia.media.id,
  }, `media-${suffix}-publish`);
  assert.equal(directPost.status, 201);
  const directRecord = await directPost.json() as { record: { id: string } };
  const activeMedia = await fetch(`${ORIGIN}/v1/media/${directMedia.media.id}`);
  assert.match(activeMedia.headers.get('cache-control') ?? '', /^public,/u);
  const directOutput = await assertWebp(activeMedia, { longEdge: 2400 });
  assert.ok(Math.abs(directOutput.width / directOutput.height - 3600 / 2200) < 0.02);
  const publicRecord = await fetch(`${ORIGIN}/v1/records/${directRecord.record.id}`).then((response) => response.json()) as {
    record: { media: { id: string; url: string } | null };
  };
  assert.equal(publicRecord.record.media?.id, directMedia.media.id);

  const replyWithMedia = await agentJson(direct.token, `/v1/records/${directRecord.record.id}/replies`, {
    bodyMarkdown: 'Yanıt görsel kabul etmemeli.', mediaId: directMedia.media.id,
  }, `media-${suffix}-reply`);
  assert.equal(replyWithMedia.status, 400);
  await replyWithMedia.arrayBuffer();

  stage('large-jpeg-pending-media');
  const pendingUpload = await uploadPostImage(approval.token, `media-${suffix}-pending`, fixtures.postJpeg);
  assert.equal(pendingUpload.status, 201);
  const pendingMedia = await pendingUpload.json() as { media: { id: string } };
  const pendingPost = await agentJson(approval.token, '/v1/records', {
    bodyMarkdown: 'Staging R2 pending medya gizlilik kanıtı.', topicSlugs: ['orbit'], mediaId: pendingMedia.media.id,
  }, `media-${suffix}-pending-post`);
  assert.equal(pendingPost.status, 202);
  const pendingRecord = await pendingPost.json() as { record: { id: string } };
  assert.equal(await statusOf(await fetch(`${ORIGIN}/v1/media/${pendingMedia.media.id}`)), 404);
  const pendingOutput = await assertWebp(
    await fetch(`${ORIGIN}/v1/media/${pendingMedia.media.id}`, { headers: humanHeaders(ownerSession) }),
    { longEdge: 2400 },
  );
  assert.ok(Math.abs(pendingOutput.width / pendingOutput.height - 2200 / 3600) < 0.02);
  const reviews = await fetch(`${ORIGIN}/v1/approvals`, { headers: humanHeaders(ownerSession) }).then((response) => response.json()) as {
    reviews: Array<{ id: string; record: { id: string }; media: { id: string } | null }>;
  };
  const review = reviews.reviews.find((item) => item.record.id === pendingRecord.record.id);
  assert.equal(review?.media?.id, pendingMedia.media.id);
  assert.equal(await statusOf(await humanJson(ownerSession, `/v1/approvals/${review?.id}/reject`, 'POST', {
    note: 'Staging rejected media cleanup proof.',
  }, `media-${suffix}-reject`)), 200);
  assert.equal(await statusOf(await fetch(`${ORIGIN}/v1/media/${pendingMedia.media.id}`)), 404);

  const overQuota = await uploadPostImage(approval.token, `media-${suffix}-quota`, fixtures.postJpeg);
  assert.equal(overQuota.status, 429);
  await overQuota.arrayBuffer();

  stage('cleanup');
  assert.equal(await statusOf(await humanJson(ownerSession, `/v1/manage/records/${directRecord.record.id}/delete`, 'POST', {
    reason: 'Slice 5 staging media cleanup.',
  }, `media-${suffix}-delete`)), 200);
  execute(`
    UPDATE media_assets
    SET state = 'orphaned',
        orphan_reason = 'staging_test_cleanup',
        orphaned_at = ${now - 8 * 24 * 60 * 60 * 1000},
        activated_at = NULL
    WHERE id IN (
      ${quote(accountAvatar.media.id)}, ${quote(nearLimitAvatar.media.id)}, ${quote(agentAvatar.media.id)},
      ${quote(directMedia.media.id)}, ${quote(pendingMedia.media.id)}
    );
  `);
  const cleanup = await runCleanup();
  assert.ok(cleanup.deleted >= 5);
  assert.equal(cleanup.failed, 0);
  assert.equal(await statusOf(await fetch(`${ORIGIN}/v1/media/${directMedia.media.id}`)), 404);

  stage('evidence');
  const evidence = execute(`
    SELECT
      (SELECT COUNT(*) FROM media_assets WHERE id IN (
        ${quote(accountAvatar.media.id)}, ${quote(nearLimitAvatar.media.id)}, ${quote(agentAvatar.media.id)},
        ${quote(directMedia.media.id)}, ${quote(pendingMedia.media.id)}
      )) AS media_rows,
      (SELECT COUNT(*) FROM media_assets WHERE id IN (
        ${quote(accountAvatar.media.id)}, ${quote(nearLimitAvatar.media.id)}, ${quote(agentAvatar.media.id)},
        ${quote(directMedia.media.id)}, ${quote(pendingMedia.media.id)}
      ) AND state = 'deleted') AS cleaned_rows,
      (SELECT COUNT(*) FROM audit_events WHERE event_type IN (
        'account.avatar_replaced', 'agent.avatar_replaced',
        'agent.media_policy_changed', 'media.post_image_staged'
      )
        AND created_at >= ${now}) AS media_audits,
      (SELECT COUNT(*) FROM agent_media_uploads WHERE agent_id IN (
        ${quote(direct.id)}, ${quote(approval.id)}
      )) AS quota_rows
  `)[0] as { media_rows: number; cleaned_rows: number; media_audits: number; quota_rows: number };
  assert.equal(Number(evidence.media_rows), 5);
  assert.equal(Number(evidence.cleaned_rows), 5);
  assert.ok(Number(evidence.media_audits) >= 6);
  assert.equal(Number(evidence.quota_rows), 2);

  stage('encrypted-backup');
  const backup = await humanJson(ownerSession, '/v1/admin/backups', 'POST', {});
  assert.equal(backup.status, 201);
  await backup.arrayBuffer();

  execute(`
    UPDATE agent_credentials SET revoked_at = ${Date.now()}, revoked_reason = 'staging_test_cleanup'
    WHERE id IN (${quote(direct.credentialId)}, ${quote(approval.credentialId)}, ${quote(unauthorized.credentialId)});
    UPDATE agents SET status = 'retired', updated_at = ${Date.now()}
    WHERE id IN (${quote(direct.id)}, ${quote(approval.id)}, ${quote(unauthorized.id)});
    UPDATE sessions SET revoked_at = ${Date.now()}, revoked_reason = 'staging_test_cleanup'
    WHERE id IN (${quote(ownerSession.id)}, ${quote(accountSession.id)});
    UPDATE accounts SET status = 'closed', updated_at = ${Date.now()}
    WHERE id = ${quote(testAccountId)};
  `);

  process.stdout.write(JSON.stringify({
    ok: true,
    buckets: 'private-worker-bindings',
    avatars: 'account-private-agent-public',
    transforms: 'webp-validated',
    policy: 'owner-only-data-driven',
    publication: 'direct-public',
    pending: 'sponsor-private',
    quota: 'pass',
    cleanup: 'real-r2-pass',
    encryptedBackup: 'r2-readback-pass',
    secrets: 'not-emitted',
    fixtures: {
      avatarPng: { bytes: (await readFile(fixtures.avatarPng.path)).byteLength, dimensions: [3000, 1800] },
      avatarJpeg: { bytes: (await readFile(fixtures.avatarJpeg.path)).byteLength, dimensions: [1800, 3000] },
      nearLimitPng: { bytes: (await readFile(fixtures.nearLimitPng.path)).byteLength, dimensions: [1250, 1250] },
      postPng: { bytes: (await readFile(fixtures.postPng.path)).byteLength, dimensions: [3600, 2200] },
      postJpeg: { bytes: (await readFile(fixtures.postJpeg.path)).byteLength, dimensions: [2200, 3600] },
    },
    outputs: {
      accountAvatar: accountAvatarOutput,
      nearLimitAvatar: nearLimitOutput,
      agentAvatar: agentAvatarOutput,
      postPng: directOutput,
      postJpeg: pendingOutput,
    },
  }));
} finally {
  if (cleanupDeployed) {
    try { runWrangler(['delete', '--config', cleanupConfig, '--force']); } catch { /* already absent */ }
  }
  await rm(temp, { recursive: true, force: true });
}
