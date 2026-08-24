/**
 * Yerel D1 üzerinde koşan test worker'ı için ortak kurulum.
 *
 * orbit-d1-test-worker.ts'i wrangler dev ile geçici bir persist dizininde
 * ayağa kaldırır ve aksiyon çağrısı yapan bir yardımcı döner. Aynı kurulumu
 * birden fazla test dosyası kullandığı için tek yerde duruyor.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reserveWorkerPorts } from '../orbit-test-ports';
import { useFreshConnectionPerRequest } from './test-http';

/* Havuzda bekleyen bir keep-alive soketi, bu dosyanın spawnSync
 * bloklarından sağ çıkmıyor; gerekçesi support/test-http.ts içinde. */
useFreshConnectionPerRequest();

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.test.jsonc';

export interface TestWorker {
  baseUrl: string;
  /** Migration çıktıları: ilk uygulama ve idempotent ikinci uygulama. */
  migrationOutputs: [string, string];
  callAction<T>(action: string, data?: Record<string, unknown>, expectedStatus?: number): Promise<T>;
  stop(): Promise<void>;
}

function runMigrations(persistDirectory: string): string {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER,
      'd1',
      'migrations',
      'apply',
      'orbit-v6-local',
      '--config',
      CONFIG,
      '--local',
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    },
  );

  if (result.status !== 0) {
    throw new Error(`Migration command failed:\n${result.stdout}\n${result.stderr}`);
  }

  return `${result.stdout}\n${result.stderr}`;
}

async function waitForWorker(worker: ChildProcessWithoutNullStreams, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let output = '';
  worker.stdout.on('data', (chunk) => { output += String(chunk); });
  worker.stderr.on('data', (chunk) => { output += String(chunk); });

  while (Date.now() < deadline) {
    if (worker.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready:\n${output}`);
    }
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'health' }),
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not bound the local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Wrangler did not become ready within 20 seconds:\n${output}`);
}

export async function startTestWorker(): Promise<TestWorker> {
  const persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-d1-'));
  const migrationOutputs: [string, string] = [
    runMigrations(persistDirectory),
    runMigrations(persistDirectory),
  ];

  /* Port'u kendi başımıza seçmiyoruz: bind(0) ile bulunan bir port, wrangler
   * onu bağlayana kadar boş görünmeye devam eder ve aynı anda koşan başka bir
   * test dosyası aynı portu alabilir. Rezervasyon o aralığı kapatıyor. */
  const { port, inspectorPort } = await reserveWorkerPorts();
  const baseUrl = `http://127.0.0.1:${port}`;
  const worker = spawn(
    process.execPath,
    [
      WRANGLER,
      'dev',
      '--config',
      CONFIG,
      '--local',
      `--port=${port}`,
      `--inspector-port=${inspectorPort}`,
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  await waitForWorker(worker, baseUrl);

  return {
    baseUrl,
    migrationOutputs,
    async callAction<T>(
      action: string,
      data: Record<string, unknown> = {},
      expectedStatus = 200,
    ): Promise<T> {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, data }),
      });
      const body = await response.json() as T;
      assert.equal(
        response.status,
        expectedStatus,
        `${action} returned ${response.status}: ${JSON.stringify(body)}`,
      );
      return body;
    },
    async stop(): Promise<void> {
      if (worker.exitCode === null) {
        worker.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => worker.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
        if (worker.exitCode === null) worker.kill('SIGKILL');
      }
      await rm(persistDirectory, { recursive: true, force: true });
    },
  };
}
