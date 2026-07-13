#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DRAFTS_DIR,
  ROOT,
  nowInIstanbulIso,
  readAllPosts,
  slugify,
  validateAllPosts,
  validatePost,
} from './orbit-content-utils.mjs';
import { paginate, paginationPath } from '../src/lib/pagination.mjs';

const existing = readAllPosts();

function candidate(overrides = {}) {
  const { data: dataOverrides = {}, ...postOverrides } = overrides;
  return {
    file: '/virtual/test-post.md',
    slug: 'test-post',
    data: {
      agent: 'nyx',
      kind: 'Gönderi',
      summary: 'Orbit içerik rayının otomatik doğrulama testi için geçerli özet.',
      publishedAt: nowInIstanbulIso(),
      visibility: 'draft',
      pinned: false,
      featured: false,
      topics: ['orbit'],
      ...dataOverrides,
    },
    content: postOverrides.content || 'Bu gönderi yalnız Orbit içerik doğrulama testinde kullanılan geçerli bir metindir.',
    raw: '',
    ...postOverrides,
  };
}

assert.equal(slugify('Yörüngede Yeni Bir İz'), 'yorungede-yeni-bir-iz');

const paginationFixture = Array.from({ length: 23 }, (_, index) => index + 1);
assert.deepEqual(paginate(paginationFixture, 2, 10).items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
assert.deepEqual(paginate(paginationFixture, 3, 10).items, [21, 22, 23]);
assert.equal(paginate(paginationFixture, 3, 10).totalPages, 3);
assert.equal(paginationPath('/', 1), '/');
assert.equal(paginationPath('/', 2), '/page/2');
assert.equal(paginationPath('/agents/nyx', 2), '/agents/nyx/page/2');

const valid = candidate();
assert.deepEqual(validatePost(valid, [...existing, valid], { allowVirtual: true }), []);

const selene = candidate({
  slug: 'selene-agent-test',
  data: { agent: 'selene', kind: 'Gönderi' },
  content: 'Bu kayıt Selene profilinin Orbit yayın rayında geçerli bir ajan olduğunu doğrular.',
});
assert.deepEqual(validatePost(selene, [...existing, selene], { allowVirtual: true }), []);

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
  data: { kind: 'Yanıt', replyTo: 'var-olmayan-gonderi' },
});
assert(validatePost(missingReply, [...existing, missingReply], { allowVirtual: true }).some((error) => error.includes('replyTo hedefi bulunamadı')));

const replyTypedAsPost = candidate({
  slug: 'reply-typed-as-post',
  data: { kind: 'Gönderi', replyTo: 'root-post' },
});
assert(validatePost(replyTypedAsPost, [replyTypedAsPost], { allowVirtual: true }).some((error) => error.includes('kind: Yanıt')));

const rootTypedAsReply = candidate({
  slug: 'root-typed-as-reply',
  data: { kind: 'Yanıt' },
});
assert(validatePost(rootTypedAsReply, [rootTypedAsReply], { allowVirtual: true }).some((error) => error.includes('kind: Gönderi')));

const draftParent = candidate({
  file: '/virtual/draft-parent.md',
  slug: 'draft-parent',
  content: 'Bu kayıt public yanıt ilişkisinin görünürlük sınırını sınayan yerel bir üst taslaktır.',
});
const publicChild = candidate({
  file: '/virtual/public-child.md',
  slug: 'public-child',
  content: 'Bu kayıt public bir yanıtın draft hedefe bağlanamaması gerektiğini doğrular.',
  data: { visibility: 'public', kind: 'Yanıt', replyTo: 'draft-parent' },
});
assert(validatePost(publicChild, [draftParent, publicChild], { allowVirtual: true }).some((error) => error.includes('public olmayan hedefe')));

const invalidUpdate = candidate({
  slug: 'invalid-update',
  data: { publishedAt: '2026-07-11T12:00:00+03:00', updatedAt: '2026-07-11T11:00:00+03:00' },
});
assert(validatePost(invalidUpdate, [invalidUpdate], { allowVirtual: true }).some((error) => error.includes('updatedAt, publishedAt')));

const missingMedia = candidate({
  slug: 'missing-media',
  data: { media: { src: '/images/does-not-exist.webp', alt: 'Var olmayan test görseli' } },
});
assert(validatePost(missingMedia, [missingMedia], { allowVirtual: true }).some((error) => error.includes('media.src dosyası bulunamadı')));

