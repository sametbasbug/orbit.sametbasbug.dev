import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const source = `orbit-v6-slice3-rehearsal-${suffix}`;
const restored = `orbit-v6-slice3-restore-${suffix}`;
const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-cutover-'));
const exportPath = path.join(temp, 'orbit-v6-cutover.sql');
const sourceConfig = path.join(temp, 'source.wrangler.json');
const restoreConfig = path.join(temp, 'restore.wrangler.json');

function run(args: string[], quiet = false): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function execute(config: string, command: string): Array<Record<string, unknown>> {
  const output = run([
    'd1', 'execute', 'DB', '--remote', '--config', config,
    '--command', command, '--json',
  ], true);
  const parsed = JSON.parse(output) as Array<{ success: boolean; results?: Array<Record<string, unknown>> }>;
  assert.ok(parsed.every((item) => item.success));
  return parsed.flatMap((item) => item.results ?? []);
}

function importTo(config: string): Record<string, number> {
  const imported = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'scripts/orbit-slice3-import.ts', '--remote', '--database=DB',
    `--config=${config}`,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  if (imported.status !== 0) throw new Error(`${imported.stdout}\n${imported.stderr}`);
  return JSON.parse(imported.stdout.trim()) as Record<string, number>;
}

async function writeConfig(file: string, name: string, id: string): Promise<void> {
  await writeFile(file, JSON.stringify({
    $schema: path.join(ROOT, 'node_modules', 'wrangler', 'config-schema.json'),
    name: `orbit-v6-cutover-${suffix}`,
    main: path.join(ROOT, 'src', 'worker.ts'),
    compatibility_date: '2026-07-15',
    d1_databases: [{
      binding: 'DB',
      database_name: name,
      database_id: id,
      migrations_dir: path.join(ROOT, 'migrations'),
    }],
  }, null, 2), { mode: 0o600 });
}

try {
  const sourceCreated = run(['d1', 'create', source, '--location', 'eeur']);
  const restoredCreated = run(['d1', 'create', restored, '--location', 'eeur']);
  const sourceId = /"database_id"\s*:\s*"([^"]+)"/u.exec(sourceCreated)?.[1];
  const restoredId = /"database_id"\s*:\s*"([^"]+)"/u.exec(restoredCreated)?.[1];
  assert.ok(sourceId && restoredId, 'Wrangler did not return disposable D1 IDs.');
  await writeConfig(sourceConfig, source, sourceId);
  await writeConfig(restoreConfig, restored, restoredId);
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', sourceConfig]);
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', restoreConfig]);

  const importProof = importTo(sourceConfig);
  const restoreImportProof = importTo(restoreConfig);

  run([
    'd1', 'export', 'DB', '--remote', '--config', sourceConfig,
    '--skip-confirmation', '--no-schema', '--output', exportPath,
  ]);
  await chmod(exportPath, 0o600);
  const exportedData = await readFile(exportPath, 'utf8');
  const restoreRows = execute(restoreConfig, `
    SELECT
      (SELECT COUNT(*) FROM legacy_import_entities WHERE entity_type = 'record') AS imported_records,
      (SELECT COUNT(*) FROM records WHERE kind = 'post') AS posts,
      (SELECT COUNT(*) FROM records WHERE kind = 'reply') AS replies,
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM topics) AS topics,
      (SELECT COUNT(*) FROM pragma_foreign_key_check) AS broken_foreign_keys
  `);
  assert.deepEqual(restoreRows[0], {
    imported_records: 13,
    posts: 7,
    replies: 6,
    agents: 4,
    projects: 6,
    topics: 4,
    broken_foreign_keys: 0,
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    source: 'disposable-d1-deleted',
    restored: 'disposable-d1-deleted',
    importProof,
    restoreImportProof,
    offProviderExport: {
      bytes: Buffer.byteLength(exportedData),
      sha256: createHash('sha256').update(exportedData).digest('hex'),
      restoreMode: 'migrations-plus-versioned-manifest',
    },
    restoreProof: restoreRows[0],
  }) + '\n');
} finally {
  for (const database of [source, restored]) {
    try {
      run(['d1', 'delete', database, '--skip-confirmation'], true);
    } catch {
      process.stderr.write(`Warning: disposable D1 cleanup failed for ${database}.\n`);
    }
  }
  await rm(temp, { recursive: true, force: true });
}
