import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createEntityId } from '../src/server/foundation/ids';
import { createOpaqueToken, randomBase64Url } from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.staging.jsonc';
const DATABASE = 'DB';
const DATABASE_ID = '378e09e4-23e9-4112-abb8-90152a302502';
const ACCOUNT_ID = 'c1ff8ccffcbffe46094cd3a2729a1c1f';
const ACCOUNT_SUBDOMAIN = 'samett33710';
const SERVICE = 'staging.orbit.sametbasbug';
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const workerName = `orbit-v6-images-cpu-${suffix}`;
const origin = `https://${workerName}.${ACCOUNT_SUBDOMAIN}.workers.dev`;
const proofToken = randomBase64Url(32);
const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-images-cpu-'));
const proofConfig = path.join(temp, 'wrangler.json');
const secretsFile = path.join(temp, 'secrets.json');
const fixturePath = path.join(temp, 'cpu-proof.jpg');
const now = Date.now();
const stage = (name: string) => process.stderr.write(`[images-cpu] ${name}\n`);

function keychain(name: string): string {
  const result = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 0, `Missing staging binding: ${name}`);
  return result.stdout.trim();
}

function wrangler(args: string[], input?: string): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', input,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
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

async function waitReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (response?.status === 200) {
      await response.arrayBuffer();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail('CPU proof Worker readiness timeout.');
}

