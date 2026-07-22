import { spawnSync } from 'node:child_process';
import { unstable_dev } from 'wrangler';

const KEYCHAIN_SERVICE = 'dev.orbit.sametbasbug';
const REQUIRED_BINDINGS = [
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'ORBIT_INVITATION_PEPPER_V1',
  'ORBIT_SESSION_PEPPER_V1',
  'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
  'ORBIT_OAUTH_STATE_PEPPER_V1',
  'ORBIT_CSRF_PEPPER_V1',
  'ORBIT_CURSOR_PEPPER_V1',
];

function readKeychain(binding) {
  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    binding,
    '-w',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) {
    throw new Error(
      `Missing macOS Keychain item ${KEYCHAIN_SERVICE}/${binding}. `
      + 'See docs/V6_SLICE1_IDENTITY.md.',
    );
  }
  const value = result.stdout.trim();
  if (!value) throw new Error(`Empty Keychain item: ${binding}`);
  return value;
}

const build = spawnSync(
  process.execPath,
  ['node_modules/astro/bin/astro.mjs', 'build', '--config', 'astro.worker.config.mjs'],
  { stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const vars = {
  ORBIT_ENVIRONMENT: 'local',
  ORBIT_DEPLOYMENT_MODE: 'live',
  ORBIT_ALLOWED_ORIGIN: 'http://localhost:4321',
  ORBIT_GITHUB_CALLBACK_URL: 'http://localhost:4321/v1/auth/github/callback',
  ORBIT_PLATFORM_OWNER_GITHUB_ID: '126420524',
  ...Object.fromEntries(REQUIRED_BINDINGS.map((name) => [name, readKeychain(name)])),
};
const worker = await unstable_dev('src/worker.ts', {
  config: 'wrangler.jsonc',
  ip: '127.0.0.1',
  port: 4321,
  local: true,
  persist: true,
  vars,
  logLevel: 'error',
  experimental: {
    showInteractiveDevSession: false,
  },
});

process.stdout.write('Orbit V6 local: http://localhost:4321\n');
process.stdout.write('OAuth callback: http://localhost:4321/v1/auth/github/callback\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await worker.stop();
    process.exit(0);
  });
}

await worker.waitUntilExit();
