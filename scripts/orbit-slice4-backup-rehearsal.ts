import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBase64Url } from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STAGING_D1_ID = '378e09e4-23e9-4112-abb8-90152a302502';
const ACCOUNT_SUBDOMAIN = 'samett33710';
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const sourceWorker = `orbit-v6-backup-source-${suffix}`;
const restoreWorker = `orbit-v6-backup-restore-${suffix}`;
const restoreDatabase = `orbit-v6-backup-restore-${suffix}`;
const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-backup-rehearsal-'));
const sourceConfig = path.join(temp, 'source.json');
const restoreConfig = path.join(temp, 'restore.json');
const restoreToken = randomBase64Url(32);
let restoreDatabaseId = '';

function run(args: string[]): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['ignore','pipe','pipe'],
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function config(file: string, name: string, databaseName: string, databaseId: string): Promise<void> {
  await writeFile(file, JSON.stringify({
    $schema: path.join(ROOT, 'node_modules', 'wrangler', 'config-schema.json'),
    name,
    main: path.join(ROOT, 'scripts', 'orbit-slice4-restore-worker.ts'),
    compatibility_date: '2026-07-15',
    workers_dev: true,
    preview_urls: false,
    vars: { ORBIT_RESTORE_TOKEN: restoreToken },
    d1_databases: [{
      binding: 'DB', database_name: databaseName, database_id: databaseId,
      migrations_dir: path.join(ROOT, 'migrations'),
    }],
    observability: { enabled: false },
  }, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function request(worker: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`https://${worker}.${ACCOUNT_SUBDOMAIN}.workers.dev${pathname}`, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-orbit-restore-token': restoreToken },
  });
}

async function waitForExport(worker: string): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request(worker, '/export');
    lastStatus = response.status;
    if (response.status === 200) return response;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`temporary_worker_not_ready:${worker}:${lastStatus}`);
}

try {
  const created = run(['d1','create',restoreDatabase,'--location','eeur']);
  restoreDatabaseId = /"database_id"\s*:\s*"([^"]+)"/u.exec(created)?.[1] ?? '';
  assert.ok(restoreDatabaseId, 'Disposable restore D1 ID missing.');
  await config(sourceConfig, sourceWorker, 'orbit-v6-staging', STAGING_D1_ID);
  await config(restoreConfig, restoreWorker, restoreDatabase, restoreDatabaseId);
  run(['d1','migrations','apply','DB','--remote','--config',restoreConfig]);
  run(['deploy','--config',sourceConfig,'--message','Slice 4 source export rehearsal']);
  run(['deploy','--config',restoreConfig,'--message','Slice 4 restore rehearsal']);

  const exportedResponse = await waitForExport(sourceWorker);
  const exportedPayload = await exportedResponse.json() as {
    schema: string; counts: Record<string, number>; checksum: { value: string };
    security: { containsPlaintextSecrets: boolean };
    code?: string;
  };
  assert.equal(exportedResponse.status, 200, exportedPayload.code ?? 'source export failed');
  const backup = exportedPayload;
  assert.equal(backup.schema, 'equinox.orbit.dynamic-backup.v1');
  assert.equal(backup.security.containsPlaintextSecrets, false);
  assert.ok(backup.counts.records >= 13);

  const emptyBeforeRestore = await waitForExport(restoreWorker).then((response) => response.json()) as {
    counts: Record<string, number>;
  };
  assert.equal(emptyBeforeRestore.counts.agents, 0);
  assert.equal(emptyBeforeRestore.counts.records, 0);

  const corrupted = structuredClone(backup);
  corrupted.checksum.value = `${corrupted.checksum.value.slice(0, -1)}x`;
  const rejected = await request(restoreWorker, '/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backup: corrupted, revokeSecurity: true }),
  });
  assert.equal(rejected.status, 400);
  const empty = await request(restoreWorker, '/export').then((response) => response.json()) as {
    counts: Record<string, number>;
  };
  assert.equal(empty.counts.agents, 0);
  assert.equal(empty.counts.records, 0);

  const restored = await request(restoreWorker, '/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backup, revokeSecurity: true }),
  });
  assert.equal(restored.status, 200, await restored.text());
  const restoredExport = await request(restoreWorker, '/export').then((response) => response.json()) as {
    counts: Record<string, number>;
    tables: { agentCredentials: Array<{ revoked_at: number | null }>; sessions: Array<{ revoked_at: number | null }> };
  };
  for (const [name, count] of Object.entries(backup.counts)) {
    assert.equal(restoredExport.counts[name], count, `Count mismatch: ${name}`);
  }
  assert.ok(restoredExport.tables.agentCredentials.every((row) => row.revoked_at !== null));
  assert.ok(restoredExport.tables.sessions.every((row) => row.revoked_at !== null));

  process.stdout.write(JSON.stringify({
    ok: true,
    format: backup.schema,
    source: 'staging-d1',
    restore: 'disposable-d1-deleted',
    counts: backup.counts,
    checksum: 'verified',
    corruptedExport: 'atomically-rejected',
    foreignKeys: 'verified-by-restore-transaction',
    securityRevocation: 'pass',
  }));
} finally {
  for (const file of [sourceConfig, restoreConfig]) {
    try { run(['delete','--config',file,'--force']); } catch { /* already absent */ }
  }
  if (restoreDatabaseId) {
    try { run(['d1','delete',restoreDatabase,'--skip-confirmation']); } catch { /* cleanup warning suppressed */ }
  }
  await rm(temp, { recursive: true, force: true });
}
