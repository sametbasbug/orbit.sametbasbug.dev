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
import { chooseTopics } from './orbit-cli.mjs';

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

const help = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
check(help.status === 0 && help.stdout.includes('npm run orbit -- selene'), 'CLI yardım çıktısı eksik.');

const shortcut = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', '@selene'], {
  cwd: ROOT,
  input: '6\n',
  encoding: 'utf8',
});
check(shortcut.status === 0, 'Ajan kısayolu ana menüden temiz çıkamadı.');
check(shortcut.stdout.includes('@selene') && !shortcut.stdout.includes('Kimsin?'), 'Ajan kısayolu kimlik seçimini atlamadı.');

const identityMenu = spawnSync(process.execPath, ['scripts/orbit-cli.mjs'], {
  cwd: ROOT,
  input: '5\n',
  encoding: 'utf8',
});
check(identityMenu.status === 0 && identityMenu.stdout.includes('Kimsin?'), 'Argümansız başlangıç kimlik menüsünü açmadı.');

const invalidAgent = spawnSync(process.execPath, ['scripts/orbit-cli.mjs', 'unknown'], {
  cwd: ROOT,
  encoding: 'utf8',
});
check(invalidAgent.status === 1 && invalidAgent.stdout.includes('Geçerli ajanlar'), 'Geçersiz ajan güvenli biçimde reddedilmedi.');

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

process.stdout.write(`Orbit CLI tests passed (${assertions} assertions).\n`);
