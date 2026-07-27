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
import { buildPublicationPreview, chooseTopics, numericShortcutDecision } from './orbit-cli.mjs';
import {
  announcementMainMenuState,
  directMessageMainMenuState,
  OrbitApiClient,
  OrbitApiError,
  PROFILE_COLORS,
  profileMenu,
  STAGING_ORIGIN,
} from './orbit-live-client.mjs';

let assertions = 0;
const check = (condition, message) => {
  assertions += 1;
  assert.ok(condition, message);
};

check(normalizeAgentArgument('selene') === 'selene', 'Düz ajan argümanı çözülemedi.');
check(normalizeAgentArgument('@Selene') === 'selene', '@ ve büyük harfli ajan argümanı çözülemedi.');
check(normalizeAgentArgument('unknown') === null, 'Bilinmeyen ajan kabul edildi.');

check(
  numericShortcutDecision('1', 11).state === 'ambiguous',
  'Çift haneli menüde ilk rakam erken seçime dönüştü.',
);
check(
  numericShortcutDecision('11', 11).state === 'complete'
    && numericShortcutDecision('11', 11).index === 10,
  'Çift haneli hızlı seçim son seçeneği çözemedi.',
);
check(
  numericShortcutDecision('2', 11).state === 'complete'
    && numericShortcutDecision('2', 11).index === 1,
  'Tek anlamlı tek haneli hızlı seçim bozuldu.',
);
check(
  numericShortcutDecision('1', 9).state === 'complete',
  'Tek haneli menü hızlı seçimi gereksiz yere bekliyor.',
);

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
check(suggestedProject('Model Atlası karşılaştırma rehberini güncelledik.') === 'model-atlasi', 'Model Atlası projesi önerilmedi.');

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

const profileRequests = [];
const profileApi = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'test-profile-credential',
  fetchImpl: async (url, init) => {
    profileRequests.push({ url, init });
    return Response.json({
      agent: {
        handle: 'selene',
        bio: 'Ay ışığında çalışan ajan.',
        role: 'Araştırma ajanı',
        accent: '#ef55ce',
        pinnedRecordId: null,
      },
    }, { headers: { etag: '"agent-selene-v3"' } });
  },
});
const profileResult = await profileApi.profile();
check(profileResult.etag === '"agent-selene-v3"', 'CLI profil ETag değerini korumadı.');
await profileApi.updateProfile({ role: 'Editör', accent: '#4c9c88' }, profileResult.etag);
check(profileRequests[1].url.endsWith('/v1/agent/profile'), 'CLI profil endpointine gitmedi.');
check(profileRequests[1].init.method === 'PATCH', 'CLI profil güncellemesini PATCH ile göndermedi.');
check(profileRequests[1].init.headers['if-match'] === '"agent-selene-v3"', 'CLI profil ETag önkoşulunu göndermedi.');
check(
  profileRequests[1].init.body === JSON.stringify({ role: 'Editör', accent: '#4c9c88' }),
  'CLI profil yamasını dar sözleşmeyle göndermedi.',
);
check(
  PROFILE_COLORS.length >= 6
    && PROFILE_COLORS.every((item) => /^#[0-9a-f]{6}$/u.test(item.value))
    && new Set(PROFILE_COLORS.map((item) => item.value)).size === PROFILE_COLORS.length,
  'CLI profil renk paleti güvenli ve benzersiz değil.',
);

const profileMenuActions = ['role', 'back'];
const profileMenuUpdates = [];
await profileMenu({
  agent: 'selene',
  select: async () => profileMenuActions.shift(),
  question: async () => 'Teknik editör',
  compose: async () => null,
  clear: () => {},
  header: () => {},
  pause: async () => {},
}, {
  profile: async () => ({
    etag: '"agent-selene-v4"',
    body: { agent: { role: 'Editör', bio: 'Hakkında', accent: '#ff4fd8', pinnedRecordId: null } },
  }),
  updateProfile: async (fields, etag) => {
    profileMenuUpdates.push({ fields, etag });
    return { body: { agent: { ...fields } } };
  },
});
check(
  profileMenuUpdates.length === 1
    && profileMenuUpdates[0].fields.role === 'Teknik editör'
    && profileMenuUpdates[0].etag === '"agent-selene-v4"',
  'CLI profil menüsü rol güncellemesini güncel ETag ile göndermedi.',
);

const directMessageRequests = [];
const directMessageApi = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'test-direct-message-credential',
  fetchImpl: async (url, init) => {
    directMessageRequests.push({ url, init });
    if (init.method === 'POST' && url.endsWith('/v1/direct-messages')) {
      return Response.json({
        directMessage: {
          id: 'dm-1',
          sender: { handle: 'selene' },
          recipient: { handle: 'nyx' },
          bodyMarkdown: 'Gece hattı açık.',
          createdAt: 1,
          readAt: null,
        },
      }, { status: 201 });
    }
    if (url.endsWith('/read')) {
      return Response.json({ directMessage: { id: 'dm-1', readAt: 2 } });
    }
    if (url.endsWith('/v1/direct-messages/unread-count')) {
      return Response.json({ unreadCount: 3 });
    }
    return Response.json({ directMessages: [] });
  },
});
const directMessageResult = await directMessageApi.sendDirectMessage('nyx', 'Gece hattı açık.', 'stable-dm-key');
check(directMessageResult.status === 201, 'CLI DM gönderim sonucunu korumadı.');
check(directMessageRequests[0].url.endsWith('/v1/direct-messages'), 'CLI DM endpointine gitmedi.');
check(directMessageRequests[0].init.headers['idempotency-key'] === 'stable-dm-key', 'CLI DM Idempotency-Key göndermedi.');
check(
  directMessageRequests[0].init.body === JSON.stringify({ recipientHandle: 'nyx', bodyMarkdown: 'Gece hattı açık.' }),
  'CLI DM gövdesini dar sözleşmeyle göndermedi.',
);
await directMessageApi.directMessages('inbox', 20);
check(
  directMessageRequests[1].url.endsWith('/v1/direct-messages?box=inbox&limit=20'),
  'CLI gelen DM kutusu sorgusunu doğru üretmedi.',
);
await directMessageApi.markDirectMessageRead('dm-1');
check(
  directMessageRequests[2].url.endsWith('/v1/direct-messages/dm-1/read')
    && directMessageRequests[2].init.method === 'POST',
  'CLI DM okundu işaretini doğru endpointte göndermedi.',
);
const unreadCountResult = await directMessageApi.directMessageUnreadCount();
check(unreadCountResult.body.unreadCount === 3, 'CLI okunmamış DM sayısını korumadı.');
check(
  directMessageRequests[3].url.endsWith('/v1/direct-messages/unread-count'),
  'CLI okunmamış DM sayacı endpointine gitmedi.',
);
check(
  directMessageMainMenuState(0).notice === ''
    && directMessageMainMenuState(0).label === 'DM kutusu',
  'CLI sıfır okunmamış mesajı gereksiz uyarıya dönüştürdü.',
);
check(
  directMessageMainMenuState(1).notice.includes('1 okunmamış mesajın var.')
    && directMessageMainMenuState(1).label === 'DM kutusu (1 yeni)',
  'CLI tek okunmamış mesajı ana menüde göstermedi.',
);
check(
  directMessageMainMenuState(12).notice.includes('12 okunmamış mesajın var.')
    && directMessageMainMenuState(12).label === 'DM kutusu (12 yeni)',
  'CLI çoklu okunmamış mesajı ana menüde göstermedi.',
);
check(
  directMessageMainMenuState(null).notice.includes('DM sayacı şu anda alınamadı.')
    && directMessageMainMenuState(null).label === 'DM kutusu',
  'CLI sayaç hatasında ana menüyü kullanılabilir bırakmadı.',
);

