import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker from '../src/worker';
import {
  assertDeploymentBindings,
  assertIdentityBindings,
  type OrbitBindings,
  type OrbitDeploymentMode,
} from '../src/server/identity/bindings';

const DARK_LAUNCH_ORIGIN = 'https://orbit-v6-production.samett33710.workers.dev';
const LIVE_ORIGIN = 'https://orbit.sametbasbug.dev';
const CRAWLER_DENIAL = 'noindex, nofollow, noarchive';

function testDatabase(): OrbitBindings['DB'] {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  } as OrbitBindings['DB'];
}

const baseBindings = {
  DB: testDatabase(),
  ORBIT_PLATFORM_OWNER_GITHUB_ID: '126420524',
  GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
  ORBIT_INVITATION_PEPPER_V1: 'test-invitation-pepper-at-least-32-bytes-long',
  ORBIT_SESSION_PEPPER_V1: 'test-session-pepper-at-least-32-bytes-long',
  ORBIT_AGENT_CREDENTIAL_PEPPER_V1: 'test-agent-pepper-at-least-32-bytes-long',
  ORBIT_OAUTH_STATE_PEPPER_V1: 'test-oauth-pepper-at-least-32-bytes-long',
  ORBIT_CSRF_PEPPER_V1: 'test-csrf-pepper-at-least-32-bytes-long',
  ORBIT_CURSOR_PEPPER_V1: 'test-cursor-pepper-at-least-32-bytes-long',
} as const;

