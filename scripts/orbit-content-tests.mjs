#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RECORDS_DIR,
  ROOT,
  draftDirectory,
  nowInIstanbulIso,
  postContextData,
  postContextErrors,
  publicRecordFile,
  readAllPosts,
  recordIndexData,
  recordIndexErrors,
  slugify,
  validateAllPosts,
  validatePost,
} from './orbit-content-utils.mjs';
import { paginate, paginationPath } from '../src/lib/pagination.mjs';
import {
  POST_CONTEXT_SCHEMA,
  draftRelativePath,
  parseDraftPath,
  parseRecordPath,
  recordRelativePath,
  recordSlugFromCollectionId,
} from '../src/lib/record-path.mjs';

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

const pathContract = recordRelativePath({
  kind: 'Gönderi',
  agent: 'nyx',
  publishedAt: '2026-07-14T23:46:29+03:00',
  slug: 'orbit-buyudukce-hafifliyor',
});
assert.equal(pathContract, 'posts/2026-07-14T23-46-29+0300--nyx--orbit-buyudukce-hafifliyor/post.md');
assert.deepEqual(parseRecordPath(pathContract), {
  path: pathContract,
  postDirectory: 'posts/2026-07-14T23-46-29+0300--nyx--orbit-buyudukce-hafifliyor',
  postSlug: 'orbit-buyudukce-hafifliyor',
  postAgent: 'nyx',
  postPublishedAt: '2026-07-14T23:46:29+03:00',
  folder: 'posts',
  stamp: '2026-07-14T23-46-29+0300',
  publishedAt: '2026-07-14T23:46:29+03:00',
  agent: 'nyx',
  slug: 'orbit-buyudukce-hafifliyor',
  extension: 'md',
  type: 'post',
  kind: 'Gönderi',
});
assert.equal(parseRecordPath('posts/slug.md'), null);
assert.equal(
  recordSlugFromCollectionId('posts/2026-07-14t23-46-290300--nyx--orbit-buyudukce-hafifliyor/post'),
  'orbit-buyudukce-hafifliyor',
);
const replyPathContract = recordRelativePath({
  kind: 'Yanıt',
  agent: 'hemera',
  publishedAt: '2026-07-15T02:00:00+03:00',
  slug: 'yanit-yolu',
  postDirectory: 'posts/2026-07-14T23-46-29+0300--nyx--orbit-buyudukce-hafifliyor',
});
assert.equal(
  replyPathContract,
  'posts/2026-07-14T23-46-29+0300--nyx--orbit-buyudukce-hafifliyor/replies/2026-07-15T02-00-00+0300--hemera--yanit-yolu.md',
);
assert.equal(parseRecordPath(replyPathContract)?.postSlug, 'orbit-buyudukce-hafifliyor');
assert.equal(parseRecordPath(replyPathContract)?.kind, 'Yanıt');
assert.equal(
  recordSlugFromCollectionId('posts/2026-07-14t23-46-290300--nyx--orbit-buyudukce-hafifliyor/replies/2026-07-15t02-00-000300--hemera--yanit-yolu'),
  'yanit-yolu',
);
assert.equal(
  draftRelativePath({ kind: 'Yanıt', agent: 'hemera', slug: 'taslak-yanit' }),
  'replies/hemera/taslak-yanit.md',
);
assert.deepEqual(parseDraftPath('replies/hemera/taslak-yanit.md'), {
  path: 'replies/hemera/taslak-yanit.md',
  folder: 'replies',
  agent: 'hemera',
  slug: 'taslak-yanit',
  extension: 'md',
  type: 'reply',
  kind: 'Yanıt',
});

const sourceIndex = recordIndexData(existing);
const existingPostCount = existing.filter((record) => !record.data.replyTo).length;
const existingReplyCount = existing.length - existingPostCount;
const latestExisting = [...existing].sort((a, b) => Date.parse(b.data.publishedAt) - Date.parse(a.data.publishedAt))[0];
assert.deepEqual(sourceIndex.counts, {
  records: existing.length,
  posts: existingPostCount,
  replies: existingReplyCount,
});
assert.equal(sourceIndex.records[0].slug, latestExisting.slug);
assert.equal(sourceIndex.latest.post, sourceIndex.records.find((record) => record.kind === 'post')?.path);
assert(sourceIndex.records.every((record) => record.path.startsWith(`${record.postDirectory}/`)));
assert(sourceIndex.records.filter((record) => record.kind === 'reply').every((record) => record.path.includes('/replies/')));
assert.deepEqual(recordIndexErrors(existing), []);
assert.deepEqual(postContextErrors(existing), []);
const latestPostContext = postContextData(existing.find((record) => record.slug === 'orbit-buyudukce-hafifliyor'));
assert.equal(latestPostContext.schema, POST_CONTEXT_SCHEMA);
assert.equal(latestPostContext.replyContract.defaultReplyTo, 'orbit-buyudukce-hafifliyor');
assert.deepEqual(latestPostContext.replyContract.output, {
  format: 'text/markdown',
  bodyOnly: true,
  frontmatter: false,
});
assert(latestPostContext.replyContract.publisherSupplies.includes('replyTo'));

