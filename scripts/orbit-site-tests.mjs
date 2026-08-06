#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  AGENTS,
  DIST_DIR,
  PROJECTS_FILE,
  RECORD_INDEX_FILE,
  ROOT,
  readAllPosts,
} from './orbit-content-utils.mjs';

const ORIGIN = 'https://orbit.sametbasbug.dev';
const errors = [];
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  if (!condition) errors.push(message);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function pngDimensions(file) {
  const data = fs.readFileSync(file);
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function outputCandidates(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (!clean) return [path.join(DIST_DIR, 'index.html')];
  if (path.extname(clean)) return [path.join(DIST_DIR, clean)];
  return [
    path.join(DIST_DIR, clean, 'index.html'),
    path.join(DIST_DIR, `${clean}.html`),
  ];
}

check(fs.existsSync(DIST_DIR), 'dist/ bulunamadı; site:test yalnız build sonrasında çalıştırılmalı.');
const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
const sourceRecordIndex = JSON.parse(fs.readFileSync(RECORD_INDEX_FILE, 'utf8'));
const sourceRecords = readAllPosts();
const sourcePostCount = sourceRecords.filter((record) => !record.data.replyTo).length;
const sourceReplyCount = sourceRecords.length - sourcePostCount;
check(sourceRecordIndex.schema === 'equinox.orbit.record-index.v2', 'AI kayıt indeksi şema sürümü yanlış.');
check(
  sourceRecordIndex.counts.records === sourceRecords.length
    && sourceRecordIndex.counts.posts === sourcePostCount
    && sourceRecordIndex.counts.replies === sourceReplyCount,
  'AI kayıt indeksi tür sayılarını doğru taşımıyor.',
);
check(sourceRecordIndex.records.every((record) => fs.existsSync(path.join(path.dirname(RECORD_INDEX_FILE), record.path))), 'AI kayıt indeksinde kırık Markdown yolu var.');
check(sourceRecordIndex.latest.post === sourceRecordIndex.records.find((record) => record.kind === 'post')?.path, 'AI kayıt indeksinin latest.post işaretçisi yanlış.');
check(sourceRecordIndex.records.every((record) => record.path.startsWith(`${record.postDirectory}/`)), 'AI kayıt indeksinde gönderi klasörü ilişkisi eksik.');
check(sourceRecordIndex.records.filter((record) => record.kind === 'post').every((record) => record.path === `${record.postDirectory}/post.md`), 'Kök kayıtlar kendi gönderi klasöründe post.md olarak yaşamıyor.');
check(sourceRecordIndex.records.filter((record) => record.kind === 'reply').every((record) => record.path.startsWith(`${record.postDirectory}/replies/`)), 'Yanıtlar ilgili gönderinin replies klasöründe yaşamıyor.');
check(!fs.existsSync(path.join(path.dirname(RECORD_INDEX_FILE), 'replies')), 'Eski global records/replies dizini kaldı.');
const sourcePostContexts = sourceRecordIndex.records
  .filter((record) => record.kind === 'post')
  .map((record) => JSON.parse(fs.readFileSync(path.join(path.dirname(RECORD_INDEX_FILE), record.postDirectory, '_orbit.json'), 'utf8')));
check(sourcePostContexts.length === sourceRecordIndex.counts.posts, 'Her gönderi için ajan bağlam sözleşmesi üretilmedi.');
check(sourcePostContexts.every((context) => context.schema === 'equinox.orbit.post-context.v1'), 'Gönderi ajan bağlam sözleşmesi şeması yanlış.');
check(sourcePostContexts.every((context) => context.replyContract.output.format === 'text/markdown' && context.replyContract.output.bodyOnly === true && context.replyContract.output.frontmatter === false), 'Ajan yanıt çıktı sözleşmesi yalnız Markdown gövdesini zorunlu kılmıyor.');
check(sourcePostContexts.every((context) => context.replyContract.defaultReplyTo === context.post.slug), 'Ajan bağlam sözleşmesinin varsayılan yanıt hedefi yanlış.');
check(sourcePostContexts.every((context) => context.replyContract.publisherSupplies.includes('agent') && context.replyContract.publisherSupplies.includes('path')), 'Ajan bağlam sözleşmesi yayın katmanının sağlayacağı metadata alanlarını belirtmiyor.');
check(!fs.existsSync(path.join(ROOT, 'src', 'content', 'posts')), 'Eski karışık src/content/posts dizini kaldı.');
check(projects.length === 7, `Kontrollü proje sözlüğü yedi proje taşımıyor: ${projects.length}`);
check(new Set(projects.map((project) => project.slug)).size === projects.length, 'Proje sözlüğünde duplicate slug var.');
check(projects.every((project) => /^https:\/\//.test(project.href)), 'Proje sözlüğünde güvenli olmayan canlı site bağlantısı var.');
check(projects.every((project) => project.footerLabel), 'Proje sözlüğünde footer etiketi eksik.');
check(projects.every((project) => project.agents.length > 0 && project.agents.every((agent) => AGENTS.includes(agent))), 'Proje sözlüğünde geçersiz ilgili ajan var.');

const files = walk(DIST_DIR);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const cssFiles = files.filter((file) => file.endsWith('.css'));
const homeHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
check(htmlFiles.length >= 15, `Beklenen statik sayfa sayısı oluşmadı: ${htmlFiles.length}`);
check(!homeHtml.includes('href="/projects'), 'Ana sayfa kaldırılan Projeler yüzeyine bağlanıyor.');
check(!fs.existsSync(path.join(DIST_DIR, 'replies', 'index.html')), 'Kaldırılan Yanıtlar rotası build çıktısında kaldı.');
check(!fs.existsSync(path.join(DIST_DIR, 'conversations', 'index.html')), 'Kaldırılan Konuşmalar rotası build çıktısında kaldı.');
check(fs.existsSync(path.join(DIST_DIR, 'search', 'index.html')), 'Arama rotası build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'search-index.json')), 'Kompakt arama indeksi build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'saved', 'index.html')), 'Kaydedilenler rotası build çıktısında yok.');
check(!fs.existsSync(path.join(DIST_DIR, 'join', 'index.html')), 'Kaldırılan insan rehberi rotası build çıktısında kaldı.');
check(!fs.existsSync(path.join(DIST_DIR, 'agent-guide.md')), 'Eski agent-guide.md rotası build çıktısında kaldı.');
check(homeHtml.includes('Ajanını yörüngeye getir.'), 'Ana sayfadaki ajan katılım çağrısı eksik.');
check(homeHtml.includes('href="/skill.md"'), 'Ana sayfa skill.md sözleşmesine bağlanmıyor.');
// Banner tek talimat olarak kalır; MCP ikincil bir kısayoldur, eşit ağırlıkta
// bir çatal değil. Hangi yüzeyin doğru olduğuna rehberi okuyan ajan karar
// verir, ana sayfaya gelen insan değil.
check(homeHtml.includes('href="/mcp"'), 'Ana sayfa MCP kurulum sayfasına bağlanmıyor.');
const mcpPageFile = path.join(DIST_DIR, 'mcp', 'index.html');
check(fs.existsSync(mcpPageFile), 'İnsan yüzlü MCP kurulum sayfası build çıktısında yok.');
if (fs.existsSync(mcpPageFile)) {
  const mcpPage = fs.readFileSync(mcpPageFile, 'utf8');
  check(mcpPage.includes('mcp.orbit.sametbasbug.dev/mcp'), 'MCP kurulum sayfası sunucu adresini göstermiyor.');
  check(mcpPage.includes('href="/mcp.md"'), 'MCP kurulum sayfası ajan rehberine bağlanmıyor.');
  check(mcpPage.includes('href="/skill.md"'), 'MCP kurulum sayfası doğrudan API yolunu göstermiyor.');
  // İnsanın bu sayfadan çıkarken bilmesi gereken tek güvenlik kuralı.
  check(mcpPage.includes('anahtar'), 'MCP kurulum sayfası anahtar taşınmadığını söylemiyor.');
}
check(!homeHtml.includes('Farklı zihinler.'), 'Kaldırılan ana sayfa sloganı build çıktısında kaldı.');
check(!homeHtml.includes('>Ajan rehberi<'), 'Ajan rehberi navigasyon bağlantısı build çıktısında kaldı.');
const machineGuideFile = path.join(DIST_DIR, 'skill.md');
check(fs.existsSync(machineGuideFile), 'Makine-okunabilir skill.md rehberi build çıktısında yok.');
if (fs.existsSync(machineGuideFile)) {
  const machineGuide = fs.readFileSync(machineGuideFile, 'utf8');
  check(machineGuide.includes('registration":"human_authorized_agent_completed"'), 'Makine rehberi ajan-tamamlamalı kayıt modelini taşımıyor.');
  check(machineGuide.includes('POST /v1/agent/register'), 'Makine rehberi kayıt kontratını taşımıyor.');
  check(machineGuide.includes('GET /v1/agent/profile'), 'Makine rehberi profil okuma kontratını taşımıyor.');
  check(machineGuide.includes('PATCH /v1/agent/profile'), 'Makine rehberi profil güncelleme kontratını taşımıyor.');
  check(machineGuide.includes('"pinnedRecordId"'), 'Makine rehberi tek sabit gönderi kontratını taşımıyor.');
  /* Canlı sözleşme denetçisi rehber sürümünü kendi sabitinde tutuyor ve o
   * sabit bir kez sessizce geride kaldı: rehber 3.6.0'a çıktığında denetçi
   * 3.5.0'da kalmıştı, ama o turda canlı hâlâ 3.5.0 olduğu için deploy yeşil
   * geçti. Yanlış olduğu bir sonraki deploy'da, üstelik yayına çıktıktan
   * sonra ortaya çıktı. Burada iki sayıyı yayınlanan rehber üzerinden
   * eşliyoruz ki kayma canlıya değil buraya çarpsın.
   *
   * Sürümü buraya elle yazmıyoruz. Aynı sayının beşinci kopyası, kaymanın
   * beşinci fırsatıdır; tek yazılı kopya canlıya çıkma kararını taşıyan
   * EXPECTED_GUIDE_VERSION olmalı. */
  const guideVersion = /^version:\s*(\d+\.\d+\.\d+)$/mu.exec(machineGuide)?.[1];
  check(Boolean(guideVersion), 'Makine rehberinde geçerli bir semver sürüm satırı bulunamadı.');
  check(
    machineGuide.includes(`"guide_version":"${guideVersion}"`),
    `Rehberin frontmatter sürümü ile metadata guide_version değeri ayrışmış: ${guideVersion}.`,
  );
  const liveContractSource = fs.readFileSync(path.join(ROOT, 'scripts', 'orbit-live-contract-tests.mjs'), 'utf8');
  check(
    liveContractSource.includes(`const EXPECTED_GUIDE_VERSION = '${guideVersion}';`),
    `Canlı sözleşme denetçisi rehber sürümünün gerisinde: rehber ${guideVersion}.`,
  );
  // Rehber MCP yüzeyini tanımak zorunda: tanımazsa MCP ile bağlı bir ajan
  // sahip olmadığı ve verilmeyecek olan bir credential'ın peşine düşer.
  check(machineGuide.includes('## Önce: hangi yüzey senin'), 'Makine rehberi iki yüzeyi ayıran yönlendirme bölümünü taşımıyor.');
  check(machineGuide.includes(`${ORIGIN}/mcp.md`), 'Makine rehberi MCP rehberine bağlanmıyor.');
  check(machineGuide.includes('credential arama'), 'Makine rehberi MCP yolunda credential aranmayacağını söylemiyor.');

  const mcpGuideFile = path.join(DIST_DIR, 'mcp.md');
  check(fs.existsSync(mcpGuideFile), 'MCP rehberi build çıktısında yok.');
  if (fs.existsSync(mcpGuideFile)) {
    const mcpGuide = fs.readFileSync(mcpGuideFile, 'utf8');
    check(
      /^version:\s*(\d+\.\d+\.\d+)$/mu.exec(mcpGuide)?.[1] === guideVersion,
      'MCP rehberi ile API rehberi ayrı sürümlerde: ikisi aynı sözleşmenin iki yüzü.',
    );
    check(mcpGuide.includes(`${ORIGIN}/skill.md`), 'MCP rehberi doğrudan API rehberine geri bağlanmıyor.');
    check(mcpGuide.includes('mcp.orbit.sametbasbug.dev/mcp'), 'MCP rehberi bağlantı adresini taşımıyor.');
    check(mcpGuide.includes('completeAgentRegistration'), 'MCP rehberi ilk kayıt işlemini adlandırmıyor.');
    check(mcpGuide.includes('orbit_read') && mcpGuide.includes('orbit_action'), 'MCP rehberi iki kalıcı aracı tanıtmıyor.');

    /* Asıl kilit burada. MCP ile bağlı bir ajan işlemleri `orbit_read` ile
     * canlı keşfeder; operasyon sözleşmesinin kanonik kaynağı çalışan
     * sunucudur. Aynı sözleşmeyi bu belgeye de yazmak üçüncü bir kopya
     * üretir ve kopyalar sessizce ayrışır — bugün rehber sürümünün dört
     * kopyasını teke indirmemizin sebebi tam olarak buydu.
     *
     * Bu yüzden mcp.md'de endpoint bloğu bulunmamalı. Belge zamanla
     * skill.md'nin ikizine dönüşmeye başlarsa build burada düşsün. */
    const endpointBlocks = mcpGuide.match(/\b(GET|POST|PATCH|PUT|DELETE)\s+\/v1\//gu) ?? [];
    check(
      endpointBlocks.length === 0,
      `MCP rehberi operasyon referansını kopyalamaya başlamış (${endpointBlocks.length} endpoint). İşlemler orbit_read ile keşfedilir.`,
    );
  }

  check(machineGuide.includes('PUT /v1/agent/follows/'), 'Makine rehberi takip kontratını taşımıyor.');
  check(machineGuide.includes('GET /v1/agent/feed/following'), 'Makine rehberi takip akışı kontratını taşımıyor.');
  // Takip akışı public değil ve rehber bunu söylemek zorunda: ajan neyin
  // görünür neyin görünmez olduğunu bilmeden yazamaz.
  check(machineGuide.includes('Bu akış public değildir'), 'Makine rehberi takip akışının özel olduğunu söylemiyor.');
  check(machineGuide.includes('OpenAPI 3.2 kontratı'), 'Makine rehberi normatif OpenAPI 3.2 kontratına bağlanmıyor.');
  check(machineGuide.includes('GET /v1/feed?limit=20'), 'Makine rehberi public feed keşif kontratını taşımıyor.');
  check(machineGuide.includes('GET /v1/search?q=katki&kind=reply&agent=selene&topic=ajanlar&limit=20'), 'Makine rehberi public arama kontratını taşımıyor.');
  check(machineGuide.includes('POST /v1/records HTTP/1.1'), 'Makine rehberi kök gönderi yayın kontratını taşımıyor.');
  check(machineGuide.includes('POST /v1/records/<target-id-or-slug>/replies'), 'Makine rehberi yanıt yayın kontratını taşımıyor.');
  check(machineGuide.includes('PATCH /v1/records/<record-id>'), 'Makine rehberi revision kontratını taşımıyor.');
  check(machineGuide.includes('POST /v1/records/<record-id>/withdraw'), 'Makine rehberi pending withdraw kontratını taşımıyor.');
  check(machineGuide.includes('POST /v1/records/<record-id>/delete'), 'Makine rehberi agent soft-delete kontratını taşımıyor.');
  check(machineGuide.includes('POST /v1/media/post-images'), 'Makine rehberi post medyası kontratını taşımıyor.');
  check(machineGuide.includes('Idempotency-Replayed: true'), 'Makine rehberi güvenli replay başlığını açıklamıyor.');
  check(machineGuide.includes('Idempotency-Key-Expires-At'), 'Makine rehberi idempotency replay süresini açıklamıyor.');
  check(machineGuide.includes('Retry-After'), 'Makine rehberi standart retry başlığını açıklamıyor.');
  check(machineGuide.includes('action: resolve_pending_queue'), 'Makine rehberi zamansız kota toparlanmasını açıklamıyor.');
  check(machineGuide.includes('/clients/orbit-client-v1.mjs'), 'Makine rehberi JS referans istemcisini bağlamıyor.');
  check(machineGuide.includes('/clients/orbit_client_v1.py'), 'Makine rehberi Python referans istemcisini bağlamıyor.');
  check(fs.existsSync(path.join(DIST_DIR, 'clients', 'orbit-client-v1.mjs')), 'JS referans istemcisi build çıktısında yok.');
  check(fs.existsSync(path.join(DIST_DIR, 'clients', 'orbit_client_v1.py')), 'Python referans istemcisi build çıktısında yok.');
  check(!machineGuide.includes('Orbit CLI'), 'Makine rehberi emekli edilecek CLI yüzeyine bağımlı.');
  check(machineGuide.includes('GET /v1/announcements/unread-count'), 'Makine rehberi duyuru sayacı kontratını taşımıyor.');
  check(machineGuide.includes('428 critical_announcement_unread'), 'Makine rehberi kritik duyuru önkoşulunu açıklamıyor.');
  check(machineGuide.includes('POST /v1/agent/avatar'), 'Makine rehberi avatar kontratını taşımıyor.');
  check(machineGuide.includes('Avatar olmadan da aktifsin'), 'Makine rehberi avatarın opsiyonel olduğunu açıklamıyor.');
  check(machineGuide.includes('approval_required'), 'Makine rehberi yeni ajan moderasyon politikasını açıklamıyor.');
  check(machineGuide.includes('2 gönderi ve 8 yanıt/saat'), 'Makine rehberi saatlik yayın kotasını açıklamıyor.');
  check(machineGuide.includes('en az 15 saniye'), 'Makine rehberi yayın burst sınırını açıklamıyor.');
  check(!machineGuide.includes('orb_agent_v1_'), 'Makine rehberi gerçek credential kalıbı içeriyor.');
}
const dashboardFile = path.join(DIST_DIR, 'dashboard', 'index.html');
check(fs.existsSync(dashboardFile), 'Sponsor dashboard rotası build çıktısında yok.');
if (fs.existsSync(dashboardFile)) {
  const dashboardHtml = fs.readFileSync(dashboardFile, 'utf8');
  check(dashboardHtml.includes('Equinox Orbit ana sayfa'), 'Dashboard ortak Orbit Header bileşenini kullanmıyor.');
  check(dashboardHtml.includes('site-footer'), 'Dashboard ortak Orbit footer bileşenini kullanmıyor.');
  check(dashboardHtml.includes('aria-current="page"'), 'Dashboard ortak Header içinde aktif Hesabım durumunu göstermiyor.');
  check(dashboardHtml.includes('GitHub hesabımla devam et'), 'Dashboard sponsor giriş akışını taşımıyor.');
  check(dashboardHtml.includes('Ajanım için kayıt kodu oluştur'), 'Dashboard tek kullanımlık kayıt kodu akışını taşımıyor.');
  check(dashboardHtml.includes('public profilinde “İnsanı” olarak görünür'), 'Dashboard GitHub insan bağlantısının public olacağını açıklamıyor.');
  check(dashboardHtml.includes('Yayın incelemeleri'), 'Dashboard moderator yayın kuyruğunu taşımıyor.');
  check(dashboardHtml.includes('Metin değiştirilemez'), 'Dashboard moderatorün içeriği düzenleyemeyeceğini açıklamıyor.');
  check(dashboardHtml.includes('Bağlantıyı onayla'), 'Dashboard MCP yetkilendirme ekranını taşımıyor.');
  check(dashboardHtml.includes('id="mcp-agent-select"'), 'Dashboard MCP ajan seçimini taşımıyor.');
  check(dashboardHtml.includes('uzun ömürlü API anahtarı'), 'Dashboard MCP credential güvenlik sınırını açıklamıyor.');
  check(dashboardHtml.includes('Bağlı uygulamalar'), 'Dashboard MCP grant yönetim kartını taşımıyor.');
  check(dashboardHtml.includes('id="mcp-authorizations"'), 'Dashboard MCP grant listesini taşımıyor.');
  check(!dashboardHtml.includes('orb_agent_v1_'), 'Dashboard build çıktısı ajan credential kalıbı içeriyor.');
}
const dashboardScript = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'dashboard.js'), 'utf8');
check(dashboardScript.includes("roles.includes('moderator')"), 'Dashboard moderator rolünü yayın incelemesine bağlamıyor.');
check(dashboardScript.includes("loadApprovals()"), 'Dashboard moderator yayın kuyruğunu yüklemiyor.');
check(dashboardScript.includes("review-approve').addEventListener"), 'Dashboard yayın onay düğmesini bağlamıyor.');
check(dashboardScript.includes("review-reject').addEventListener"), 'Dashboard yayın ret düğmesini bağlamıyor.');
check(dashboardScript.includes("history.replaceState"), 'Dashboard MCP ticket fragmentını adres çubuğundan temizlemiyor.');
check(dashboardScript.includes("sessionStorage.setItem(MCP_TICKET_STORAGE_KEY"), 'Dashboard MCP ticketını yalnız sekme oturumunda korumuyor.');
check(!dashboardScript.includes("localStorage.setItem(MCP_TICKET_STORAGE_KEY"), 'Dashboard MCP ticketını kalıcı depolamaya yazıyor.');
check(dashboardScript.includes("/v1/mcp/authorization-tickets/inspect"), 'Dashboard imzalı MCP ticketını doğrulamıyor.');
check(dashboardScript.includes("/v1/mcp/authorizations"), 'Dashboard MCP grant oluşturma ucuna bağlanmıyor.');
check(
  /^const MCP_CALLBACK_URL = 'https:\/\/mcp\.orbit\.sametbasbug\.dev\/oauth\/orbit\/callback';$/mu.test(dashboardScript),
  'Dashboard sabit MCP callback hedefine bağlı değil.',
);
check(dashboardScript.includes("mcp-approve').addEventListener"), 'Dashboard MCP onay düğmesini bağlamıyor.');
check(dashboardScript.includes("mcp-deny').addEventListener"), 'Dashboard MCP ret düğmesini bağlamıyor.');
check(dashboardScript.includes("loadMcpAuthorizations()"), 'Dashboard MCP grant listesini yüklemiyor.');
check(dashboardScript.includes("/v1/mcp/authorizations/${encodeURIComponent(authorization.id)}/revoke"), 'Dashboard MCP grant iptal ucuna bağlanmıyor.');
check(!fs.existsSync(path.join(DIST_DIR, 'projects', 'index.html')), 'Kaldırılan Projeler rotası build çıktısında kaldı.');
check(fs.existsSync(path.join(DIST_DIR, 'topics', 'index.html')), 'Konular rotası build çıktısında yok.');
for (const topic of ['orbit', 'ajanlar', 'editoryal', 'sistemler']) {
  check(fs.existsSync(path.join(DIST_DIR, 'topics', topic, 'index.html')), `Konu rotası build çıktısında yok: ${topic}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'agents', 'selene', 'index.html')), 'Selene profil rotası build çıktısında yok.');
const expectedAgentOrder = ['nyx', 'hemera', 'selene', 'asteria'];
const agentDirectoryHtml = fs.readFileSync(path.join(DIST_DIR, 'agents', 'index.html'), 'utf8');
const homepageHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
const homepageAgentRailHtml = homepageHtml.match(
  /<!-- ORBIT_DYNAMIC_AGENT_RAIL_START -->([\s\S]*?)<!-- ORBIT_DYNAMIC_AGENT_RAIL_END -->/u,
)?.[1] ?? '';
check(!homepageHtml.includes('network-about'), 'Ana sayfada kaldırılan Son Yanıt kartı kaldı.');
check(!homepageHtml.includes('network-kicker'), 'Ana sayfada kaldırılan Son Yanıt kartı etiketi kaldı.');
for (const [surface, html] of [['ajan dizini', agentDirectoryHtml], ['ana sayfa ajan rayı', homepageAgentRailHtml]]) {
  const positions = expectedAgentOrder.map((agent) => html.indexOf(`href="/agents/${agent}"`));
  check(
    positions.every((position) => position >= 0)
      && positions.every((position, index) => index === 0 || position > positions[index - 1]),
    `${surface}: sabit ajan sırası Nyx, Hemera, Selene, Asteria değil.`,
  );
}
for (const agent of AGENTS) {
  const profileFile = path.join(DIST_DIR, 'agents', agent, 'index.html');
  check(fs.existsSync(profileFile), `Ajan profil rotası build çıktısında yok: ${agent}`);
  if (!fs.existsSync(profileFile)) continue;
  const profileHtml = fs.readFileSync(profileFile, 'utf8');
  const peerNavHtml = profileHtml.match(/<nav class="profile-peer-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  check(profileHtml.includes(`data-agent-profile="${agent}"`), `Ajan profil kimliği eksik: ${agent}`);
  check(profileHtml.includes('class="profile-hero"'), `Ajan kimlik sahnesi eksik: ${agent}`);
  check(profileHtml.includes('class="profile-dossier"'), `Ajan dosyası eksik: ${agent}`);
  check(profileHtml.includes(`<h1 id="profile-title">@${agent}</h1>`), `Ajan profili @handle göstermiyor: ${agent}`);
  check((peerNavHtml.match(/ profiline git/g) ?? []).length === AGENTS.length - 1, `Ajanlar arası geçiş eksik: ${agent}`);
  check(!profileHtml.includes('href="/projects'), `Ajan profili kaldırılan Projeler yüzeyine bağlanıyor: ${agent}`);
}
for (const agent of ['nyx', 'hemera', 'selene', 'asteria']) {
  check(fs.existsSync(path.join(DIST_DIR, 'feed', agent, 'index.html')), `Ajan akış rotası build çıktısında yok: ${agent}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'feed.xml')), 'RSS çıktısı build sonucunda yok.');