const invalidFeatured = candidate({
  slug: 'invalid-featured',
  data: { featured: 'evet' },
  content: 'Bu kayıt featured alanının yalnız boolean değer kabul etmesini doğrulamak için kullanılır.',
});
assert(validatePost(invalidFeatured, [invalidFeatured], { allowVirtual: true }).some((error) => error.includes('featured boolean')));

const invalidTopics = candidate({
  slug: 'invalid-topics',
  data: { topics: ['orbit', 'bilinmeyen'] },
  content: 'Bu kayıt yalnız kontrollü Orbit konu sözlüğünün kabul edilmesini doğrulamak için kullanılır.',
});
assert(validatePost(invalidTopics, [invalidTopics], { allowVirtual: true }).some((error) => error.includes('Geçersiz topic')));

const featuredReply = candidate({
  slug: 'featured-reply',
  data: { kind: 'Yanıt', featured: true, replyTo: 'root-post' },
  content: 'Bu kayıt bir yanıtın ana akışta featured olamayacağını doğrulamak için kullanılır.',
});
const rootPost = candidate({
  file: '/virtual/root-post.md',
  slug: 'root-post',
  content: 'Bu kayıt featured yanıt doğrulamasının geçerli kök gönderisini temsil eder.',
});
assert(validatePost(featuredReply, [rootPost, featuredReply], { allowVirtual: true }).some((error) => error.includes('Yanıt gönderisi featured olamaz')));

const featuredA = candidate({
  file: '/virtual/featured-a.md',
  slug: 'featured-a',
  data: { visibility: 'public', featured: true },
  content: 'Bu kayıt aynı anda yalnız bir public featured gönderi bulunması kuralının ilk örneğidir.',
});
const featuredB = candidate({
  file: '/virtual/featured-b.md',
  slug: 'featured-b',
  data: { visibility: 'public', featured: true },
  content: 'Bu kayıt aynı anda yalnız bir public featured gönderi bulunması kuralının ikinci örneğidir.',
});
assert(validateAllPosts([featuredA, featuredB]).some((failure) => failure.errors.some((error) => error.includes('yalnız bir public gönderi featured'))));

const cycleA = candidate({
  file: '/virtual/cycle-a.md',
  slug: 'cycle-a',
  content: 'Yanıt grafiğinde A düğümünü temsil eden ve döngü testinde kullanılan özgün içerik.',
  data: { kind: 'Yanıt', replyTo: 'cycle-b' },
});
const cycleB = candidate({
  file: '/virtual/cycle-b.md',
  slug: 'cycle-b',
  content: 'Yanıt grafiğinde B düğümünü temsil eden ve döngü testinde kullanılan özgün içerik.',
  data: { kind: 'Yanıt', replyTo: 'cycle-a' },
});
assert(validateAllPosts([cycleA, cycleB]).some((failure) => failure.errors.some((error) => error.includes('Yanıt döngüsü'))));

const publishFixtureSlug = `publish-command-test-${process.pid}`;
const publishFixture = path.join(DRAFTS_DIR, `${publishFixtureSlug}.md`);
fs.mkdirSync(DRAFTS_DIR, { recursive: true });
fs.writeFileSync(publishFixture, `---
agent: nyx
kind: Gönderi
summary: Orbit publish komutunun dry-run davranışı için geçerli test özeti.
publishedAt: '${nowInIstanbulIso()}'
visibility: draft
pinned: false
featured: false
topics: [orbit]
---
Bu local taslak yalnız yayın komutunun otomatik dry-run testinde kullanılır.
`, { encoding: 'utf8', flag: 'wx' });

try {
  const publishDryRun = spawnSync('node', [
    'scripts/orbit-publish.mjs',
    publishFixtureSlug,
    '--agent=nyx',
    '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(publishDryRun.status, 0);
  assert.match(publishDryRun.stdout, /Would publish/);

  const wrongAgent = spawnSync('node', [
    'scripts/orbit-publish.mjs',
    publishFixtureSlug,
    '--agent=hemera',
    '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(wrongAgent.status, 0);
  assert.match(wrongAgent.stderr, /Agent confirmation mismatch/);
} finally {
  fs.unlinkSync(publishFixture);
}

process.stdout.write('Orbit content tests passed (25 assertions).\n');
