import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const files = {
  live: new URL('../wrangler.production.live.jsonc', import.meta.url),
  darkLaunch: new URL('../wrangler.production.dark-launch.jsonc', import.meta.url),
  deployWorkflow: new URL('../.github/workflows/deploy-production.yml', import.meta.url),
};

let assertions = 0;

function fail(message) {
  throw new Error(`Orbit production config validation failed: ${message}`);
}

function assert(condition, message) {
  assertions += 1;
  if (!condition) fail(message);
}

function assertDeepEqual(actual, expected, message) {
  assert(isDeepStrictEqual(actual, expected), message);
}

async function readConfig(url, label) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (error) {
    fail(`${label} is not strict JSON: ${error.message}`);
  }
}

function findForbiddenKeys(value, path = '$') {
  const found = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      found.push(...findForbiddenKeys(entry, `${path}[${index}]`));
    });
    return found;
  }

  if (!value || typeof value !== 'object') return found;

  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (
      ['route', 'routes', 'custom_domain', 'secrets'].includes(key) ||
      /(secret|token|password|private_key|encryption_key|pepper|credential)/i.test(key)
    ) {
      found.push(nextPath);
    }
    found.push(...findForbiddenKeys(entry, nextPath));
  }

  return found;
}

const expectedTopLevelKeys = [
  '$schema',
  'assets',
  'compatibility_date',
  'd1_databases',
  'images',
  'kv_namespaces',
  'main',
  'name',
  'observability',
  'preview_urls',
  'r2_buckets',
  'triggers',
  'vars',
  'workers_dev',
];

const expectedCommonVars = {
  ORBIT_ENVIRONMENT: 'production',
  ORBIT_PLATFORM_OWNER_GITHUB_ID: '126420524',
  ORBIT_BACKUP_ENABLED: 'true',
  ORBIT_MEDIA_ENABLED: 'true',
};

const expectedResources = {
  assets: {
    binding: 'ASSETS',
    directory: './dist/client',
    run_worker_first: true,
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'orbit-v6-production',
      database_id: '199fe088-2f56-48c4-bc81-50b8c5e4b471',
      migrations_dir: 'migrations',
    },
  ],
  kv_namespaces: [
    {
      binding: 'CACHE',
      id: '5c1574a9562448cf863aa84fad10877f',
    },
  ],
  r2_buckets: [
    {
      binding: 'BACKUPS',
      bucket_name: 'orbit-v6-production-backups',
    },
    {
      binding: 'MEDIA',
      bucket_name: 'orbit-v6-production-media',
    },
  ],
  images: {
    binding: 'IMAGES',
  },
  observability: {
    enabled: true,
    logs: {
      enabled: true,
      head_sampling_rate: 1,
      invocation_logs: true,
      persist: true,
    },
  },
  triggers: {
    crons: ['17 3 * * *'],
  },
};

function validateConfig(config, expected) {
  assertDeepEqual(
    Object.keys(config).sort(),
    expectedTopLevelKeys,
    `${expected.label} has an unexpected top-level key`,
  );
  assert(
    findForbiddenKeys(config).length === 0,
    `${expected.label} contains a route, custom-domain, secret, or credential field`,
  );
  assert(config.name === 'orbit-v6-production', `${expected.label} Worker name drifted`);
  assert(config.main === 'src/worker.ts', `${expected.label} Worker entrypoint drifted`);
  assert(
    config.compatibility_date === '2026-07-15',
    `${expected.label} compatibility date drifted`,
  );
  assert(config.workers_dev === expected.workersDev, `${expected.label} workers_dev drifted`);
  assert(config.preview_urls === false, `${expected.label} preview_urls must be false`);

  for (const [key, value] of Object.entries(expectedResources)) {
    assertDeepEqual(config[key], value, `${expected.label} ${key} resource drifted`);
  }

  assertDeepEqual(
    config.vars,
    {
      ORBIT_ENVIRONMENT: 'production',
      ORBIT_DEPLOYMENT_MODE: expected.mode,
      ORBIT_ALLOWED_ORIGIN: expected.origin,
      ORBIT_GITHUB_CALLBACK_URL: `${expected.origin}/v1/auth/github/callback`,
      ORBIT_PLATFORM_OWNER_GITHUB_ID: '126420524',
      ORBIT_BACKUP_ENABLED: 'true',
      ORBIT_MEDIA_ENABLED: 'true',
    },
    `${expected.label} vars drifted`,
  );

  for (const [key, value] of Object.entries(expectedCommonVars)) {
    assert(config.vars[key] === value, `${expected.label} ${key} drifted`);
  }
}

function normalizeModeDifferences(config) {
  const normalized = structuredClone(config);
  delete normalized.workers_dev;
  delete normalized.vars.ORBIT_DEPLOYMENT_MODE;
  delete normalized.vars.ORBIT_ALLOWED_ORIGIN;
  delete normalized.vars.ORBIT_GITHUB_CALLBACK_URL;
  return normalized;
}

const live = await readConfig(files.live, 'live config');
const darkLaunch = await readConfig(files.darkLaunch, 'dark-launch config');
const deployWorkflow = await readFile(files.deployWorkflow, 'utf8');

validateConfig(live, {
  label: 'live config',
  workersDev: false,
  mode: 'live',
  origin: 'https://orbit.sametbasbug.dev',
});

validateConfig(darkLaunch, {
  label: 'dark-launch config',
  workersDev: true,
  mode: 'dark_launch',
  origin: 'https://orbit-v6-production.samett33710.workers.dev',
});

assertDeepEqual(
  normalizeModeDifferences(live),
  normalizeModeDifferences(darkLaunch),
  'live and dark-launch configs differ outside the reviewed mode surface',
);

assert(
  deployWorkflow.includes('ORBIT_LIVE_OAUTH_CLIENT_ID: ${{ secrets.ORBIT_LIVE_OAUTH_CLIENT_ID }}'),
  'production deploy does not source the live OAuth client ID from the production environment',
);
assert(
  deployWorkflow.includes('ORBIT_LIVE_OAUTH_CLIENT_SECRET: ${{ secrets.ORBIT_LIVE_OAUTH_CLIENT_SECRET }}'),
  'production deploy does not source the live OAuth client secret from the production environment',
);
assert(
  deployWorkflow.includes('--secrets-file "$oauth_secrets_file"'),
  'production deploy does not upload the live OAuth pair with the Worker version',
);
assert(
  deployWorkflow.includes("trap 'rm -f \"$oauth_secrets_file\"' EXIT"),
  'production deploy does not clean up its temporary OAuth secrets file',
);
process.stdout.write(`Orbit production config tests: ${assertions} assertions passed\n`);