function assetBinding(): NonNullable<OrbitBindings['ASSETS']> {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/missing') return new Response('Not found', { status: 404 });
      if (path === '/robots.txt') {
        return new Response('User-agent: *\nAllow: /\n', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return new Response('<!doctype html><title>Orbit</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}

function stagingBindings(overrides: Partial<OrbitBindings> = {}): OrbitBindings {
  return {
    ...baseBindings,
    ORBIT_ENVIRONMENT: 'staging',
    ORBIT_DEPLOYMENT_MODE: 'dark_launch',
    ORBIT_ALLOWED_ORIGIN: 'https://orbit-v6-staging.samett33710.workers.dev',
    ORBIT_GITHUB_CALLBACK_URL:
      'https://orbit-v6-staging.samett33710.workers.dev/v1/auth/github/callback',
    ASSETS: assetBinding(),
    ...overrides,
  };
}

function productionBindings(
  mode: OrbitDeploymentMode,
  overrides: Partial<OrbitBindings> = {},
): OrbitBindings {
  const origin = mode === 'dark_launch' ? DARK_LAUNCH_ORIGIN : LIVE_ORIGIN;
  return {
    ...baseBindings,
    ORBIT_ENVIRONMENT: 'production',
    ORBIT_DEPLOYMENT_MODE: mode,
    ORBIT_ALLOWED_ORIGIN: origin,
    ORBIT_GITHUB_CALLBACK_URL: `${origin}/v1/auth/github/callback`,
    ASSETS: assetBinding(),
    ...overrides,
  };
}

function localBindings(environment: 'local' | 'test'): OrbitBindings {
  return {
    ...baseBindings,
    ORBIT_ENVIRONMENT: environment,
    ORBIT_DEPLOYMENT_MODE: 'live',
    ORBIT_ALLOWED_ORIGIN: environment === 'local' ? 'http://localhost:4321' : 'https://test.example',
    ORBIT_GITHUB_CALLBACK_URL: environment === 'local'
      ? 'http://localhost:4321/v1/auth/github/callback'
      : 'https://test.example/v1/auth/github/callback',
    ASSETS: assetBinding(),
  };
}

async function assertCrawlerDenied(response: Response): Promise<void> {
  assert.equal(response.headers.get('x-robots-tag'), CRAWLER_DENIAL);
  await response.arrayBuffer();
}

async function protectedSurfaceResponses(env: OrbitBindings): Promise<Response[]> {
  const origin = env.ORBIT_ALLOWED_ORIGIN;
  return [
    await worker.fetch(new Request(`${origin}/healthz`), env),
    await worker.fetch(new Request(`${origin}/dashboard`), env),
    await worker.fetch(new Request(`${origin}/`), env),
    await worker.fetch(new Request(`${origin}/missing`), env),
    await worker.fetch(new Request(`${origin}/v1/not-found`), env),
    await worker.fetch(new Request(`${origin}/v1/auth/github/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
    }), env),
  ];
}

describe('Orbit V6 deployment-mode contract', () => {
  test('requires an explicit supported deployment mode', () => {
    assert.throws(
      () => assertDeploymentBindings({
        ...productionBindings('dark_launch'),
        ORBIT_DEPLOYMENT_MODE: undefined,
      } as unknown as OrbitBindings),
      /invalid_deployment_mode/u,
    );
    assert.throws(
      () => assertDeploymentBindings({
        ...productionBindings('dark_launch'),
        ORBIT_DEPLOYMENT_MODE: 'preview',
      } as unknown as OrbitBindings),
      /invalid_deployment_mode/u,
    );
  });

  test('accepts exact production dark-launch Workers.dev origin and callback', () => {
    assert.doesNotThrow(() => assertIdentityBindings(productionBindings('dark_launch')));
  });

  test('rejects wrong, wildcard and lookalike Workers.dev hosts', () => {
    for (const origin of [
      'https://orbit-v6-production.attacker.workers.dev',
      'https://*.workers.dev',
      'https://orbit-v6-production.samett33710.workers.dev.evil.example',
      'https://evil-orbit-v6-production.samett33710.workers.dev',
    ]) {
      assert.throws(
        () => assertDeploymentBindings(productionBindings('dark_launch', {
          ORBIT_ALLOWED_ORIGIN: origin,
          ORBIT_GITHUB_CALLBACK_URL: `${origin}/v1/auth/github/callback`,
        })),
        /invalid_production_origin/u,
      );
    }
  });

  test('accepts exact production live origin and callback', () => {
    assert.doesNotThrow(() => assertIdentityBindings(productionBindings('live')));
  });

  test('rejects dark-launch values in live mode and live values in dark-launch mode', () => {
    assert.throws(
      () => assertDeploymentBindings(productionBindings('live', {
        ORBIT_ALLOWED_ORIGIN: DARK_LAUNCH_ORIGIN,
        ORBIT_GITHUB_CALLBACK_URL: `${DARK_LAUNCH_ORIGIN}/v1/auth/github/callback`,
      })),
      /invalid_production_origin/u,
    );
    assert.throws(
      () => assertDeploymentBindings(productionBindings('dark_launch', {
        ORBIT_ALLOWED_ORIGIN: LIVE_ORIGIN,
        ORBIT_GITHUB_CALLBACK_URL: `${LIVE_ORIGIN}/v1/auth/github/callback`,
      })),
      /invalid_production_origin/u,
    );
  });

  test('rejects callbacks that do not exactly match their production mode', () => {
    assert.throws(
      () => assertDeploymentBindings(productionBindings('dark_launch', {
        ORBIT_GITHUB_CALLBACK_URL: `${LIVE_ORIGIN}/v1/auth/github/callback`,
      })),
      /invalid_production_callback/u,
    );
    assert.throws(
      () => assertDeploymentBindings(productionBindings('live', {
        ORBIT_GITHUB_CALLBACK_URL: `${DARK_LAUNCH_ORIGIN}/v1/auth/github/callback`,
      })),
      /invalid_production_callback/u,
    );
  });

  test('keeps the exact staging contract and requires dark-launch mode', () => {
    assert.doesNotThrow(() => assertIdentityBindings(stagingBindings()));
    assert.throws(
      () => assertDeploymentBindings(stagingBindings({ ORBIT_DEPLOYMENT_MODE: 'live' })),
      /invalid_staging_deployment_mode/u,
    );
    assert.throws(
      () => assertDeploymentBindings(stagingBindings({ ORBIT_ALLOWED_ORIGIN: 'https://evil.example' })),
      /invalid_staging_origin/u,
    );
    assert.throws(
      () => assertDeploymentBindings(stagingBindings({ ORBIT_GITHUB_CALLBACK_URL: 'https://evil.example/callback' })),
      /invalid_staging_callback/u,
    );
  });

  test('adds crawler denial to every staging and production dark-launch response class', async () => {
    for (const env of [stagingBindings(), productionBindings('dark_launch')]) {
      const responses = await protectedSurfaceResponses(env);
      assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 404, 404, 201]);
      for (const response of responses) await assertCrawlerDenied(response);
    }

    const staging = stagingBindings();
    const oauthRedirect = await worker.fetch(new Request(`${staging.ORBIT_ALLOWED_ORIGIN}/__staging/oauth`), staging);
    assert.equal(oauthRedirect.status, 302);
    await assertCrawlerDenied(oauthRedirect);

    const failingAssets = productionBindings('dark_launch', {
      ASSETS: {
        async fetch() {
          throw new Error('simulated_asset_failure');
        },
      },
    });
    const failure = await worker.fetch(new Request(`${failingAssets.ORBIT_ALLOWED_ORIGIN}/failure`), failingAssets);
    assert.equal(failure.status, 500);
    await assertCrawlerDenied(failure);
  });

  test('serves a dynamic deny-all robots policy in staging and production dark launch', async () => {
    for (const env of [stagingBindings(), productionBindings('dark_launch')]) {
      const response = await worker.fetch(new Request(`${env.ORBIT_ALLOWED_ORIGIN}/robots.txt`), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), CRAWLER_DENIAL);
      assert.equal(await response.text(), 'User-agent: *\nDisallow: /\n');
    }
  });

  test('keeps production live indexable and serves the public robots asset', async () => {
    const env = productionBindings('live');
    const responses = await protectedSurfaceResponses(env);
    for (const response of responses) {
      assert.equal(response.headers.get('x-robots-tag'), null);
      await response.arrayBuffer();
    }
    const robots = await worker.fetch(new Request(`${env.ORBIT_ALLOWED_ORIGIN}/robots.txt`), env);
    assert.equal(robots.headers.get('x-robots-tag'), null);
    assert.match(await robots.text(), /Allow: \//u);
  });

  test('preserves local and test validation without adding crawler denial', async () => {
    for (const env of [localBindings('local'), localBindings('test')]) {
      assert.doesNotThrow(() => assertIdentityBindings(env));
      const response = await worker.fetch(new Request(`${env.ORBIT_ALLOWED_ORIGIN}/healthz`), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-robots-tag'), null);
    }
  });
});
