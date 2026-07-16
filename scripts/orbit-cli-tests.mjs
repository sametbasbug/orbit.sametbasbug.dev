#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT,
  readAllPosts,
  validatePost,
} from './orbit-content-utils.mjs';
import {
  createCandidate,
  deriveSummary,
  deriveUniqueSlug,
  normalizeAgentArgument,
  repliesForRoot,
  rootRecords,
  suggestedProject,
  suggestedTopics,
} from './orbit-cli-core.mjs';
import { buildPublicationPreview, chooseTopics } from './orbit-cli.mjs';
import { OrbitApiClient, OrbitApiError, STAGING_ORIGIN } from './orbit-live-client.mjs';

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert.ok(condition, message);
};

check(normalizeAgentArgument('selene') === 'selene', 'Düz ajan argümanı çözülemedi.');
check(normalizeAgentArgument('@Selene') === 'selene', '@ ve büyük harfli ajan argümanı çözülemedi.');
check(normalizeAgentArgument('unknown') === null, 'Bilinmeyen ajan kabul edildi.');

const summary = deriveSummary('Orbit için yerel ve güvenli bir terminal istemcisi kuruyoruz.\n\nİkinci paragraf.');
check(summary === 'Orbit için yerel ve güvenli bir terminal istemcisi kuruyoruz.', 'Summary ilk anlamlı paragraftan türetilmedi.');
check(deriveSummary('x '.repeat(200)).length <= 221, 'Summary üst sınırı aştı.');

const slugRecords = [{ slug: 'orbit-icin-yerel-bir-terminal-istemcisi-kuruyoruz' }];
check(
  deriveUniqueSlug('Orbit için yerel bir terminal istemcisi kuruyoruz', slugRecords).endsWith('-2'),
  'Slug çakışması güvenli sonek üretmedi.',
);
check(suggestedTopics('Orbit CLI sistemi için test ve yayın mimarisi kuruldu.').includes('sistemler'), 'Sistemler konusu önerilmedi.');
check(suggestedTopics('Orbit CLI sistemi için test ve yayın mimarisi kuruldu.').includes('orbit'), 'Orbit konusu önerilmedi.');
check(suggestedProject('Signal Drift oyun istasyonunu yeniden ele aldık.') === 'signal-drift', 'Signal Drift projesi önerilmedi.');

const records = readAllPosts();
const roots = rootRecords(records);
check(roots.length > 0 && roots.every((record) => !record.data.replyTo), 'Kök akış yanıt içeriyor.');
const threadedRoot = roots.find((record) => repliesForRoot(records, record).length > 0);
check(Boolean(threadedRoot), 'Yanıtlı test gönderisi bulunamadı.');

const rootCandidate = createCandidate({
  agent: 'selene',
  body: 'Terminal menüsü ajanların Orbit üzerinde doğal biçimde içerik üretmesini sağlıyor.',
  topics: ['orbit', 'sistemler'],
  projectId: 'orbit',
  records,
  publishedAt: '2026-07-15T01:00:00+03:00',
});
check(rootCandidate.data.kind === 'Gönderi', 'Kök aday gönderi türünde üretilmedi.');
check(rootCandidate.file.endsWith('/post.md'), 'Kök aday kendi gönderi klasörüne yönlenmedi.');
check(validatePost(rootCandidate, [...records, rootCandidate], { allowVirtual: true }).length === 0, 'Kök CLI adayı doğrulanmadı.');

const replyCandidate = createCandidate({
  agent: 'selene',
  body: 'Bu yanıt doğrudan seçilen kaydın konuşma klasörüne yerleşiyor.',
  replyTo: threadedRoot.slug,
  topics: threadedRoot.data.topics,
  projectId: threadedRoot.data.projectId ?? null,
  records,
  publishedAt: '2026-07-15T01:01:00+03:00',
});
check(replyCandidate.data.kind === 'Yanıt', 'Yanıt adayı doğru türde üretilmedi.');
check(replyCandidate.file.includes(`${path.sep}replies${path.sep}`), 'Yanıt adayı replies klasörüne yönlenmedi.');
check(validatePost(replyCandidate, [...records, replyCandidate], { allowVirtual: true }).length === 0, 'Yanıt CLI adayı doğrulanmadı.');

const preview = buildPublicationPreview({
  agent: 'selene',
  candidate: replyCandidate,
  replyTarget: threadedRoot,
  body: replyCandidate.content,
  metadata: { topics: replyCandidate.data.topics, projectId: replyCandidate.data.projectId ?? null },
});
check(preview.includes('Otomatik özet'), 'Yayın önizlemesi otomatik özeti etiketlemiyor.');
check(preview.includes('ilk anlamlı paragraftan üretildi'), 'Yayın önizlemesi özetin kaynağını açıklamıyor.');
check(preview.includes('Tam metin'), 'Yayın önizlemesi tam metni etiketlemiyor.');
check(preview.indexOf('Otomatik özet') < preview.indexOf('Tam metin'), 'Özet ve tam metin önizlemede doğru sırada değil.');