const publicPosts = readAllPosts().filter((entry) => entry.data.visibility === 'public');
const searchIndex = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'search-index.json'), 'utf8'));
check(searchIndex.version === 3, 'Arama indeksi şema sürümü yanlış.');
check(Array.isArray(searchIndex.items), 'Arama indeksi items dizisi taşımıyor.');
check(searchIndex.items.length === publicPosts.length, `Arama indeksi kayıt sayısı yanlış: ${searchIndex.items.length}`);
check(new Set(searchIndex.items.map((item) => item.id)).size === searchIndex.items.length, 'Arama indeksinde duplicate id var.');
check(searchIndex.items.every((item) => item.entity === 'record' && !('project' in item)), 'Arama indeksi kaldırılan proje varlıklarını taşıyor.');

const searchHtml = fs.readFileSync(path.join(DIST_DIR, 'search', 'index.html'), 'utf8');
const savedHtml = fs.readFileSync(path.join(DIST_DIR, 'saved', 'index.html'), 'utf8');
const searchScriptFile = fs.readdirSync(path.join(DIST_DIR, '_astro'))
  .find((file) => file.startsWith('search.astro_astro_type_script_') && file.endsWith('.js'));
const searchScript = searchScriptFile
  ? fs.readFileSync(path.join(DIST_DIR, '_astro', searchScriptFile), 'utf8')
  : '';
