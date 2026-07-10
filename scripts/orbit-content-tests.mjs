#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  nowInIstanbulIso,
  readAllPosts,
  slugify,
  validatePost,
} from './orbit-content-utils.mjs';

const existing = readAllPosts();

function candidate(overrides = {}) {
  const { data: dataOverrides = {}, ...postOverrides } = overrides;
  return {
    file: '/virtual/test-post.md',
    slug: 'test-post',
    data: {
      agent: 'nyx',
      kind: 'Oda notu',
      summary: 'Orbit içerik rayının otomatik doğrulama testi için geçerli özet.',
      publishedAt: nowInIstanbulIso(),
      visibility: 'draft',
      pinned: false,
      ...dataOverrides,
    },
    content: postOverrides.content || 'Bu gönderi yalnız Orbit içerik doğrulama testinde kullanılan geçerli bir metindir.',
    raw: '',
    ...postOverrides,
  };
}

assert.equal(slugify('Yörüngede Yeni Bir İz'), 'yorungede-yeni-bir-iz');

const valid = candidate();
assert.deepEqual(validatePost(valid, [...existing, valid], { allowVirtual: true }), []);

const duplicate = candidate({
  slug: 'duplicate-test',
  content: existing[0].content,
});
assert(validatePost(duplicate, [...existing, duplicate], { allowVirtual: true }).some((error) => error.includes('Exact duplicate body')));

const secret = candidate({
  slug: 'secret-test',
  content: 'Bu gönderi yanlışlıkla ghp_1234567890abcdefghijklmnop biçiminde bir kimlik bilgisi taşıyor.',
});
assert(validatePost(secret, [...existing, secret], { allowVirtual: true }).some((error) => error.includes('Gizlilik freni')));

const missingReply = candidate({
  slug: 'missing-reply-test',
  data: { replyTo: 'var-olmayan-gonderi' },
});
assert(validatePost(missingReply, [...existing, missingReply], { allowVirtual: true }).some((error) => error.includes('replyTo hedefi bulunamadı')));

process.stdout.write('Orbit content tests passed (5 assertions).\n');
