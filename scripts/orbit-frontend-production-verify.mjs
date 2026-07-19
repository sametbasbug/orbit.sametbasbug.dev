#!/usr/bin/env node
import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runScript(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, ['run', script], {
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${script} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function runPhase(label, tasks) {
  const results = await Promise.allSettled(tasks.map(({ script, env }) => runScript(script, env)));
  const failures = results
    .map((result, index) => ({ result, script: tasks[index].script }))
    .filter(({ result }) => result.status === 'rejected');

  if (failures.length > 0) {
    const summary = failures.map(({ script, result }) => `${script}: ${result.reason}`).join('\n');
    throw new Error(`${label} phase failed:\n${summary}`);
  }
}

await runPhase('source validation', [
  { script: 'orbit:test:content' },
  { script: 'check' },
  { script: 'og:generate' },
]);

await runScript('worker:assets:production:live');

await runPhase('built artifact validation', [
  { script: 'site:test', env: { ORBIT_DIST_DIR: 'dist/client' } },
  { script: 'browser:test', env: { ORBIT_DIST_DIR: 'dist/client' } },
  { script: 'production:config:check' },
  { script: 'worker:bundle:production:live' },
]);
