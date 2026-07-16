import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBase64Url } from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const ACCOUNT_SUBDOMAIN = 'samett33710';
const BUCKET = 'orbit-v6-staging-backups';
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const workerName = `orbit-v6-r2-restore-${suffix}`;
const databaseName = `orbit-v6-r2-restore-${suffix}`;
const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-r2-restore-'));
const configPath = path.join(temp, 'wrangler.json');
const restoreToken = randomBase64Url(32);
let databaseId = '';

function run(args: string[], input?: string): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function keychainSecret(): string {
  const result = spawnSync('security', [
    'find-generic-password', '-s', 'staging.orbit.sametbasbug', '-a', 'backup-encryption-v1', '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('backup_keychain_secret_missing');
  return result.stdout.trim();
}

async function waitForWorker(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`https://${workerName}.${ACCOUNT_SUBDOMAIN}.workers.dev/healthz`, {
      headers: { 'x-orbit-restore-token': restoreToken },
    }).catch(() => null);
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('temporary_restore_worker_not_ready');
}

try {
  const created = run(['d1', 'create', databaseName, '--location', 'eeur']);
  databaseId = /"database_id"\s*:\s*"([^"]+)"/u.exec(created)?.[1] ?? '';
  assert.ok(databaseId, 'Disposable restore D1 ID missing.');
  await writeFile(configPath, JSON.stringify({
    $schema: path.join(ROOT, 'node_modules', 'wrangler', 'config-schema.json'),
    name: workerName,
    main: path.join(ROOT, 'scripts', 'orbit-slice5-r2-restore-worker.ts'),
    compatibility_date: '2026-07-15',
    workers_dev: true,
    preview_urls: false,
    d1_databases: [{
      binding: 'DB', database_name: databaseName, database_id: databaseId,
      migrations_dir: path.join(ROOT, 'migrations'),
    }],
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: BUCKET }],
    observability: { enabled: false },
  }, null, 2), { mode: 0o600 });
  await chmod(configPath, 0o600);
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath]);
  run(['deploy', '--config', configPath, '--message', 'Disposable Slice 5 R2 restore rehearsal']);
  run(['secret', 'put', 'ORBIT_RESTORE_TOKEN', '--config', configPath], `${restoreToken}\n`);
  run(['secret', 'put', 'ORBIT_BACKUP_ENCRYPTION_KEY_V1', '--config', configPath], `${keychainSecret()}\n`);
  await waitForWorker();
  const response = await fetch(`https://${workerName}.${ACCOUNT_SUBDOMAIN}.workers.dev/restore-latest-manual`, {
    method: 'POST',
    headers: { 'x-orbit-restore-token': restoreToken },
  });
  const proof = await response.json() as {
    ok?: boolean;
    code?: string;
    format?: string;
    counts?: Record<string, number>;
    foreignKeyViolations?: number;
    uniqueViolations?: number;
    relationshipViolations?: number;
    securityRevocation?: string;
  };
  assert.equal(response.status, 200, proof.code ?? 'R2 restore failed.');
  assert.equal(proof.ok, true);
  assert.equal(proof.format, 'equinox.orbit.chunked-backup.v1');
  assert.equal(proof.foreignKeyViolations, 0);
  assert.equal(proof.uniqueViolations, 0);
  assert.equal(proof.relationshipViolations, 0);
  assert.equal(proof.securityRevocation, 'applied');
  assert.ok((proof.counts?.records ?? 0) >= 13);
  process.stdout.write(JSON.stringify({
    ok: true,
    source: 'private-r2-encrypted-manual',
    restore: 'disposable-d1-deleted',
    format: proof.format,
    counts: proof.counts,
    foreignKeys: 'verified',
    securityRevocation: 'pass',
  }));
} finally {
  try { run(['delete', '--config', configPath, '--force']); } catch { /* already absent */ }
  if (databaseId) {
    try { run(['d1', 'delete', databaseName, '--skip-confirmation']); } catch { /* cleanup warning suppressed */ }
  }
  await rm(temp, { recursive: true, force: true });
}