async function graphqlMetrics(scriptVersion: string, start: Date, end: Date): Promise<{
  requests: number;
  errors: number;
  statuses: string[];
  cpuMs: { p50: number; p90: number; p95: number; p99: number };
}> {
  const config = await readFile(path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf8');
  const token = /oauth_token\s*=\s*"([^"]+)"/u.exec(config)?.[1];
  assert.ok(token, 'Wrangler OAuth token missing.');
  const query = `query($accountTag: String!, $start: Time!, $end: Time!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 100, filter: {
        datetime_geq: $start, datetime_leq: $end, scriptVersion: "${scriptVersion}"
      }) {
        dimensions { status }
        sum { requests errors }
        quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP95 cpuTimeP99 }
      }
    } }
  }`;
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountTag: ACCOUNT_ID, start: start.toISOString(), end: end.toISOString() } }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json() as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{
        dimensions: { status: string };
        sum: { requests: number; errors: number };
        quantiles: { cpuTimeP50: number; cpuTimeP90: number; cpuTimeP95: number; cpuTimeP99: number };
      }> }> } };
    };
    const rows = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const success = rows.find((row) => row.dimensions.status === 'success');
    if (success && Number(success.sum.requests) >= 20) {
      return {
        requests: rows.reduce((sum, row) => sum + Number(row.sum.requests), 0),
        errors: rows.reduce((sum, row) => sum + Number(row.sum.errors), 0),
        statuses: rows.map((row) => row.dimensions.status),
        cpuMs: {
          p50: success.quantiles.cpuTimeP50 / 1000,
          p90: success.quantiles.cpuTimeP90 / 1000,
          p95: success.quantiles.cpuTimeP95 / 1000,
          p99: success.quantiles.cpuTimeP99 / 1000,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error('workers_analytics_not_ready');
}

let deployed = false;
let agentId = '';
let credentialId = '';
const mediaIds: string[] = [];
try {
  const secretNames = [
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
    'ORBIT_INVITATION_PEPPER_V1',
    'ORBIT_SESSION_PEPPER_V1',
    'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
    'ORBIT_OAUTH_STATE_PEPPER_V1',
    'ORBIT_CSRF_PEPPER_V1',
    'ORBIT_CURSOR_PEPPER_V1',
  ] as const;
  const secrets = Object.fromEntries(secretNames.map((name) => [name, keychain(name)]));
  await writeFile(proofConfig, JSON.stringify({
    $schema: path.join(ROOT, 'node_modules', 'wrangler', 'config-schema.json'),
    name: workerName,
    main: path.join(ROOT, 'scripts/orbit-slice5-images-cpu-worker.ts'),
    compatibility_date: '2026-07-15',
    workers_dev: true,
    preview_urls: false,
    vars: {
      ORBIT_ENVIRONMENT: 'test',
      ORBIT_ALLOWED_ORIGIN: origin,
      ORBIT_GITHUB_CALLBACK_URL: `${origin}/v1/auth/github/callback`,
      ORBIT_PLATFORM_OWNER_GITHUB_ID: '126420524',
      ORBIT_BACKUP_ENABLED: 'false',
      ORBIT_MEDIA_ENABLED: 'true',
    },
    d1_databases: [{
      binding: 'DB', database_name: 'orbit-v6-staging', database_id: DATABASE_ID,
      migrations_dir: path.join(ROOT, 'migrations'),
    }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'orbit-v6-staging-media' }],
    images: { binding: 'IMAGES' },
    observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true } },
  }, null, 2), { mode: 0o600 });
  await chmod(proofConfig, 0o600);
  await writeFile(secretsFile, JSON.stringify({ ...secrets, ORBIT_STAGING_PROOF_TOKEN: proofToken }), { mode: 0o600 });
  await chmod(secretsFile, 0o600);
  stage('deploy');
  wrangler(['deploy', '--config', proofConfig, '--message', 'Disposable Images CPU proof']);
  deployed = true;
  wrangler(['secret', 'bulk', secretsFile, '--config', proofConfig]);
  const versionsOutput = wrangler(['versions', 'list', '--config', proofConfig, '--json']);
  const versions = JSON.parse(versionsOutput.slice(versionsOutput.indexOf('['), versionsOutput.lastIndexOf(']') + 1)) as Array<{ id: string }>;
  const proofVersion = versions.at(-1)?.id;
  assert.ok(proofVersion);
  await waitReady();

  const ownerId = String(execute(`
    SELECT a.id FROM accounts a JOIN auth_identities ai ON ai.account_id = a.id
    WHERE ai.provider = 'github' AND ai.provider_user_id = '126420524' LIMIT 1
  `)[0]?.id ?? '');
  assert.ok(ownerId);
  const agentPepper = secrets.ORBIT_AGENT_CREDENTIAL_PEPPER_V1;
  const credential = await createOpaqueToken('agent', agentPepper);
  agentId = createEntityId();
  credentialId = credential.selector;
  execute(`
    INSERT INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at, version,
      role, short_bio, motto, accent, responsibility, links_json
    ) VALUES (
      ${quote(agentId)}, ${quote(`images-cpu-${suffix}`)}, ${quote(`images-cpu-${suffix}`)},
      'Images CPU proof', '', 'agents/default.webp', 'direct_publish', 'active',
      ${now}, ${now}, 1, '', '', '', '#6f63e8', '', '[]'
    );
    INSERT INTO agent_memberships (
      id, agent_id, account_id, role, created_by_account_id, created_at
    ) VALUES (
      ${quote(createEntityId())}, ${quote(agentId)}, ${quote(ownerId)},
      'primary_sponsor', ${quote(ownerId)}, ${now}
    );
    INSERT INTO agent_credentials (
      id, agent_id, secret_digest, hash_version, scopes, created_by_account_id, created_at
    ) VALUES (
      ${quote(credential.selector)}, ${quote(agentId)}, ${quote(credential.digest)},
      ${credential.hashVersion}, 'feed:read records:write media:write', ${quote(ownerId)}, ${now}
    );
    INSERT INTO agent_media_policies (
      agent_id, media_enabled, daily_image_limit, updated_by_account_id, updated_at
    ) VALUES (${quote(agentId)}, 1, 25, ${quote(ownerId)}, ${now});
  `);

  const raw = randomBytes(1800 * 1200 * 3);
  await sharp(raw, { raw: { width: 1800, height: 1200, channels: 3 } })
    .jpeg({ quality: 86 })
    .toFile(fixturePath);
  const fixture = await readFile(fixturePath);
  stage('20-upload-burst');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const windowStart = new Date(Date.now() - 1_000);
  for (let batch = 0; batch < 5; batch += 1) {
    const results = await Promise.all(Array.from({ length: 4 }, async (_, offset) => {
      const index = batch * 4 + offset;
      const form = new FormData();
      form.set('file', new File([fixture], `cpu-${index}.jpg`, { type: 'image/jpeg' }));
      form.set('altText', `Images binding CPU proof ${index}`);
      const response = await fetch(`${origin}/v1/media/post-images`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.token}`,
          'idempotency-key': `images-cpu-${suffix}-${index}`,
        },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json() as { media: { id: string } }).media.id;
    }));
    mediaIds.push(...results);
  }
  const windowEnd = new Date(Date.now() + 1_000);
  assert.equal(mediaIds.length, 20);

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  execute(`
    UPDATE media_assets
    SET state = 'orphaned', orphan_reason = 'images_cpu_proof',
        orphaned_at = ${now - 8 * 24 * 60 * 60 * 1000}, activated_at = NULL
    WHERE id IN (${mediaIds.map(quote).join(',')});
    UPDATE agent_credentials SET revoked_at = ${Date.now()}, revoked_reason = 'images_cpu_proof'
    WHERE id = ${quote(credentialId)};
    UPDATE agents SET status = 'retired', updated_at = ${Date.now()} WHERE id = ${quote(agentId)};
  `);
  const cleanup = await fetch(`${origin}/__proof/cleanup`, {
    method: 'POST', headers: { 'x-orbit-proof-token': proofToken }, signal: AbortSignal.timeout(120_000),
  });
  assert.equal(cleanup.status, 200);
  const cleanupBody = await cleanup.json() as { result: { deleted: number; failed: number } };
  assert.ok(cleanupBody.result.deleted >= 20);
  assert.equal(cleanupBody.result.failed, 0);

  stage('analytics');
  const metrics = await graphqlMetrics(proofVersion, windowStart, windowEnd);
  assert.equal(metrics.requests, 20);
  assert.equal(metrics.errors, 0);
  assert.ok(!metrics.statuses.includes('exceededCpu'));
  process.stdout.write(JSON.stringify({
    ok: true,
    scriptVersion: proofVersion,
    fixtureBytes: fixture.byteLength,
    uploads: 20,
    http1102: false,
    exceededCpu: false,
    metrics,
  }));
} finally {
  if (deployed) {
    try { wrangler(['delete', '--config', proofConfig, '--force']); } catch { /* already absent */ }
  }
  await rm(temp, { recursive: true, force: true });
}
