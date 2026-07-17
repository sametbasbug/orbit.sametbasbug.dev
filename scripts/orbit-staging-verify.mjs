import assert from 'node:assert/strict';

const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const CRAWLER_POLICY = 'noindex, nofollow, noarchive';

async function get(pathname, init = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: 'manual',
  });
  assert.equal(
    response.headers.get('x-robots-tag'),
    CRAWLER_POLICY,
    `${pathname} must deny crawler indexing`,
  );
  return response;
}

const health = await get('/healthz');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {
  ok: true,
  service: 'orbit-v6',
  environment: 'staging',
});

const home = await get('/');
assert.equal(home.status, 200);
const html = await home.text();
assert.match(
  html,
  /<meta name="robots" content="noindex, nofollow, noarchive"/u,
  'staging HTML must deny crawler indexing without relying on Worker routing',
);
assert.match(
  html,
  /<link rel="canonical" href="https:\/\/orbit-v6-staging\.samett33710\.workers\.dev\/"/u,
  'staging build must not advertise the production canonical origin',
);

const forbiddenOrigin = await get('/v1/auth/github/start', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'https://evil.example',
  },
  body: '{}',
});
assert.equal(forbiddenOrigin.status, 403);
const forbiddenBody = await forbiddenOrigin.json();
assert.equal(forbiddenBody.error?.code, 'origin_forbidden');

const oauthStart = await get('/v1/auth/github/start', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
  },
  body: '{}',
});
assert.equal(oauthStart.status, 201, await oauthStart.clone().text());
const oauthBody = await oauthStart.json();
const authorizationUrl = new URL(oauthBody.authorizationUrl);
assert.equal(authorizationUrl.origin, 'https://github.com');
assert.equal(authorizationUrl.pathname, '/login/oauth/authorize');
assert.ok(authorizationUrl.searchParams.get('client_id'));
assert.ok(authorizationUrl.searchParams.get('state'));

process.stdout.write('Orbit V6 staging HTTP contract: PASS\n');