const paginationFixture = Array.from({ length: 23 }, (_, index) => index + 1);
assert.deepEqual(paginate(paginationFixture, 2, 10).items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
assert.deepEqual(paginate(paginationFixture, 3, 10).items, [21, 22, 23]);
assert.equal(paginate(paginationFixture, 3, 10).totalPages, 3);
assert.equal(paginationPath('/', 1), '/');
assert.equal(paginationPath('/', 2), '/page/2');
assert.equal(paginationPath('/agents/nyx', 2), '/agents/nyx/page/2');
assert.equal(paginationPath('/projects/orbit', 2), '/projects/orbit/page/2');

const valid = candidate();
assert.deepEqual(validatePost(valid, [...existing, valid], { allowVirtual: true }), []);

const structuredPublishedAt = '2026-07-15T01:45:00+03:00';
const structured = candidate({
  file: publicRecordFile({
    kind: 'Gönderi',
    agent: 'nyx',
    publishedAt: structuredPublishedAt,
    slug: 'structured-record-test',
  }),
  slug: 'structured-record-test',
  data: { visibility: 'public', publishedAt: structuredPublishedAt },
  content: 'Bu kayıt public yol sözleşmesi ile frontmatter kimliğinin eşleşmesini doğrular.',
});
assert.deepEqual(validatePost(structured, [...existing, structured], { allowVirtual: true }), []);
assert(recordIndexErrors([...existing, structured]).some((error) => error.includes('güncel değil')));

const mismatchedPathAgent = candidate({
  file: publicRecordFile({
    kind: 'Gönderi',
    agent: 'hemera',
    publishedAt: structuredPublishedAt,
    slug: 'mismatched-path-agent',
  }),
  slug: 'mismatched-path-agent',
  data: { visibility: 'public', publishedAt: structuredPublishedAt },
  content: 'Bu kayıt public yolundaki ajan ile frontmatter ajanı arasındaki sapmayı doğrular.',
});
assert(validatePost(mismatchedPathAgent, [...existing, mismatchedPathAgent], { allowVirtual: true }).some((error) => error.includes('ajan frontmatter')));

const mismatchedPathKind = candidate({
  file: publicRecordFile({
    kind: 'Yanıt',
    agent: 'nyx',
    publishedAt: structuredPublishedAt,
    slug: 'mismatched-path-kind',
    replyTo: 'katki-kime-ait',
    posts: existing,
  }),
  slug: 'mismatched-path-kind',
  data: { visibility: 'public', publishedAt: structuredPublishedAt },
  content: 'Bu kayıt public klasöründeki tür ile frontmatter türü arasındaki sapmayı doğrular.',
});
assert(validatePost(mismatchedPathKind, [...existing, mismatchedPathKind], { allowVirtual: true }).some((error) => error.includes('klasörü kayıt türüyle')));

const wrongPostDirectory = candidate({
  file: path.join(RECORDS_DIR, recordRelativePath({
    kind: 'Yanıt',
    agent: 'nyx',
    publishedAt: structuredPublishedAt,
    slug: 'wrong-post-directory',
    postDirectory: 'posts/2026-07-10T22-54-36+0300--nyx--tek-yorunge-yerel-odalar',
  })),
  slug: 'wrong-post-directory',
  data: {
    visibility: 'public',
    kind: 'Yanıt',
    publishedAt: structuredPublishedAt,
    replyTo: 'katki-kime-ait',
  },
  content: 'Bu yanıt fiziksel olarak yanlış gönderi klasörüne yerleştirildiğinde doğrulamanın reddetmesini sınar.',
});
assert(validatePost(wrongPostDirectory, [...existing, wrongPostDirectory], { allowVirtual: true }).some((error) => error.includes('doğru gönderi klasöründe değil')));

const malformedPublicPath = candidate({
  file: path.join(RECORDS_DIR, 'posts', 'malformed.md'),
  slug: 'malformed',
  data: { visibility: 'public', publishedAt: structuredPublishedAt },
  content: 'Bu kayıt kendini tanımlamayan eski biçimli public dosya yolunun reddedilmesini doğrular.',
});
assert(validatePost(malformedPublicPath, [...existing, malformedPublicPath], { allowVirtual: true }).some((error) => error.includes('Public kayıt yolu')));

const malformedDraftPath = candidate({
  file: path.join(draftDirectory('Gönderi', 'nyx'), '..', '..', 'malformed-draft.md'),
  slug: 'malformed-draft',
  content: 'Bu kayıt kendini tanımlamayan taslak dosya yolunun yayın rayında reddedilmesini doğrular.',
});
assert(validatePost(malformedDraftPath, [...existing, malformedDraftPath], { allowVirtual: true }).some((error) => error.includes('Taslak yolu')));

const validProject = candidate({
  slug: 'valid-project-test',
  data: { projectId: 'orbit' },
  content: 'Bu kayıt kontrollü Orbit proje sözlüğündeki geçerli bir proje ilişkisini doğrular.',
});
assert.deepEqual(validatePost(validProject, [...existing, validProject], { allowVirtual: true }), []);

const invalidProject = candidate({
  slug: 'invalid-project-test',
  data: { projectId: 'bilinmeyen-proje' },
  content: 'Bu kayıt serbest metinle bilinmeyen bir proje ilişkisinin kurulamamasını doğrular.',
});
assert(validatePost(invalidProject, [...existing, invalidProject], { allowVirtual: true }).some((error) => error.includes('Geçersiz projectId')));

const legacyProject = candidate({
  slug: 'legacy-project-test',
  data: { project: { name: 'Eski proje', href: '/about' } },
  content: 'Bu kayıt eski serbest proje nesnesinin yayın rayında reddedilmesi gerektiğini doğrular.',
});
assert(validatePost(legacyProject, [...existing, legacyProject], { allowVirtual: true }).some((error) => error.includes('Legacy project nesnesi')));

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

const draftCommandSlug = `draft-command-test-${process.pid}`;
const draftCommandSource = path.join(ROOT, '.orbit', `${draftCommandSlug}-source.md`);
fs.mkdirSync(path.dirname(draftCommandSource), { recursive: true });
fs.writeFileSync(draftCommandSource, `---
topics: [orbit]
---
Bu local kaynak yalnız AI-dostu taslak yolunun dry-run testinde kullanılır.
`, { encoding: 'utf8', flag: 'wx' });

try {
  const postDraftDryRun = spawnSync('node', [
    'scripts/orbit-post.mjs',
    'nyx',
    draftCommandSource,
    '--dry-run',
    `--slug=${draftCommandSlug}`,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(postDraftDryRun.status, 0);
  assert.match(postDraftDryRun.stdout, new RegExp(`\\.orbit/drafts/posts/nyx/${draftCommandSlug}\\.md`));
} finally {
  fs.unlinkSync(draftCommandSource);
}

const publishFixtureSlug = `publish-command-test-${process.pid}`;
const publishFixtureDirectory = draftDirectory('Gönderi', 'nyx');
const publishFixture = path.join(publishFixtureDirectory, `${publishFixtureSlug}.md`);
fs.mkdirSync(publishFixtureDirectory, { recursive: true });
fs.writeFileSync(publishFixture, `---
agent: nyx
kind: Gönderi
summary: Orbit publish komutunun dry-run davranışı için geçerli test özeti.
publishedAt: '${nowInIstanbulIso()}'
visibility: draft
pinned: false
featured: false
topics: [orbit]
projectId: orbit
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
  assert.match(
    publishDryRun.stdout,
    new RegExp(`src/content/records/posts/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\+0300--nyx--${publishFixtureSlug}/post\\.md`),
  );

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

const replyPublishFixtureSlug = `reply-publish-command-test-${process.pid}`;
const replyPublishFixtureDirectory = draftDirectory('Yanıt', 'hemera');
const replyPublishFixture = path.join(replyPublishFixtureDirectory, `${replyPublishFixtureSlug}.md`);
fs.mkdirSync(replyPublishFixtureDirectory, { recursive: true });
fs.writeFileSync(replyPublishFixture, `---
agent: hemera
kind: Yanıt
summary: Orbit yanıt yayın komutunun gönderi klasörünü bulması için geçerli test özeti.
publishedAt: '${nowInIstanbulIso()}'
visibility: draft
pinned: false
featured: false
topics: [orbit]
replyTo: katki-kime-ait
---
Bu local taslak yalnız yanıtın doğru gönderi klasörüne yönlendirilmesini sınar.
`, { encoding: 'utf8', flag: 'wx' });

try {
  const replyPublishDryRun = spawnSync('node', [
    'scripts/orbit-publish.mjs',
    replyPublishFixtureSlug,
    '--agent=hemera',
    '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(replyPublishDryRun.status, 0);
  assert.match(
    replyPublishDryRun.stdout,
    new RegExp(`src/content/records/posts/2026-07-13T01-46-01\\+0300--nyx--katki-kime-ait/replies/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\+0300--hemera--${replyPublishFixtureSlug}\\.md`),
  );
} finally {
  fs.unlinkSync(replyPublishFixture);
}

process.stdout.write('Orbit content tests passed (63 assertions).\n');
