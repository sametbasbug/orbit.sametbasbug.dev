import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createEntityId } from '../src/server/foundation/ids';
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from '../src/server/identity/constants';
import { createOpaqueToken, hmacDigest, randomBase64Url } from '../src/server/identity/tokens';
import { loadManifest } from './orbit-slice3-manifest';

const ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';
const KEYCHAIN_SERVICE = 'staging.orbit.sametbasbug';
const WRANGLER = 'node_modules/wrangler/bin/wrangler.js';
const CONFIG = 'wrangler.staging.jsonc';

function keychain(binding: string): string {
  const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', binding, '-w'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 0, `Missing staging Keychain binding: ${binding}`);
  assert.ok(result.stdout.trim());
  return result.stdout.trim();
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function d1(command: string): unknown[] {
  const result = spawnSync(process.execPath, [
    WRANGLER, 'd1', 'execute', 'DB', '--remote', '--config', CONFIG,
    '--command', command, '--json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, 'Remote D1 command failed.');
  const parsed = JSON.parse(result.stdout) as Array<{ success: boolean; results?: unknown[] }>;
  assert.ok(parsed.every((item) => item.success));
  return parsed.flatMap((item) => item.results ?? []);
}

async function ownerSession(): Promise<{ token: string; csrf: string; selector: string }> {
  const rows = d1(`
    SELECT a.id FROM accounts a
    JOIN auth_identities ai ON ai.account_id = a.id
    WHERE ai.provider = 'github' AND ai.provider_user_id = '126420524' LIMIT 1
  `) as Array<{ id?: string }>;
  const accountId = rows[0]?.id;
  assert.ok(accountId);
  const sessionPepper = keychain('ORBIT_SESSION_PEPPER_V1');
  const csrfPepper = keychain('ORBIT_CSRF_PEPPER_V1');
  const session = await createOpaqueToken('session', sessionPepper);
  const csrf = randomBase64Url(32);
  const csrfDigest = await hmacDigest(`orbit:csrf:v1:${session.selector}:${csrf}`, csrfPepper);
  const now = Date.now();
  d1(`INSERT INTO sessions (
    id, account_id, secret_digest, hash_version, csrf_digest,
    created_at, last_seen_at, idle_expires_at, absolute_expires_at
  ) VALUES (
    ${quote(session.selector)}, ${quote(accountId)}, ${quote(session.digest)}, ${session.hashVersion},
    ${quote(csrfDigest)}, ${now}, ${now}, ${now + SESSION_IDLE_TTL_MS}, ${now + SESSION_ABSOLUTE_TTL_MS}
  )`);
  return { token: session.token, csrf, selector: session.selector };
}

function authHeaders(session: { token: string; csrf: string }, mutation = false): Headers {
  const headers = new Headers({
    accept: 'application/json',
    cookie: `__Host-orbit_session=${session.token}; __Host-orbit_csrf=${session.csrf}`,
  });
  if (mutation) {
    headers.set('content-type', 'application/json');
    headers.set('origin', ORIGIN);
    headers.set('X-Orbit-CSRF', session.csrf);
  }
  return headers;
}

const manifest = await loadManifest();
const nyx = manifest.entities.agents.find((agent) => agent.handle === 'nyx');
assert.ok(nyx);

const feed = await fetch(`${ORIGIN}/v1/feed?limit=2`);
assert.equal(feed.status, 200);
const feedBody = await feed.json() as { records: Array<{ slug: string }>; nextCursor: string };
assert.deepEqual(feedBody.records.map((record) => record.slug), [
  'orbit-buyudukce-hafifliyor',
  'katki-kime-ait',
]);
assert.match(feedBody.nextCursor, /^oc1\./u);

const next = await fetch(`${ORIGIN}/v1/feed?limit=2&cursor=${encodeURIComponent(feedBody.nextCursor)}`);
assert.equal(next.status, 200);
const tamperedCursor = `${feedBody.nextCursor.slice(0, -1)}${feedBody.nextCursor.endsWith('a') ? 'b' : 'a'}`;
assert.equal((await fetch(`${ORIGIN}/v1/feed?cursor=${encodeURIComponent(tamperedCursor)}`)).status, 400);
assert.equal((await fetch(`${ORIGIN}/v1/feed?agent=nyx&cursor=${encodeURIComponent(feedBody.nextCursor)}`)).status, 400);

const detail = await fetch(`${ORIGIN}/v1/records/katki-kime-ait`);
assert.equal(detail.status, 200);
const detailBody = await detail.json() as { record: { id: string; url: string; replyCount: number } };
assert.equal(detailBody.record.url, '/posts/katki-kime-ait/');
assert.equal(detailBody.record.replyCount, 3);
const thread = await fetch(`${ORIGIN}/v1/records/${detailBody.record.id}/replies`);
assert.equal(thread.status, 200);
assert.equal(((await thread.json()) as { replies: unknown[] }).replies.length, 3);

const profile = await fetch(`${ORIGIN}/v1/agents/nyx?limit=2`);
assert.equal(profile.status, 200);
assert.ok(profile.headers.get('etag'));

const session = await ownerSession();
try {
  const managed = await fetch(`${ORIGIN}/v1/agents/${nyx.id}/manage`, { headers: authHeaders(session) });
  assert.equal(managed.status, 200);
  const etag = managed.headers.get('etag');
  assert.ok(etag);
  assert.match(etag, /^"agent-.+-v\d+"$/u);
  const managedBody = await managed.json() as { agent: { displayName: string; bio: string } };

  const missing = await fetch(`${ORIGIN}/v1/agents/${nyx.id}`, {
    method: 'PATCH', headers: authHeaders(session, true),
    body: JSON.stringify({ displayName: managedBody.agent.displayName }),
  });
  assert.equal(missing.status, 428);

  const updateHeaders = authHeaders(session, true);
  updateHeaders.set('if-match', etag);
  const update = await fetch(`${ORIGIN}/v1/agents/${nyx.id}`, {
    method: 'PATCH', headers: updateHeaders,
    body: JSON.stringify({ displayName: managedBody.agent.displayName, bio: managedBody.agent.bio }),
  });
  assert.equal(update.status, 200, await update.clone().text());
  assert.notEqual(update.headers.get('etag'), etag);

  const staleHeaders = authHeaders(session, true);
  staleHeaders.set('if-match', etag);
  const stale = await fetch(`${ORIGIN}/v1/agents/${nyx.id}`, {
    method: 'PATCH', headers: staleHeaders,
    body: JSON.stringify({ displayName: managedBody.agent.displayName }),
  });
  assert.equal(stale.status, 409);

  d1(`UPDATE records SET lifecycle_state = 'pending' WHERE slug = 'ortak-yorunge-kuruluyor'`);
  assert.equal((await fetch(`${ORIGIN}/v1/records/ortak-yorunge-kuruluyor`)).status, 404);
  const hiddenFeed = await fetch(`${ORIGIN}/v1/feed?limit=20`).then((response) => response.json()) as {
    records: Array<{ slug: string }>;
  };
  assert.ok(!hiddenFeed.records.some((record) => record.slug === 'ortak-yorunge-kuruluyor'));

  d1(`UPDATE agents SET status = 'retired' WHERE id = ${quote(nyx.id)}`);
  const retired = await fetch(`${ORIGIN}/v1/agents/nyx?limit=20`);
  assert.equal(retired.status, 200);
  assert.equal(((await retired.json()) as { agent: { status: string } }).agent.status, 'retired');
} finally {
  d1(`
    UPDATE records SET lifecycle_state = 'published' WHERE slug = 'ortak-yorunge-kuruluyor';
    UPDATE agents SET status = 'active' WHERE id = ${quote(nyx.id)};
    DELETE FROM sessions WHERE id = ${quote(session.selector)};
  `);
}

const proof = d1(`
  SELECT
    (SELECT COUNT(*) FROM legacy_import_entities WHERE entity_type = 'record') AS imported_records,
    (SELECT COUNT(*) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record' WHERE r.kind = 'post') AS posts,
    (SELECT COUNT(*) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record' WHERE r.kind = 'reply') AS replies,
    (SELECT COUNT(*) FROM pragma_foreign_key_check) AS broken_foreign_keys
`) as Array<Record<string, number>>;
assert.deepEqual(proof[0], { imported_records: 13, posts: 7, replies: 6, broken_foreign_keys: 0 });

process.stdout.write(JSON.stringify({
  ok: true,
  runId: createEntityId(),
  imported: { records: 13, posts: 7, replies: 6 },
  cursor: 'signed-keyset-pass',
  visibility: 'pass',
  etag: 'pass',
}) + '\n');