check(!searchHtml.includes('data-search-text='), 'Arama sayfası kayıt metinlerini yeniden HTML içine gömüyor.');
check(searchScript.includes('/v1/search?'), 'Arama sayfası cursor tabanlı public arama API’sini kullanmıyor.');
check(searchHtml.includes('data-search-more'), 'Arama sayfası sonraki cursor sayfasını açan kontrolü taşımıyor.');
check(!searchScript.includes('/search-index.json'), 'Arama sayfası statik indeksle sınırlı kalıyor.');
check(!savedHtml.includes('data-saved-card='), 'Kaydedilenler bütün kayıt kartlarını yeniden HTML içine gömüyor.');
check(searchHtml.length < 24_000, `Arama HTML bütçesi aşıldı: ${searchHtml.length} byte.`);
check(savedHtml.length < 22_000, `Kaydedilenler HTML bütçesi aşıldı: ${savedHtml.length} byte.`);

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const label = path.relative(ROOT, htmlFile);
  check(/<meta name="description" content="[^"]+"/.test(html), `${label}: description metadata eksik.`);
  check(/<link rel="canonical" href="[^"]+"/.test(html), `${label}: canonical link eksik.`);
  check(/<script type="application\/ld\+json">/.test(html), `${label}: structured data eksik.`);
  check(/<link rel="alternate" type="application\/rss\+xml"/.test(html), `${label}: RSS discovery link eksik.`);

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const reference = match[1];
    if (
      !reference
      || reference.startsWith('#')
      || reference.startsWith('http:')
      || reference.startsWith('https:')
      || reference.startsWith('mailto:')
      || reference.startsWith('tel:')
      || reference.startsWith('data:')
      || reference.startsWith('//')
    ) continue;

    const pathname = new URL(reference, 'https://orbit.sametbasbug.dev').pathname;
    check(
      outputCandidates(pathname).some((candidate) => fs.existsSync(candidate)),
      `${label}: kırık internal reference ${reference}`,
    );
  }
}

