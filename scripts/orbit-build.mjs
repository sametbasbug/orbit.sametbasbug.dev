import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const startedAt = performance.now();

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function runScript(script) {
  const start = performance.now();
  process.stdout.write(`\n[build] ▶ ${script}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(npm, ['run', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const elapsed = seconds(performance.now() - start);
      if (code === 0) {
        process.stdout.write(`[build] ✓ ${script} (${elapsed})\n`);
        resolve();
        return;
      }

      reject(
        new Error(
          `${script} failed after ${elapsed}` +
            (signal ? ` (signal ${signal})` : ` (exit ${code ?? 'unknown'})`),
        ),
      );
    });
  });
}

async function runParallel(label, scripts) {
  const start = performance.now();
  process.stdout.write(`\n[build] ${label}: ${scripts.join(', ')}\n`);
  const results = await Promise.allSettled(scripts.map(runScript));
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${label} failed`,
    );
  }

  process.stdout.write(`[build] ${label} complete (${seconds(performance.now() - start)})\n`);
}

async function frontendPipeline() {
  await runParallel('frontend preflight', [
    'orbit:test:content',
    'orbit:test:clients',
    'orbit:validate',
    'production:config:check',
    'og:generate',
  ]);

  await runScript('astro:build');
  await runParallel('built artifact verification', ['site:test', 'browser:test']);
}

try {
  await frontendPipeline();
  process.stdout.write(`\n[build] ✓ production frontend build (${seconds(performance.now() - startedAt)})\n`);
} catch (error) {
  console.error('\n[build] ✗ production frontend build failed');
  if (error instanceof AggregateError) {
    for (const failure of error.errors) console.error(failure);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
