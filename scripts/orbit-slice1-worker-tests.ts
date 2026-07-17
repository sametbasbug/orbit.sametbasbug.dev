import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker from '../src/worker';
import {
  assertIdentityBindings,
  type OrbitBindings,
} from '../src/server/identity/bindings';

const baseBindings = {
  DB: {} as OrbitBindings['DB'],
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

function stagingBindings(overrides: Partial<OrbitBindings> = {}): OrbitBindings {
  return {
    ...baseBindings,
    ORBIT_ENVIRONMENT: 'staging',
    ORBIT_ALLOWED_ORIGIN: 'https://orbit-v6-staging.samett33710.workers.dev',
    ORBIT_GITHUB_CALLBACK_URL:
      'https://orbit-v6-staging.samett33710.workers.dev/v1/auth/github/callback',
    ASSETS: {
      async fetch() {
        return new Response('<!doctype html><title>Orbit staging</title>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
    ...overrides,
  };
}

describe('Orbit V6 staging contract', () => {
  test('accepts only the exact staging origin and callback', () => {
    assert.doesNotThrow(() => assertIdentityBindings(stagingBindings()));
    assert.throws(
      () => assertIdentityBindings(stagingBindings({ ORBIT_ALLOWED_ORIGIN: 'https://evil.example' })),
      /invalid_staging_origin/u,
    );
    assert.throws(
      () => assertIdentityBindings(stagingBindings({ ORBIT_GITHUB_CALLBACK_URL: 'https://evil.example/callback' })),
      /invalid_staging_callback/u,
    );
  });

  test('adds a crawler-denial header to health and static staging responses', async () => {
    const env = stagingBindings();
    const health = await worker.fetch(new Request(`${env.ORBIT_ALLOWED_ORIGIN}/healthz`), env);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'orbit-v6',
      environment: 'staging',
    });

    const page = await worker.fetch(new Request(`${env.ORBIT_ALLOWED_ORIGIN}/`), env);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  });

  test('does not add staging crawler policy in production', async () => {
    const env = stagingBindings({
      ORBIT_ENVIRONMENT: 'production',
      ORBIT_ALLOWED_ORIGIN: 'https://orbit.sametbasbug.dev',
      ORBIT_GITHUB_CALLBACK_URL: 'https://orbit.sametbasbug.dev/v1/auth/github/callback',
    });
    const response = await worker.fetch(new Request('https://orbit.sametbasbug.dev/healthz'), env);
    assert.equal(response.headers.get('x-robots-tag'), null);
  });
});