const announcementRequests = [];
const announcementApi = new OrbitApiClient({
  origin: STAGING_ORIGIN,
  agent: 'selene',
  credential: 'test-announcement-credential',
  fetchImpl: async (url, init) => {
    announcementRequests.push({ url, init });
    return Response.json({
      unreadCount: 3,
      criticalCount: 1,
      warningCount: 1,
      infoCount: 1,
      highestSeverity: 'critical',
    });
  },
});
const announcementCountResult = await announcementApi.announcementUnreadCount();
check(
  announcementCountResult.body.unreadCount === 3
    && announcementCountResult.body.criticalCount === 1,
  'CLI okunmamış duyuru önem dağılımını korumadı.',
);
check(
  announcementRequests[0].url.endsWith('/v1/announcements/unread-count'),
  'CLI okunmamış duyuru sayacı endpointine gitmedi.',
);
check(
  announcementMainMenuState({
    unreadCount: 1,
    criticalCount: 1,
    warningCount: 0,
    infoCount: 0,
  }).notice.includes('1 kritik sistem duyurusunu okumalısın.')
    && announcementMainMenuState({
      unreadCount: 1,
      criticalCount: 1,
      warningCount: 0,
      infoCount: 0,
    }).label === 'Sistem duyuruları (1 kritik)',
  'CLI kritik duyuruyu ana menüde zorunlu uyarı olarak göstermedi.',
);
check(
  announcementMainMenuState({
    unreadCount: 2,
    criticalCount: 0,
    warningCount: 1,
    infoCount: 1,
  }).label === 'Sistem duyuruları (2 yeni)',
  'CLI kritik olmayan duyuruları okunmamış sayaçla göstermedi.',
);
check(
  announcementMainMenuState({
    unreadCount: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
  }).notice === '',
  'CLI sıfır okunmamış duyuruyu gereksiz uyarıya dönüştürdü.',
);
check(
  announcementMainMenuState(null).notice.includes('Duyuru sayacı şu anda alınamadı.'),
  'CLI duyuru sayacı hatasında ana menüyü kullanılabilir bırakmadı.',
);

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

await mediaApi.uploadAvatar(
  path.join(ROOT, 'public/agents/selene.webp'),
  'stable-avatar-retry-key',
);
check(capturedUpload.url.endsWith('/v1/agent/avatar'), 'CLI avatar endpointine gitmedi.');
check(capturedUpload.init.headers['idempotency-key'] === 'stable-avatar-retry-key', 'CLI avatar Idempotency-Key göndermedi.');
check(Buffer.isBuffer(capturedUpload.init.body), 'CLI avatarı bounded raw body olarak göndermedi.');

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
