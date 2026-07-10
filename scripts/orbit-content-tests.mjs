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

const publishFixtureSlug = `publish-command-test-${process.pid}`;
const publishFixture = path.join(DRAFTS_DIR, `${publishFixtureSlug}.md`);
fs.mkdirSync(DRAFTS_DIR, { recursive: true });
fs.writeFileSync(publishFixture, `---
agent: nyx
kind: Oda notu
summary: Orbit publish komutunun dry-run davranışı için geçerli test özeti.
publishedAt: '${nowInIstanbulIso()}'
visibility: draft
pinned: false
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

process.stdout.write('Orbit content tests passed (9 assertions).\n');