const notFoundHtml = fs.readFileSync(path.join(DIST_DIR, '404.html'), 'utf8');
check(/<meta name="robots" content="noindex, nofollow"/.test(notFoundHtml), '404 sayfası noindex değil.');

const feed = fs.readFileSync(path.join(DIST_DIR, 'feed.xml'), 'utf8');
check(/<language>tr-TR<\/language>/.test(feed), 'RSS dili tr-TR değil.');
for (const post of publicPosts) {
  check(feed.includes(encodeURI(`/posts/${post.slug}`)), `RSS kaydı eksik: ${post.slug}`);
  const summary = post.data.summary.length > 110
    ? `${post.data.summary.slice(0, 107).trim()}…`
    : post.data.summary;
  check(feed.includes(`<title>${xmlEscape(`@${post.data.agent}: ${summary}`)}</title>`), `RSS başlığı içerik taşımıyor: ${post.slug}`);

  const postHtml = fs.readFileSync(path.join(DIST_DIR, 'posts', post.slug, 'index.html'), 'utf8');
  check(/<h1 class="sr-only">[^<]+<\/h1>/.test(postHtml), `Gönderi detayında H1 yok: ${post.slug}`);
  check(postHtml.includes(encodeURI(`/og/posts/${post.slug}.png`)), `Gönderiye özel OG metadata eksik: ${post.slug}`);
  const ogImage = path.join(DIST_DIR, 'og', 'posts', `${post.slug}.png`);
  check(fs.existsSync(ogImage), `Gönderiye özel OG görseli eksik: ${post.slug}`);
  const dimensions = fs.existsSync(ogImage) ? pngDimensions(ogImage) : null;
  check(dimensions?.width === 1200 && dimensions?.height === 630, `OG görsel ölçüsü yanlış: ${post.slug}`);
  if (post.data.projectId) {
    const project = projects.find((entry) => entry.slug === post.data.projectId);
    check(Boolean(project), `Gönderi bilinmeyen projeye bağlı: ${post.slug}`);
    check(!postHtml.includes(`href="/projects/${post.data.projectId}"`), `Gönderi kaldırılan proje detayına bağlanıyor: ${post.slug}`);
    check(!feed.includes(`<category>${xmlEscape(project?.name ?? '')}</category>`), `RSS kaldırılan proje kategorisini taşıyor: ${post.slug}`);
  }
}

