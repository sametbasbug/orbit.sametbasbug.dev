import assert from 'node:assert/strict';

import { LEGAL_LAST_UPDATED } from '../src/data/legal';

const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const CRAWLER_POLICY = 'noindex, nofollow, noarchive';

async function get(pathname: string, init: RequestInit = {}): Promise<Response> {
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

/* Onay, /start'ın gövdesinde isteniyor ve sürümü karşılaştırılıyor. Sürüm
 * buraya elle yazılmıyor: kaynaktan içe aktarılıyor, çünkü elle yazılan bir
 * tarih metin güncellendiği gün sessizce eskiyor ve bu betik o gün staging'i
 * değil kendini doğrulamış olur. Betiğin `.ts` olmasının sebebi de bu. */
async function startOAuth(): Promise<Response> {
  return await get('/v1/auth/google/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({ acceptedTerms: true, termsVersion: LEGAL_LAST_UPDATED }),
  });
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

const forbiddenOrigin = await get('/v1/auth/google/start', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'https://evil.example',
  },
  body: JSON.stringify({ acceptedTerms: true, termsVersion: LEGAL_LAST_UPDATED }),
});
assert.equal(forbiddenOrigin.status, 403);
const forbiddenBody = await forbiddenOrigin.json() as { error?: { code?: string } };
assert.equal(forbiddenBody.error?.code, 'origin_forbidden');

/* Onaysız istek reddedilmeli. Bu satır bir kapının değil, bir sıranın
 * testi: onay sağlayıcıya gitmeden önce alınıyor, dönüşte değil. */
const withoutConsent = await get('/v1/auth/google/start', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: ORIGIN,
  },
  body: '{}',
});
assert.equal(withoutConsent.status, 400);
const withoutConsentBody = await withoutConsent.json() as { error?: { code?: string } };
assert.equal(withoutConsentBody.error?.code, 'terms_not_accepted');

const googleStart = await startOAuth();
assert.equal(googleStart.status, 201, await googleStart.clone().text());
const googleBody = await googleStart.json() as { authorizationUrl: string };
const googleUrl = new URL(googleBody.authorizationUrl);
assert.equal(googleUrl.origin, 'https://accounts.google.com');
assert.equal(googleUrl.pathname, '/o/oauth2/v2/auth');
assert.ok(googleUrl.searchParams.get('client_id'), 'staging must carry a Google client id');
assert.ok(googleUrl.searchParams.get('state'));
assert.equal(googleUrl.searchParams.get('code_challenge_method'), 'S256');
assert.ok(googleUrl.searchParams.get('code_challenge'));
assert.equal(googleUrl.searchParams.get('scope'), 'openid email profile');
assert.equal(
  googleUrl.searchParams.get('redirect_uri'),
  `${ORIGIN}/v1/auth/google/callback`,
  'the callback Google is told about must be the one this deployment answers on',
);

process.stdout.write('Orbit V6 staging HTTP contract: PASS\n');
