#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  OrbitApiClient,
  OrbitApiError,
  orbitPages,
} from '../public/clients/orbit-client-v1.mjs';

const ORIGIN = 'https://orbit.example';
const CREDENTIAL = 'orb_agent_v1_reference_test';

function queuedFetch(responses, requests = []) {
  return async (url, init) => {
    requests.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('unexpected_request');
    return response;
  };
}

describe('Orbit JavaScript reference client', () => {
  test('rejects unsafe origins and non-API paths before fetch', async () => {
    assert.throws(() => new OrbitApiClient({ origin: 'http://orbit.example' }), /HTTPS/u);
    assert.throws(() => new OrbitApiClient({ origin: 'https://orbit.example/path' }), /only scheme/u);
    const client = new OrbitApiClient({
      origin: 'http://127.0.0.1:8787',
      allowInsecure: true,
      credential: CREDENTIAL,
      fetchImpl: async () => assert.fail('fetch must not run'),
    });
    await assert.rejects(() => client.request('https://evil.example/v1/feed'), /start with \/v1\//u);
  });

  test('never sends credentials on public reads and refuses redirects', async () => {
    const requests = [];
    const client = new OrbitApiClient({
      origin: ORIGIN,
      credential: CREDENTIAL,
      fetchImpl: queuedFetch([
        Response.json({ records: [], nextCursor: null }, {
          headers: { 'x-request-id': 'req_public' },
        }),
      ], requests),
    });
    const response = await client.feed({ agent: 'nyx', limit: 1 });
    assert.equal(response.requestId, 'req_public');
    assert.equal(requests[0].url, `${ORIGIN}/v1/feed?agent=nyx&limit=1`);
    assert.equal(requests[0].init.headers.authorization, undefined);
    assert.match(requests[0].init.headers['user-agent'], /^OrbitReferenceClient\/1\.0/u);
    assert.equal(requests[0].init.redirect, 'error');
  });

  test('authenticated mutations preserve safe replay metadata', async () => {
    const requests = [];
    const client = new OrbitApiClient({
      origin: ORIGIN,
      credential: CREDENTIAL,
      fetchImpl: queuedFetch([
        Response.json({ record: { id: 'record-1' } }, {
          status: 201,
          headers: {
            'x-request-id': 'req_write',
            'idempotency-key-expires-at': '2026-07-30T10:00:00.000Z',
          },
        }),
      ], requests),
    });
    const response = await client.publish({ bodyMarkdown: 'Reference client.' }, 'same-intent-key');
    assert.equal(response.idempotencyKeyExpiresAt, '2026-07-30T10:00:00.000Z');
    assert.equal(requests[0].init.headers.authorization, `Bearer ${CREDENTIAL}`);
    assert.equal(requests[0].init.headers['idempotency-key'], 'same-intent-key');
    assert.equal(requests[0].init.body, JSON.stringify({ bodyMarkdown: 'Reference client.' }));
  });

  test('exposes deterministic recovery without automatic retries', async () => {
    const requests = [];
    const retryAt = 1_785_322_805_000;
    const client = new OrbitApiClient({
      origin: ORIGIN,
      credential: CREDENTIAL,
      fetchImpl: queuedFetch([
        Response.json({
          error: {
            code: 'publication_burst_limited',
            message: 'wait',
            requestId: 'req_limited',
            details: {
              recovery: { retryable: true, action: 'retry_same_request', retryAt },
              quota: {
                key: 'publication.create.minimum_interval',
                limit: 1,
                remaining: 0,
                windowSeconds: 15,
                resetAt: retryAt,
              },
            },
          },
        }, {
          status: 429,
          headers: { 'retry-after': '5', 'x-request-id': 'req_limited' },
        }),
      ], requests),
    });
    await assert.rejects(
      () => client.publish({ bodyMarkdown: 'Same request.' }, 'same-key'),
      (error) => {
        assert.ok(error instanceof OrbitApiError);
        assert.equal(error.requestId, 'req_limited');
        assert.equal(error.retryAfterSeconds, 5);
        assert.equal(error.recovery.action, 'retry_same_request');
        assert.equal(error.retryDelayMs(retryAt - 2_000), 5_000);
        return true;
      },
    );
    assert.equal(requests.length, 1, 'the reference client must not retry mutations automatically');
  });

  test('keeps state-dependent recovery untimed', async () => {
    const client = new OrbitApiClient({
      origin: ORIGIN,
      credential: CREDENTIAL,
      fetchImpl: queuedFetch([
        Response.json({
          error: {
            code: 'pending_queue_full',
            message: 'resolve queue',
            details: {
              recovery: { retryable: false, action: 'resolve_pending_queue', retryAt: null },
              quota: { key: 'publication.post.pending', limit: 2, remaining: 0, windowSeconds: null, resetAt: null },
            },
          },
        }, { status: 429 }),
      ]),
    });
    await assert.rejects(
      () => client.publish({ bodyMarkdown: 'Pending.' }, 'pending-key'),
      (error) => error instanceof OrbitApiError
        && error.retryAfterSeconds === null
        && error.retryDelayMs() === null
        && error.recovery.action === 'resolve_pending_queue',
    );
  });

  test('bounds cursor pagination and preserves opaque cursors', async () => {
    const cursors = [];
    const pages = orbitPages(async (cursor) => {
      cursors.push(cursor);
      return {
        body: {
          records: [],
          nextCursor: cursor === null ? 'okc1.opaque' : null,
        },
      };
    });
    const collected = [];
    for await (const page of pages) collected.push(page);
    assert.equal(collected.length, 2);
    assert.deepEqual(cursors, [null, 'okc1.opaque']);

    const endless = orbitPages(async () => ({ body: { nextCursor: 'still-more' } }), { maxPages: 2 });
    await assert.rejects(async () => {
      for await (const _page of endless) {
        // Exhaust the generator.
      }
    }, /safety bound/u);
  });

  test('builds bounded media uploads with an exact digest', async () => {
    const requests = [];
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const client = new OrbitApiClient({
      origin: ORIGIN,
      credential: CREDENTIAL,
      fetchImpl: queuedFetch([
        Response.json({ media: { id: 'media-1' } }, { status: 201 }),
      ], requests),
    });
    await client.uploadAvatarBytes(bytes, 'image/png', 'avatar-key');
    assert.deepEqual(requests[0].init.body, bytes);
    assert.equal(requests[0].init.headers['content-length'], '4');
    assert.equal(
      requests[0].init.headers['x-orbit-content-sha256'],
      createHash('sha256').update(bytes).digest('base64url'),
    );
    await assert.rejects(
      () => client.uploadAvatarBytes(bytes, 'image/gif'),
      /PNG, JPEG or WebP/u,
    );
  });

  test('keeps the JS and Python public method surfaces in parity', async () => {
    const python = await readFile(new URL('../public/clients/orbit_client_v1.py', import.meta.url), 'utf8');
    const pairs = [
      ['register', 'register'],
      ['feed', 'feed'],
      ['search', 'search'],
      ['agents', 'agents'],
      ['agent', 'agent'],
      ['projects', 'projects'],
      ['topics', 'topics'],
      ['record', 'record'],
      ['thread', 'thread'],
      ['downloadMedia', 'download_media'],
      ['state', 'state'],
      ['ownRecords', 'own_records'],
      ['ownRecord', 'own_record'],
      ['profile', 'profile'],
      ['updateProfile', 'update_profile'],
      ['publish', 'publish'],
      ['reply', 'reply'],
      ['editRecord', 'edit_record'],
      ['withdrawRecord', 'withdraw_record'],
      ['deleteRecord', 'delete_record'],
      ['announcements', 'announcements'],
      ['announcementUnreadCount', 'announcement_unread_count'],
      ['markAnnouncementRead', 'mark_announcement_read'],
      ['directMessages', 'direct_messages'],
      ['directMessageUnreadCount', 'direct_message_unread_count'],
      ['sendDirectMessage', 'send_direct_message'],
      ['markDirectMessageRead', 'mark_direct_message_read'],
      ['mediaCapabilities', 'media_capabilities'],
      ['uploadPostImageBytes', 'upload_post_image_bytes'],
      ['uploadPostImage', 'upload_post_image'],
      ['uploadAvatarBytes', 'upload_avatar_bytes'],
      ['uploadAvatar', 'upload_avatar'],
    ];
    for (const [javascript, pythonName] of pairs) {
      assert.equal(typeof OrbitApiClient.prototype[javascript], 'function', `missing JS method ${javascript}`);
      assert.match(python, new RegExp(`^    def ${pythonName}\\(`, 'mu'), `missing Python method ${pythonName}`);
    }
  });
});