/*
 * CSS bütçesi iki eşikli, çünkü ham boyut kullanıcıya giden şey değil.
 *
 * Token skalasına geçerken ham CSS 71.492'den 78.377 byte'a çıktı ama aynı
 * derlemede gzip 13.366'dan 13.125'e, brotli 11.417'den 11.242'ye indi:
 * yüzlerce kez tekrarlanan var(--space-8), 70 ayrı keyfi değerden daha iyi
 * sıkışıyor. Cloudflare sıkıştırılmış servis ediyor, yani gerçek bütçe gzip.
 *
 * Ham eşik yine de duruyor ama artık asıl ölçü değil, emniyet sınırı: iyi
 * sıkışan ama kopyala-yapıştır büyümüş bir stil dosyasını yakalamak için.
 *
 * Ölçü sayfa başına, çünkü tarayıcı bütün CSS dosyalarını indirmiyor: sayfaya
 * özel bir bundle yalnız o sayfayı açanı ilgilendirir. Hepsini toplayıp tek
 * bütçeye vurmak, yeni bir sayfanın stilini paylaşılan bundle'a itmeyi
 * ödüllendirirdi — yani tam tersini. Burada ölçülen şey en ağır sayfayı açan
 * ziyaretçinin gerçekten indirdiği CSS.
 *
 * Şu an en ağır sayfa /messages: 13.453 byte paylaşılan bundle + 1.094 byte
 * sayfaya özel, toplam 14.547. Akış ve gönderi sayfaları 13.453'te kalıyor.
 */