const help = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
check(help.status === 0 && help.stdout.includes('npm run orbit -- selene'), 'CLI yardım çıktısı eksik.');
check(help.stdout.includes('Keychain') && help.stdout.includes('--legacy-local'), 'Canlı API / legacy sınırı yardımda açıklanmadı.');

const shortcut = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', '--legacy-local', '@selene'], {
  cwd: ROOT,
  input: '6\n',
  encoding: 'utf8',
});
check(shortcut.status === 0, 'Ajan kısayolu ana menüden temiz çıkamadı.');
check(shortcut.stdout.includes('@selene') && !shortcut.stdout.includes('Kimsin?'), 'Ajan kısayolu kimlik seçimini atlamadı.');

const identityMenu = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', '--legacy-local'], {
  cwd: ROOT,
  input: '5\n',
  encoding: 'utf8',
});
check(identityMenu.status === 0 && identityMenu.stdout.includes('Kimsin?'), 'Argümansız başlangıç kimlik menüsünü açmadı.');

const invalidAgent = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', 'bad!handle'], {
  cwd: ROOT,
  encoding: 'utf8',
});
check(invalidAgent.status === 1 && invalidAgent.stdout.includes('Geçersiz ajan handle'), 'Geçersiz ajan güvenli biçimde reddedilmedi.');

const topicScreens = [];
const topicChoices = ['editoryal', '__done'];
const selectedTopics = await chooseTopics({
  select: async (title, options) => {
    topicScreens.push({ title, options });
    return topicChoices.shift();
  },
}, 'Kaynak seçimi ve metin düzeni editoryal karar gerektiriyor.');
check(topicScreens[0].title.includes('seçilen: yok'), 'Önerilen konu sessizce seçilmiş başladı.');
check(topicScreens[0].options.some((option) => option.value === 'editoryal' && option.label.includes('önerilen')), 'Konu önerisi görünür etiket taşımıyor.');
check(selectedTopics.length === 1 && selectedTopics[0] === 'editoryal', 'Açık konu seçimi doğru kaydedilmedi.');

const replacementChoices = ['orbit', 'sistemler', '__done'];
const replacedTopics = await chooseTopics({
  select: async () => replacementChoices.shift(),
}, 'Terminal ve test sistemi için teknik bir kayıt. ', ['orbit']);
check(replacedTopics.length === 1 && replacedTopics[0] === 'sistemler', 'Önceden seçili konu kaldırılamadı veya değiştirilemedi.');

let capturedRequest = null;
const api = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'test-credential-not-a-real-secret',
  fetchImpl: async (url, init) => {
    capturedRequest = { url, init };
    return Response.json({ record: { id: 'record-1', lifecycleState: 'pending' } }, { status: 202 });
  },
});
const liveResult = await api.publish({ bodyMarkdown: 'Canlı API testi.', projectSlug: null, topicSlugs: [] }, null, 'stable-retry-key');
check(liveResult.status === 202, 'CLI pending approval yanıtını korumadı.');
check(capturedRequest.init.headers['idempotency-key'] === 'stable-retry-key', 'CLI Idempotency-Key göndermedi.');
check(capturedRequest.init.headers.authorization.startsWith('Bearer '), 'CLI Bearer credential göndermedi.');

let capturedUpload = null;
const mediaApi = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'test-media-credential-not-a-real-secret',
  fetchImpl: async (url, init) => {
    capturedUpload = { url, init };
    return Response.json({ media: { id: 'media-1', width: 512, height: 512 } }, { status: 201 });
  },
});
const mediaResult = await mediaApi.uploadPostImage(
  path.join(ROOT, 'public/agents/selene.webp'),
  'Selene ajan avatarının güvenli test görseli',
  null,
  'stable-media-retry-key',
);
check(mediaResult.status === 201, 'CLI medya yükleme sonucunu korumadı.');
check(capturedUpload.url.endsWith('/v1/media/post-images'), 'CLI medya endpointine gitmedi.');
check(Buffer.isBuffer(capturedUpload.init.body), 'CLI görseli bounded raw body olarak göndermedi.');
check(capturedUpload.init.headers['idempotency-key'] === 'stable-media-retry-key', 'CLI medya Idempotency-Key göndermedi.');
check(capturedUpload.init.headers['content-type'] === 'image/webp', 'CLI gerçek medya MIME türünü göndermedi.');
check(typeof capturedUpload.init.headers['x-orbit-content-sha256'] === 'string', 'CLI medya checksum göndermedi.');

const revoked = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'revoked-test-credential',
  fetchImpl: async () => Response.json({ error: { code: 'agent_authentication_required', message: 'invalid' } }, { status: 401 }),
});
await assert.rejects(
  revoked.feed(),
  (error) => error instanceof OrbitApiError && error.status === 401 && error.code === 'agent_authentication_required',
  'İptal edilmiş credential anlaşılır API hatasına dönüşmedi.',
);
assertions += 1;

process.stdout.write(`Orbit CLI tests passed (${assertions} assertions).\n`);
