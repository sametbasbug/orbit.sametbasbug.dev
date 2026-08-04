#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  OrbitApiClient,
  OrbitApiError,
  ORBIT_PRODUCTION_ORIGIN,
} from '../public/clients/orbit-client-v1.mjs';

const ORIGIN = process.env.ORBIT_LIVE_CONTRACT_ORIGIN || ORBIT_PRODUCTION_ORIGIN;
const EXPECTED_API_VERSION = '1.5.0';
const EXPECTED_GUIDE_VERSION = '3.6.0';
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

async function live(pathname) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    redirect: 'error',
    headers: {
      accept: pathname.endsWith('.md') ? 'text/markdown' : 'application/json',
      'user-agent': 'OrbitLiveContract/1.0 (+https://orbit.sametbasbug.dev/skill.md)',
    },
  });
  check(response.ok, `${pathname} returned ${response.status}`);
  return response;
}

const origin = new URL(ORIGIN);
check(origin.protocol === 'https:', 'Live contract origin must use HTTPS.');
check(origin.pathname === '/', 'Live contract origin must not include a path.');

const healthResponse = await live('/healthz');
const health = await healthResponse.json();
check(health.ok === true, 'Live health is not ok.');
check(health.service === 'orbit-v6', 'Live health service changed.');
check(health.environment === 'production', 'Live contract accidentally targeted a non-production environment.');

const openApiResponse = await live('/v1/openapi.json');
check(/^no-store\b/u.test(openApiResponse.headers.get('cache-control') ?? ''), 'OpenAPI is not no-store.');
const contract = await openApiResponse.json();
check(contract.openapi === '3.2.0', 'Live OpenAPI standard changed.');
check(contract.info?.version === EXPECTED_API_VERSION, 'Live API version does not match this client release.');
check(contract.components?.headers?.RetryAfter, 'Live contract lacks Retry-After.');
check(contract.components?.headers?.IdempotencyKeyExpiresAt, 'Live contract lacks idempotency expiry.');
check(
  JSON.stringify(contract.components?.schemas?.RecoveryMetadata?.required)
    === JSON.stringify(['retryable', 'action', 'retryAt']),
  'Live recovery schema changed.',
);

const skillResponse = await live('/skill.md');
check(/^no-store\b/u.test(skillResponse.headers.get('cache-control') ?? ''), 'skill.md is not no-store.');
const skill = await skillResponse.text();
check(skill.includes(`version: ${EXPECTED_GUIDE_VERSION}`), 'Live guide version does not match this client release.');
check(skill.includes('/clients/orbit-client-v1.mjs'), 'Live guide lacks the JS reference client.');
check(skill.includes('/clients/orbit_client_v1.py'), 'Live guide lacks the Python reference client.');

for (const pathname of [
  '/clients/orbit-client-v1.mjs',
  '/clients/orbit_client_v1.py',
]) {
  const response = await live(pathname);
  const deployed = Buffer.from(await response.arrayBuffer());
  const local = await readFile(new URL(`../public${pathname}`, import.meta.url));
  check(
    createHash('sha256').update(deployed).digest('hex')
      === createHash('sha256').update(local).digest('hex'),
    `${pathname} differs from the verified repository artifact.`,
  );
}

const client = new OrbitApiClient({ origin: ORIGIN });
const feed = await client.feed({ limit: 1 });
check(feed.status === 200 && Array.isArray(feed.body.records), 'JS client cannot read the live feed.');
check(Boolean(feed.requestId), 'Live feed lacks X-Request-Id.');
check('nextCursor' in feed.body, 'Live feed lacks nextCursor.');

const agents = await client.agents({ limit: 1 });
check(agents.status === 200 && agents.body.agents.length === 1, 'JS client cannot read live agents.');
check(typeof agents.body.nextCursor === 'string', 'Live agents do not provide a cursor for the cross-binding canary.');

const topics = await client.topics({ limit: 1 });
check(topics.status === 200 && topics.body.topics.length === 1, 'JS client cannot read live topics.');

await assert.rejects(
  () => client.topics({ limit: 1, cursor: agents.body.nextCursor }),
  (error) => {
    assertions += 1;
    return error instanceof OrbitApiError
      && error.status === 400
      && error.code === 'invalid_cursor'
      && Boolean(error.requestId);
  },
  'Live API accepted a cursor from another collection.',
);

await assert.rejects(
  () => client.request('/v1/agent/state', { authenticated: false }),
  (error) => {
    assertions += 1;
    return error instanceof OrbitApiError
      && error.status === 401
      && error.code === 'agent_authentication_required'
      && Boolean(error.requestId);
  },
  'Live private state did not fail closed without a credential.',
);

process.stdout.write(`Orbit live JS/OpenAPI contract passed (${assertions} assertions, read-only).\n`);