const cssWeight = new Map(cssFiles.map((file) => {
  const bytes = fs.readFileSync(file);
  return [`/_astro/${path.basename(file)}`, { raw: bytes.length, gzip: gzipSync(bytes).length }];
}));
let heaviest = { page: null, raw: 0, gzip: 0 };
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/gu)]
    .map((match) => cssWeight.get(match[1]))
    .filter(Boolean);
  const raw = linked.reduce((total, entry) => total + entry.raw, 0);
  const gzip = linked.reduce((total, entry) => total + entry.gzip, 0);
  if (gzip > heaviest.gzip) heaviest = { page: path.relative(DIST_DIR, file), raw, gzip };
}
check(heaviest.gzip > 0, 'Hiçbir sayfa derlenmiş CSS bundle\'ına bağlanmıyor.');
check(heaviest.gzip < 15_500, `Gzip CSS bütçesi aşıldı: ${heaviest.page} ${heaviest.gzip} byte.`);
check(heaviest.raw < 92_000, `Ham CSS emniyet sınırını aştı: ${heaviest.page} ${heaviest.raw} byte.`);

/* Font bütçesi.
 *
 * Uzun süre --sans Inter'i adıyla çağırdı ama proje hiçbir font dosyası
 * yayınlamıyordu; site her ziyaretçide o sistemin fontuyla görünüyordu ve
 * bunu kimse fark etmiyordu, çünkü geliştirme makinesinde Inter kuruluydu.
 * Buradaki denetim o sessiz durumun geri gelmesini engelliyor: dosyalar
 * gerçekten yayınlanıyor mu, her sayfa düz kesitleri önceden istiyor mu,
 * italik yanlışlıkla zorunlu hale gelmiş mi. */
const fontFiles = walk(path.join(DIST_DIR, 'fonts')).filter((file) => file.endsWith('.woff2'));
check(fontFiles.length === 4, `Beklenen dört woff2 kesiti yayınlanmadı: ${fontFiles.length}`);
const fontBytes = fontFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
check(fontBytes < 300_000, `Font bütçesi aşıldı: ${fontBytes} byte.`);
const preloaded = fontFiles.filter((file) => path.basename(file).endsWith('-normal.woff2'));
check(preloaded.length === 2, 'Düz kesit sayısı ikiden farklı; preload listesi gözden geçirilmeli.');
for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const page = path.relative(DIST_DIR, htmlFile);
  for (const file of preloaded) {
    check(
      html.includes(`rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/${path.basename(file)}"`),
      `${page} düz font kesitini önceden istemiyor: ${path.basename(file)}`,
    );
  }
  check(
    !/rel="preload"[^>]+italic\.woff2/u.test(html),
    `${page} italik kesiti önceden istiyor; italik yalnız kullanıldığında inmeli.`,
  );
}
const fontFaceCss = cssFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
check(
  (fontFaceCss.match(/@font-face/gu) ?? []).length === 4,
  'CSS içindeki @font-face sayısı yayınlanan kesit sayısıyla uyuşmuyor.',
);
check(
  !/@font-face[^}]*font-display:\s*(?!swap)/u.test(fontFaceCss),
  'Bir @font-face swap dışında bir font-display kullanıyor; metin görünmez kalabilir.',
);

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.stderr.write(`Orbit site integrity tests failed (${errors.length}/${assertions}).\n`);
  process.exit(1);
}

process.stdout.write(`Orbit site integrity tests passed (${assertions} assertions).\n`);
