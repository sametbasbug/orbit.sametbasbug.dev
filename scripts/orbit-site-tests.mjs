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
/* Duyurular. Statik derlemede içerik YOK ve olmaması doğru: duyurular D1'de
 * yaşıyor. Burada sayfanın iskeletinin, worker'ın dolduracağı yer tutucunun ve
 * ana sayfadaki işaretli aralığın yerinde durduğunu ölçüyoruz — bu üçünden
 * biri kaybolursa canlıda duyuru hiç görünmez ve bunu kimse fark etmez. */
const announcementsPageFile = path.join(DIST_DIR, 'duyurular', 'index.html');
check(fs.existsSync(announcementsPageFile), 'Duyurular sayfası build çıktısında yok.');
if (fs.existsSync(announcementsPageFile)) {
  const announcementsPage = fs.readFileSync(announcementsPageFile, 'utf8');
  check(announcementsPage.includes('yürürlükte olan bir duyuru yok'), 'Statik duyurular sayfası boş hâli göstermiyor.');
  check(
    announcementsPage.includes('geri çekilen bir duyuru bu sayfadan da düşer'),
    'Duyurular sayfası geri çekmenin sayfaya da işlediğini söylemiyor.',
  );
}
const announcementsShellFile = path.join(DIST_DIR, 'orbit-runtime', 'duyurular', 'index.html');
check(fs.existsSync(announcementsShellFile), 'Duyuruların worker kabuğu build çıktısında yok.');
if (fs.existsSync(announcementsShellFile)) {
  check(
    fs.readFileSync(announcementsShellFile, 'utf8').includes('__ORBIT_DYNAMIC_ANNOUNCEMENTS__'),
    'Worker kabuğunda duyuru yer tutucusu yok; canlı sayfa boş kalır.',
  );
}
check(homeHtml.includes('ORBIT_DYNAMIC_ANNOUNCEMENT_STRIP_START'), 'Ana sayfada duyuru şeridi için işaretli aralık yok.');
check(homeHtml.includes('href="/duyurular"'), 'Duyurular sayfasına hiçbir yerden bağlantı yok.');
/* Şerit statik derlemede BOŞ kalmalı. Buraya bir çerçeve sızarsa duyuru
 * olmayan her günde her ziyaretçi boş bir kutu görür. */
check(!homeHtml.includes('announcement-strip'), 'Statik ana sayfada duyuru şeridi çerçevesi basılmış.');

/* Yasal metinler. Bu üç sayfanın diğer sayfalardan farkı, siteye değil
 * KODA dair iddialar taşımaları: "Google'dan yalnız openid, email ve profile isteniyor",
 * "oturum yedi günde düşer", "şu üç çerez var", "yedekler en fazla altı ay".
 * Kod değişip metin yerinde kalırsa ortaya bir üslup hatası değil, yanlış
 * bir aydınlatma metni çıkar — ve yanlış olduğunu kimse fark etmez, çünkü
 * hiçbir şey kırılmaz. Aşağıdaki kilitler her iddiayı kaynağına bağlıyor;
 * biri koptuğunda düzeltilmesi gereken metindir, test değil. */
const legalPages = {
  gizlilik: path.join(DIST_DIR, 'gizlilik', 'index.html'),
  kosullar: path.join(DIST_DIR, 'kosullar', 'index.html'),
  iletisim: path.join(DIST_DIR, 'iletisim', 'index.html'),
};
const legalHtml = {};
for (const [name, file] of Object.entries(legalPages)) {
  check(fs.existsSync(file), `/${name} sayfası build çıktısında yok.`);
  if (!fs.existsSync(file)) continue;
  legalHtml[name] = fs.readFileSync(file, 'utf8');
  check(
    legalHtml[name].includes('iletisim@sametbasbug.dev'),
    `/${name} sayfasında iletişim adresi görünmüyor.`,
  );
}
/* Adres tek kaynaktan gelmeli. Sayfalara elle yazılırsa Orbit'e özel kutu
 * açıldığında biri güncellenir, diğer ikisi eski adresi göstermeye devam
 * eder; yanlış adres, başvuru yapmak isteyen birinin ulaşamaması demektir. */
for (const name of Object.keys(legalPages)) {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'pages', `${name}.astro`), 'utf8');
  check(
    source.includes("from '../data/legal'"),
    `${name}.astro iletişim bilgisini paylaşılan kaynaktan almıyor.`,
  );
  check(
    !source.includes('@sametbasbug.dev'),
    `${name}.astro içine e-posta adresi elle yazılmış; adres değişince bu sayfa geride kalır.`,
  );
}
/* Yasal bağlantılar HER sayfada bulunmalı; footer'da durmalarının sebebi bu.
 * Ana sayfa ve bir derin sayfa birlikte ölçülüyor, çünkü tek sayfada geçen
 * bir kontrol bağlantının layout'ta değil o sayfada olduğunu gizler. */
for (const [label, html] of [['Ana sayfa', homeHtml], ['Hakkında', fs.readFileSync(path.join(DIST_DIR, 'about', 'index.html'), 'utf8')]]) {
  for (const route of ['/gizlilik', '/kosullar', '/iletisim']) {
    check(html.includes(`href="${route}"`), `${label} footer'ında ${route} bağlantısı yok.`);
  }
}
/* Tanıtım sayfası ile Google onay ekranı arasındaki bağ.
 *
 * Bu kilit bir kez ödendi: marka doğrulaması reddedildi, iki gerekçeden biri
 * onay ekranındaki "Equinox Orbit" adının tanıtım sayfasında geçmemesiydi.
 * Sayfa kendini yalnız "Orbit" diye tanıtıyordu ve başlıktaki logo adı iki
 * parça hâlinde bastığı için tek başına karşılamıyordu.
 *
 * İkinci gerekçe sayfanın uygulamanın amacını anlatmamasıydı; onun karşılığı
 * da burada: giriş bölümü ve saydığı kapsamlar sayfada durmak zorunda ve
 * kapsam adları `google.ts` ile aynı olmak zorunda. Kapsam kodda genişler de
 * sayfa eski hâlinde kalırsa, Google'a yanlış beyanda bulunmuş oluruz. */
const aboutHtml = fs.readFileSync(path.join(DIST_DIR, 'about', 'index.html'), 'utf8');
/* Ad, sayfanın KENDİ metninde aranıyor — `<h1>` içinde. Düz bir
 * `includes('Equinox Orbit')` yazmıştım ve geri alma testi onu çürük
 * gösterdi: sayfanın başlığındaki `aria-label="Equinox Orbit ana sayfa"`
 * her sayfada var, yani kontrol adı gövdeden silseniz bile geçiyordu. */
check(
  /<h1[^>]*>\s*Equinox Orbit[^<]*<\/h1>/u.test(aboutHtml),
  'Hakkında sayfasının başlığı uygulamanın tam adını taşımıyor; Google marka doğrulaması bunu bir kez reddetti.',
);
check(
  aboutHtml.includes('Hesap ve giriş'),
  'Hakkında sayfasındaki giriş bölümü kaybolmuş; Google’a verilen tanıtım sayfası uygulamanın ne yaptığını anlatmıyor.',
);
for (const scope of ['openid', 'email', 'profile']) {
  check(
    aboutHtml.includes(`<code>${scope}</code>`),
    `Hakkında sayfası ${scope} iznini saymıyor; sayfa ile onay ekranı ayrışmış olur.`,
  );
}

/* Marka adı düz metinde ayrılabilir olmak zorunda.
 *
 * Başlıktaki ve alt bilgideki logo adı iki parça basıyor: küçük "Equinox" +
 * kalın "Orbit". Aralarında boşluk yokken sayfadan metin çıkaran bir okuyucu
 * için ad "EquinoxOrbit" oluyordu — ve Google'ın marka doğrulaması tam olarak
 * "uygulama adı ana sayfadaki adla eşleşmiyor" diyerek İKİ KEZ reddetti.
 * `<h1>`de adın geçmesi yetmedi, çünkü asıl markanın basıldığı yer logo.
 *
 * Boşluk yalnız DOM'da; `.brand-copy` bir grid olduğu için yalnız boşluktan
 * oluşan metin düğümü ızgara öğesi sayılmaz ve görünüş değişmez. Yani bu
 * kilidi düşüren bir değişiklik göz kararıyla fark edilmez — testin işi bu. */
{
  /* Etiketler boşlukla DEĞİL, boş dizeyle siliniyor — yani `textContent`
   * anlamıyla. Bu satır bir kez yanlış yazıldı: etiket yerine boşluk koyunca
   * `<small>Equinox</small><strong>Orbit</strong>` yine "Equinox Orbit"
   * veriyordu ve kilit, düzeltmeyi geri aldığımda bile yeşil kaldı. Aradığım
   * kusuru maskeleyen bir normalleştirme, testi süs hâline getirir. */
  const asTextContent = (html) =>
    html
      .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ');
  const glued = htmlFiles.filter((file) => asTextContent(fs.readFileSync(file, 'utf8')).includes('EquinoxOrbit'));
  check(
    glued.length === 0,
    `Ürün adı ${glued.length} sayfada bitişik ("EquinoxOrbit") çıkıyor; Google marka doğrulaması bunu adın eşleşmemesi sayıyor. İlki: ${path.relative(DIST_DIR, glued[0] ?? '')}`,
  );
  for (const [label, file] of [['ana sayfa', path.join(DIST_DIR, 'index.html')], ['Hakkında', path.join(DIST_DIR, 'about', 'index.html')]]) {
    check(
      asTextContent(fs.readFileSync(file, 'utf8')).includes('Equinox Orbit'),
      `Google'a bildirilen ${label} düz metninde uygulamanın tam adı geçmiyor.`,
    );
  }
}

/* İnsan avatarı: kart ne yapıyorsa metinler onu söylemek zorunda.
 *
 * Bu kilit bir kez ödendi ve bedeli bir yanlış beyandı: "Hesap ve giriş"
 * bölümüne "profil görseli Orbit'te kamuya görünmez" diye yazdım, oysa görsel
 * her girişte Google'dan tazelenip `accounts.avatar_url`e yazılıyor ve ajan
 * profilindeki kart onu basıyor. Metni koda bakmadan yazmak bir gizlilik
 * sayfasında sıradan bir hata değil.
 *
 * Yön önemli: kod kaynak, metin türev. Kart bir gün görseli basmayı
 * bırakırsa bu kilit düşer ve iki sayfayı da güncellemeye zorlar. */
const agentHtmlSource = fs.readFileSync(path.join(ROOT, 'src', 'server', 'public', 'agent-html.ts'), 'utf8');
const humanCardShowsAvatar = /const avatar = human\.avatarUrl[\s\S]{0,200}?<img/u.test(agentHtmlSource);
const plainText = (html) => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');
if (humanCardShowsAvatar) {
  check(
    plainText(aboutHtml).includes('Google hesabının profil görseli'),
    'Ajan profili insanın Google görselini basıyor ama Hakkında sayfası bunu söylemiyor.',
  );
  check(
    legalHtml.gizlilik && plainText(legalHtml.gizlilik).includes('Profil görseli Google hesabından gelir'),
    'Ajan profili insanın Google görselini basıyor ama Gizlilik Politikası bunu söylemiyor.',
  );
  for (const [label, html] of [['Hakkında', aboutHtml], ['Gizlilik', legalHtml.gizlilik]]) {
    check(
      !html || !/profil görseli[^.]{0,80}görünmez/u.test(plainText(html)),
      `${label} sayfası profil görselinin görünmediğini iddia ediyor; kart onu basıyor.`,
    );
  }
}

if (legalHtml.gizlilik) {
  const googleSource = fs.readFileSync(path.join(ROOT, 'src', 'server', 'identity', 'google.ts'), 'utf8');
  check(
    googleSource.includes("url.searchParams.set('scope', 'openid email profile')"),
    'Google izin kapsamı değişmiş. Gizlilik metni openid, email ve profile sayıyor; kapsam değiştiyse metin artık doğru değil.',
  );
  for (const scope of ['openid', 'email', 'profile']) {
    check(
      legalHtml.gizlilik.includes(`<code>${scope}</code>`),
      `Gizlilik metni ${scope} iznini saymıyor.`,
    );
  }
  /* E-postanın ne için istendiği metinde yazılı olmalı ve orada kalmalı.
   * "Madem adresler elimizde" diye başlayan cümle çok kolay kuruluyor;
   * tanıtım göndermek İYS'ye tabi ayrı bir rıza rejimi ve oraya kazara
   * girilmemeli. Kod tarafındaki karşılığı da göç dosyasında yazılı. */
  check(
    legalHtml.gizlilik.includes('yalnız hizmet bildirimi için kullanılır'),
    'Gizlilik metni e-postanın ne için kullanıldığını söylemiyor.',
  );
  check(
    legalHtml.gizlilik.includes('Tanıtım, pazarlama veya bülten gönderilmez'),
    'Gizlilik metni tanıtım gönderilmeyeceği sözünü taşımıyor.',
  );
  /* Giden posta: metin ne söz veriyorsa kod onu yapmalı. En kırılganı
   * seviye sınırı — kotayı korumak için konmuş bir kural ve gevşetmek
   * bir satırlık iş; metin ise kullanıcıya "bilgi duyurusu postalanmaz"
   * diye söz veriyor. */
  const emailMessages = fs.readFileSync(
    path.join(ROOT, 'src', 'server', 'notifications', 'messages.ts'),
    'utf8',
  );
  check(
    /ANNOUNCEMENT_EMAIL_SEVERITIES[^=]*=\s*\n?\s*\['warning', 'critical'\]/u.test(emailMessages),
    'Postalanabilir duyuru seviyeleri değişmiş; gizlilik metni yalnız uyarı ve kritik diyor.',
  );
  check(
    legalHtml.gizlilik.includes('<strong>uyarı</strong> ve <strong>kritik</strong>'),
    'Gizlilik metni hangi duyuruların postalandığını söylemiyor.',
  );
  check(
    legalHtml.gizlilik.includes('Bilgi seviyesindeki duyurular postalanmaz'),
    'Gizlilik metni bilgi duyurularının postalanmadığı sözünü taşımıyor.',
  );
  /* Kapatılabilirlik iki yönlü bir söz: duyuru kapatılabilir, hesap
   * bildirimi kapatılamaz. İkisi de metinde ve ikisi de kodda. */
  check(
    legalHtml.gizlilik.includes('<strong>kapatılamaz</strong>'),
    'Gizlilik metni hangi bildirimlerin kapatılamadığını söylemiyor.',
  );
  check(
    legalHtml.gizlilik.includes('<strong>tek tıkla kapatabilirsin</strong>'),
    'Gizlilik metni duyuru postalarının kapatılabildiğini söylemiyor.',
  );
  check(
    fs.readFileSync(path.join(ROOT, 'src', 'server', 'repositories', 'notification-repository.ts'), 'utf8')
      .includes('announcement_emails_enabled = 1'),
    'Duyuru tercihi süzgeci kalkmış; gizlilik metni kapatınca gelmeyeceğini söylüyor.',
  );
  /* Resend metinde adıyla ve bölgesiyle sayılı. Sağlayıcı değişirse veya
   * bölge kayarsa, KVKK'da yurt dışına aktarım anlatımı yanlış olur.
   *
   * Aranan şey, dosyanın bir yerinde "api.resend.com" geçmesi değil —
   * postanın gerçekten oraya gönderildiği satır. Adı yorumda kalmış bir
   * sağlayıcı bu kilidi yeşil tutardı. */
  check(
    /fetch\(\s*'https:\/\/api\.resend\.com\/emails'/u.test(
      fs.readFileSync(path.join(ROOT, 'src', 'server', 'notifications', 'email.ts'), 'utf8'),
    ),
    'Posta sağlayıcısı değişmiş; gizlilik metni Resend diyor.',
  );
  check(
    legalHtml.gizlilik.includes('<strong>Resend</strong>')
      && legalHtml.gizlilik.includes('<strong>İrlanda</strong>'),
    'Gizlilik metni posta sağlayıcısını veya bulunduğu ülkeyi saymıyor.',
  );

  /* Giriş izi: hangi alanların toplandığı, neyin toplanmadığı ve süresi.
   * Üçü de metinde yazılı, üçü de kodda ölçülebilir. */
  const signInMigration = fs.readFileSync(
    path.join(ROOT, 'migrations', '0029_sign_in_traces_identify_the_human.sql'),
    'utf8',
  );
  for (const column of ['ip', 'asn', 'asn_organization', 'country']) {
    check(
      new RegExp(`^\\s+${column}\\b`, 'mu').test(signInMigration),
      `Giriş izi tablosunda ${column} alanı yok; gizlilik metni onu sayıyor.`,
    );
  }
  check(
    fs.readFileSync(path.join(ROOT, 'src', 'server', 'identity', 'constants.ts'), 'utf8')
      .includes('SIGN_IN_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000'),
    'Giriş izinin saklama süresi değişmiş; gizlilik metni bir yıl diyor.',
  );
  check(
    legalHtml.gizlilik.includes('<strong>bir yıl</strong>'),
    'Gizlilik metni giriş izinin ne kadar saklandığını söylemiyor.',
  );
  /* Kapsamın darlığı ürünün sözü: ajanın API isteği kaydedilmiyor ve VPN
   * engellenmiyor. İkisi de metinde yazılı olmalı, çünkü ikisi de
   * kullanıcının bilmeye hakkı olduğu sınırlar. */
  check(
    legalHtml.gizlilik.includes('Ajanının API istekleri kaydedilmez'),
    'Gizlilik metni ajanın isteklerinin kaydedilmediğini söylemiyor.',
  );
  check(
    legalHtml.gizlilik.includes('VPN kullanmak <strong>engellenmez</strong>'),
    'Gizlilik metni VPN kullanımının engellenmediğini söylemiyor.',
  );
  check(
    fs.readFileSync(path.join(ROOT, 'src', 'server', 'identity', 'connection.ts'), 'utf8')
      .includes("request.headers.get('cf-connecting-ip')"),
    'Bağlantı izi IP kaynağını değiştirmiş; x-forwarded-for istemcinin uydurabileceği bir başlık.',
  );
  const identityConstants = fs.readFileSync(path.join(ROOT, 'src', 'server', 'identity', 'constants.ts'), 'utf8');
  for (const cookie of ['__Host-orbit_session', '__Host-orbit_csrf', '__Host-orbit_oauth']) {
    check(identityConstants.includes(`'${cookie}'`), `${cookie} çerezi koddan kalkmış; gizlilik metni onu hâlâ sayıyor.`);
    check(legalHtml.gizlilik.includes(cookie), `Gizlilik metni ${cookie} çerezini saymıyor.`);
  }
  check(
    identityConstants.includes('SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000')
      && identityConstants.includes('SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000'),
    'Oturum ömrü değişmiş; gizlilik metni yedi gün ve otuz gün diyor.',
  );
  check(legalHtml.gizlilik.includes('Yedi gün') || legalHtml.gizlilik.includes('yedi gün'), 'Gizlilik metni oturum ömrünü söylemiyor.');
  const backupSource = fs.readFileSync(path.join(ROOT, 'src', 'server', 'backup', 'r2-backup.ts'), 'utf8');
  check(
    backupSource.includes('daily: 14') && backupSource.includes('weekly: 8') && backupSource.includes('monthly: 6'),
    'Yedek saklama süreleri değişmiş; gizlilik metni silinen verinin en fazla altı ay yedekte kaldığını söylüyor.',
  );
  check(
    legalHtml.gizlilik.includes('en fazla altı ay'),
    'Gizlilik metni silinen verinin yedeklerde ne kadar kaldığını söylemiyor.',
  );
  /* Bu iki cümle ürünün en kolay unutulacak dürüstlüğü: mesajlar şifreli
   * değil ve ajanın insanı onları okuyabiliyor. Tasarım kararıydı, metinden
   * sessizce düşerse aydınlatma eksik kalır. */
  check(
    legalHtml.gizlilik.includes('uçtan uca şifreli değildir'),
    'Gizlilik metni mesajların şifreli olmadığını söylemiyor.',
  );
  check(
    legalHtml.gizlilik.includes('panelinden okuyabilir'),
    'Gizlilik metni mesajları ajanın insanının okuyabildiğini söylemiyor.',
  );
}
/* Koşulların taşıması gereken iki çekirdek: yalnız ajanlar yazar ve
 * ajanının yazdığından insanı sorumludur. Bunlar üründen gelen kurallar. */
if (legalHtml.kosullar) {
  check(
    legalHtml.kosullar.includes('yalnız ajanlar tarafından yayımlanır'),
    'Kullanım koşulları sosyal içeriği yalnız ajanların yazdığını söylemiyor.',
  );
  check(
    legalHtml.kosullar.includes('bağlayan insan sorumludur'),
    'Kullanım koşulları ajanın yazdığından sponsorun sorumlu olduğunu söylemiyor.',
  );
}

check(!homeHtml.includes('Farklı zihinler.'), 'Kaldırılan ana sayfa sloganı build çıktısında kaldı.');
check(!homeHtml.includes('>Ajan rehberi<'), 'Ajan rehberi navigasyon bağlantısı build çıktısında kaldı.');
/* Rehberleri servis eden üç yol da başlıklarını tek kaynaktan almalı.
 * `text/markdown` doğru gibi görünen ama belgeyi okunamaz kılan cevaptır:
 * ChatGPT Web'in getiricisi bu türü okumadan geri çeviriyor ve `nosniff`
 * gönderdiğimiz için istemcinin tahmin etme yolu da kapalı. Gerekçe
 * src/shared/machine-guide.ts'de duruyor; buradaki kilit birinin başlığı
 * yerinde "düzeltip" o gerekçeyi görmemesini engelliyor. */
for (const guideRoute of ['src/worker.ts', 'src/pages/skill.md.ts', 'src/pages/mcp.md.ts']) {
  const source = fs.readFileSync(path.join(ROOT, guideRoute), 'utf8');
  check(
    source.includes('MACHINE_GUIDE_HEADERS'),
    `${guideRoute} rehber başlıklarını paylaşılan kaynaktan almıyor.`,
  );
  check(
    !source.includes("'content-type': 'text/markdown"),
    `${guideRoute} rehberi text/markdown olarak servis ediyor; bu tür ajan getiricilerinde okunmuyor.`,
  );
}
check(
  fs.readFileSync(path.join(ROOT, 'src', 'shared', 'machine-guide.ts'), 'utf8')
    .includes("'content-type': 'text/plain; charset=utf-8'"),
  'Ajan rehberleri düz metin olarak servis edilmiyor.',
);

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
  check(dashboardHtml.includes('Google hesabımla devam et'), 'Dashboard sponsor giriş akışını taşımıyor.');
  check(dashboardHtml.includes('Ajanım için kayıt kodu oluştur'), 'Dashboard tek kullanımlık kayıt kodu akışını taşımıyor.');
  check(dashboardHtml.includes('public profilinde “İnsanı” olarak görünür'), 'Dashboard, seçilen adın ajan profilinde görüneceğini açıklamıyor.');
  check(dashboardHtml.includes('/dashboard/platform'), 'Dashboard platform araçları sayfasına bağlanmıyor.');
  /* Metne değil kaba bakıyoruz: "Yayın incelemeleri" ifadesi platform
   * bağlantısının açıklamasında da geçiyor. Taşınan şey kuyruğun kendisi. */
  check(!dashboardHtml.includes('id="approvals"'), 'Dashboard yayın kuyruğunu hâlâ kendi içinde taşıyor.');
  check(!dashboardHtml.includes('id="announcement-form"'), 'Dashboard duyuru formunu hâlâ kendi içinde taşıyor.');
  check(!dashboardHtml.includes('id="backups"'), 'Dashboard yedek listesini hâlâ kendi içinde taşıyor.');
  check(dashboardHtml.includes('Bağlantıyı onayla'), 'Dashboard MCP yetkilendirme ekranını taşımıyor.');
  check(dashboardHtml.includes('id="mcp-agent-select"'), 'Dashboard MCP ajan seçimini taşımıyor.');
  check(dashboardHtml.includes('uzun ömürlü API anahtarı'), 'Dashboard MCP credential güvenlik sınırını açıklamıyor.');
  check(dashboardHtml.includes('Bağlı uygulamalar'), 'Dashboard MCP grant yönetim kartını taşımıyor.');
  check(dashboardHtml.includes('id="mcp-authorizations"'), 'Dashboard MCP grant listesini taşımıyor.');
  check(!dashboardHtml.includes('orb_agent_v1_'), 'Dashboard build çıktısı ajan credential kalıbı içeriyor.');
}
const dashboardScript = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'dashboard.js'), 'utf8');
check(dashboardScript.includes("roles.includes('moderator')"), 'Dashboard moderator rolüne platform bağlantısını göstermiyor.');

/* Platform araçları ayrı sayfada. Moderasyon iddiaları oraya taşındı:
 * aynı cümleleri dashboard'da aramak, taşındıkları için değil hiç var
 * olmadıkları için geçen bir test bırakırdı. */
const platformFile = path.join(DIST_DIR, 'dashboard', 'platform', 'index.html');
check(fs.existsSync(platformFile), 'Platform araçları rotası build çıktısında yok.');
if (fs.existsSync(platformFile)) {
  const platformHtml = fs.readFileSync(platformFile, 'utf8');
  check(platformHtml.includes('Yayın incelemeleri'), 'Platform sayfası moderator yayın kuyruğunu taşımıyor.');
  check(platformHtml.includes('Metin değiştirilemez'), 'Platform sayfası moderatorün içeriği düzenleyemeyeceğini açıklamıyor.');
  check(platformHtml.includes('Sistem duyuruları'), 'Platform sayfası duyuru formunu taşımıyor.');
  check(platformHtml.includes('Yedek durumu'), 'Platform sayfası yedek durumunu taşımıyor.');
  check(platformHtml.includes('id="platform-denied"'), 'Platform sayfası yetkisiz hâli taşımıyor.');
  check(!platformHtml.includes('orb_agent_v1_'), 'Platform build çıktısı ajan credential kalıbı içeriyor.');
  check(
    /<meta name="robots" content="noindex, nofollow, noarchive"/u.test(platformHtml),
    'Platform sayfası noindex değil.',
  );
}
const platformScript = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'dashboard-platform.js'), 'utf8');
check(platformScript.includes("roles.includes('moderator')"), 'Platform sayfası moderator rolünü yayın incelemesine bağlamıyor.');
check(platformScript.includes("loadApprovals()"), 'Platform sayfası yayın kuyruğunu yüklemiyor.');
check(platformScript.includes("review-approve').addEventListener"), 'Platform sayfası yayın onay düğmesini bağlamıyor.');
check(platformScript.includes("review-reject').addEventListener"), 'Platform sayfası yayın ret düğmesini bağlamıyor.');
/* Ham enum sızıntısı: panel bir dönem `daily · succeeded` ve
 * `info · all_agents · active` yazıyordu — Türkçe bir yönetim ekranında
 * veritabanı değerleri. Sözlükler ortak modülde duruyor. */
const dashboardShared = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'dashboard-shared.js'), 'utf8');
for (const [raw, turkish] of [
  ['succeeded', 'Başarılı'],
  ['failed', 'Başarısız'],
  ['daily', 'Günlük'],
  ['all_agents', 'Tüm ajanlar'],
  ['withdrawn', 'Geri çekildi'],
  ['critical', 'Kritik'],
]) {
  check(
    new RegExp(`${raw}:\\s*'${turkish}'`, 'u').test(dashboardShared),
    `Panel ${raw} değerini Türkçeye çevirmiyor.`,
  );
}
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

  check(profileHtml.includes(`data-agent-profile="${agent}"`), `Ajan profil kimliği eksik: ${agent}`);
  check(profileHtml.includes('class="profile-hero"'), `Ajan kimlik sahnesi eksik: ${agent}`);
  check(profileHtml.includes('class="profile-dossier"'), `Ajan dosyası eksik: ${agent}`);
  check(profileHtml.includes(`<h1 id="profile-title">@${agent}</h1>`), `Ajan profili @handle göstermiyor: ${agent}`);
  /* "Diğer ajanlar" gezinmesi kaldırıldı: yalnız statik yolda vardı, worker
   * yolunda hiç yoktu, yani canlıda hiçbir zaman görünmedi. Yerelde durması
   * yerelin canlıyı temsil etmemesi demekti. */
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
/* Bütçe kalıcı sol rayın maliyeti kadar yükseldi: ray her sayfaya 3219 byte
 * ekliyor (ölçüldü, tahmin değil). Bütçenin koruduğu şey bu değil — üstteki
 * iddialar kayıt metinlerinin ve kart gövdelerinin HTML'e gömülmesini
 * engelliyor. Ray sınırlı ve sabit bir kabuk maliyeti; içerik değil.
 *
 * Tavanlar eski değerlerin 3219 üstünde: raysız gövde hâlâ 21_000 ve
 * 19_000'in altında kalmalı. */
check(searchHtml.length < 27_219, `Arama HTML bütçesi aşıldı: ${searchHtml.length} byte.`);
check(savedHtml.length < 25_219, `Kaydedilenler HTML bütçesi aşıldı: ${savedHtml.length} byte.`);

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

/* Askıya alma zinciri: tuşu çizen betik sayfaya bağlı mı, çizdiği yeri
 * worker gerçekten üretiyor mu, ve karar sunucuda mı veriliyor. Üçünden
 * biri koparsa moderatör ya tuşu hiç görmez ya da gördüğü tuş bir şey
 * yapmaz — ikisi de sessiz arızalar. */
const agentModerationScript = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'agent-moderation.js'), 'utf8');
/* Profil markup'ı artık paylaşılan kaynakta; server/public/agent-html.ts
 * yalnız yeniden dışa aktarıyor. Yolu güncellemek yerine eski dosyayı
 * okumaya devam etmek, bu kontrolleri sessizce boşa düşürürdü. */
const agentHtml = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'agent-markup.ts'), 'utf8');
const apiSource = fs.readFileSync(path.join(ROOT, 'src', 'server', 'http', 'api.ts'), 'utf8');
check(
  fs.readFileSync(path.join(ROOT, 'src', 'layouts', 'BaseLayout.astro'), 'utf8')
    .includes('scripts/agent-moderation.js'),
  'Askıya alma betiği sayfaya bağlı değil; moderatör tuşu hiç görmez.',
);
check(
  agentHtml.includes('data-agent-status="${escapeHtml(agent.status)}"')
    && agentHtml.includes('data-agent-suspension'),
  'Ajan profili durum veya askı işaretini basmıyor; tuş bağlanacağı yeri bulamaz.',
);
check(
  agentModerationScript.includes("roles.includes('platform_owner')")
    && agentModerationScript.includes("roles.includes('moderator')"),
  'Askıya alma tuşu sahip ve moderatör dışında birine görünüyor olabilir.',
);
/* Tuşun gizlenmesi bir güvenlik önlemi değil, nezaket. Kararı veren yer
 * uç; oradaki rol kontrolü düşerse tarayıcıdaki kontrol hiçbir şey
 * korumaz. */
check(
  /handleAgentSuspension\([\s\S]{0,400}?requirePublicationReviewer\(auth\)/u.test(apiSource),
  'Askıya alma ucu rol kontrolünü kaybetmiş; yetki yalnız tarayıcıda kalmış olur.',
);

/* Worker'ın bastığı sınıfların stil dosyasında karşılığı olmalı.
 *
 * Bu kilit bir kez ödendi: "İnsanı" kartı GitHub bağlantısıyken `<a
 * class="human-github-card">` idi, Google'a geçerken `<div
 * class="human-card">` oldu ve CSS eski adın altında kaldı. Kart stilsiz
 * bastı — yazılar ve avatar birbirinin üstüne kaydı — ve HİÇBİR test kırıldı.
 * Kırılmaması normaldi: testler ya HTML'e ya CSS'e bakıyordu, ikisinin
 * arasındaki bağa bakan yoktu.
 *
 * Kapsam bilerek dar: yalnız bu kart. Bütün sınıfları taramak, tek bir
 * yardımcı sınıfı silmenin testi kırmasına yol açar ve o gürültü bu kilidin
 * söylediği şeyi boğar. */
const pagesCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'pages.css'), 'utf8');
for (const className of ['human-card', 'human-card-placeholder']) {
  check(
    agentHtml.includes(`class="${className}"`),
    `Ajan profili ${className} sınıfını basmıyor; stil ile markup arasındaki bağ kopmuş.`,
  );
  check(
    pagesCss.includes(`.${className}`),
    `${className} sınıfının stili yok; kart stilsiz basar ve içeriği birbirine girer.`,
  );
}

/* Kayıt kapısı ve posta bütçesi. Bu üç kilit, davet sistemi kalktığında
 * sessizce kaybolabilecek şeylere bakıyor — ve kaybolduklarında hiçbir test
 * kırmadan kaybolurlar, çünkü yokluklarının belirtisi bir hata değil, fazla
 * hesap ve tükenmiş bir posta kotası. */
check(
  /openRegistrationEnabled\(env\)[\s\S]{0,200}?'registration_closed'/u.test(apiSource),
  'Kayıt freni kaybolmuş; bir kötüye kullanım dalgasında kayıtları durduracak bir şey kalmamış.',
);
/* Onay iki yerde birden isteniyor ve ikisi de gerekli: /start'taki kontrol
 * kullanıcıya erken ve anlaşılır bir hata vermek için, dönüşteki ise hesabın
 * onaysız açılamayacağını garanti etmek için. Birincisi nezaket, ikincisi
 * kapı — ve kapının kaybolması hiçbir ekranda görünmez. */
check(
  /body\.acceptedTerms !== true[\s\S]{0,300}?'terms_not_accepted'/u.test(apiSource),
  'Giriş başlangıcı sözleşme onayını istemiyor; kutu işaretlenmeden Google turu başlayabilir.',
);
check(
  /flow\.termsAcceptedAt === null[\s\S]{0,200}?'terms_not_accepted'/u.test(apiSource),
  'Dönüş yolu akıştaki onayı doğrulamıyor; onaysız bir akış hesap açabilir.',
);
/* Onayın sürümü ile sayfada yazan yürürlük tarihi tek kaynaktan geliyor.
 * İki ayrı sabit olsaydı metin güncellenip sürüm unutulduğunda, herkesin
 * eski metni onayladığı kaydedilirdi ve bunu hiçbir şey söylemezdi. */
check(
  apiSource.includes("import { LEGAL_LAST_UPDATED } from '../../data/legal'")
    && fs.readFileSync(path.join(ROOT, 'src', 'pages', 'dashboard.astro'), 'utf8')
      .includes('data-terms-version={LEGAL_LAST_UPDATED}'),
  'Onay sürümü yasal metnin yürürlük tarihinden kopmuş; kaydedilen onay yanlış metni gösterebilir.',
);
/* Kutu giriş kartında ve iki sözleşmeye de bağlantılı olmak zorunda.
 * Okunmadan onaylanan bir metin, onaylanmamış bir metindir. */
check(
  /id="terms-consent"/u.test(fs.readFileSync(path.join(ROOT, 'src', 'pages', 'dashboard.astro'), 'utf8'))
    && /href="\/gizlilik"[\s\S]{0,200}href="\/kosullar"/u.test(
      fs.readFileSync(path.join(ROOT, 'src', 'pages', 'dashboard.astro'), 'utf8'),
    ),
  'Onay kutusu ya kayıp ya da onayladığı metinlere bağlantı vermiyor.',
);
/* İletişim menüde. Footer'da kalması, bize ulaşmak isteyen insanın
 * ulaşamaması demekti — ve kayıt herkese açıkken o insan sayısı artıyor.
 *
 * Liste artık `src/shared/navigation.ts`'te; iddia oraya taşındı. Header'da
 * aramak, menü oradan çıktığı için hep geçen bir test bırakırdı. */
const navigationSource = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'navigation.ts'), 'utf8');
check(
  /href: '\/iletisim'[^\n]*primary: true/u.test(navigationSource),
  'İletişim menüden düşmüş; yalnız footer’da kalan bir bağlantıyı kimse bulmaz.',
);
/* Ray her sayfada. Menünün yalnız ana sayfada durduğu bir dönem vardı ve
 * /agents üzerinde ekranda marka dışında hiçbir gezinme öğesi kalmıyordu. */
for (const [label, html] of [
  ['ana sayfa', homeHtml],
  ['ajan dizini', fs.readFileSync(path.join(DIST_DIR, 'agents', 'index.html'), 'utf8')],
  ['konular', fs.readFileSync(path.join(DIST_DIR, 'topics', 'index.html'), 'utf8')],
  ['hakkında', fs.readFileSync(path.join(DIST_DIR, 'about', 'index.html'), 'utf8')],
  ['ajan profili kabuğu', fs.readFileSync(path.join(DIST_DIR, 'orbit-runtime', 'agent', 'index.html'), 'utf8')],
  ['gönderi kabuğu', fs.readFileSync(path.join(DIST_DIR, 'orbit-runtime', 'post', 'index.html'), 'utf8')],
]) {
  check(html.includes('class="app-rail"'), `${label}: kalıcı sol ray basılmamış.`);
  check(html.includes('aria-label="Orbit menüsü"'), `${label}: ray ana menüyü taşımıyor.`);
}
/* Tavan artık İKİ yerde okunuyor ve ikisi de gerekli: callback'te, kişiyi
 * ad seçtirdikten sonra reddetmemek için; kaydın kendisinde, kapının
 * gerçekten kapalı olması için. Aradan dakikalar geçebiliyor — kayıt tek
 * adımda bitmiyor — ve yalnız ilkine güvenmek, tavana çarpmış bir anda
 * açılan hesap demek. */
check(
  apiSource.includes('await requireRegistrationCapacity(repository, readConnectionTrace(request), now)')
    && /await requireRegistrationCapacity\(repository, trace, now\)[\s\S]{0,2000}await repository\.registerProviderIdentity\(\{/u
      .test(apiSource),
  'Kayıt hız tavanı hesap açılmadan önce çalışmıyor; tavan hesabı geri alamaz.',
);
/* Bir tarayıcıya JSON dönmek, giriş yapmaya çalışan insana süslü parantez
 * göstermek demek. Kapı açıldığında bu yol hız tavanının da çıkışı olacak
 * ve oraya çarpan kişi gerçek bir abone olacak. */
check(
  apiSource.includes('oauthCallbackErrorPage(error.code, error.status)'),
  'OAuth dönüş hatası artık insana bakan bir sayfa üretmiyor.',
);
/* Bütçe kapısı boşaltma turunda. Kalkarsa duyurular kotayı tüketir ve
 * bedelini arkasından gelen güvenlik bildirimi öder. */
check(
  /countAttemptsSince\(now - EMAIL_BUDGET_WINDOW_MS\)/u.test(
    fs.readFileSync(path.join(ROOT, 'src', 'server', 'notifications', 'drain.ts'), 'utf8'),
  ),
  'Posta boşaltma turu günlük bütçeyi okumuyor; kota bir duyuruya harcanabilir.',
);

/* Kapı ile koşullar metni birbirine bağlı. Bugün koşullar "katılım davetle
 * sınırlıdır" diyor ve bu doğru. Kapı açıldığı gün bu cümle yalan olacak —
 * ve yalan olduğunu kimse fark etmeyecek, çünkü bir metnin eskimesi hiçbir
 * testi kırmaz. Bu kilit onu kırıyor: yayındaki yapılandırma ile sayfadaki
 * cümle aynı şeyi söylemek zorunda. */
const liveVars = fs.readFileSync(path.join(ROOT, 'wrangler.production.live.jsonc'), 'utf8');
const openRegistration = /"ORBIT_OPEN_REGISTRATION":\s*"true"/u.test(liveVars);
const terms = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'kosullar.astro'), 'utf8');
check(
  openRegistration === terms.includes('Katılım Google hesabı olan herkese açıktır'),
  openRegistration
    ? 'Kayıt herkese açık ama koşullar bunu söylemiyor.'
    : 'Kayıt durdurulmuş ama koşullar hâlâ herkese açık olduğunu söylüyor.',
);

/* Handle politikası. Buradaki kilitlerin ortak özelliği şu: hepsi
 * kaybolduğunda hiçbir şey hata vermez. Politika sessizce açılır ve bunu
 * ancak kötü bir ad yayına çıktığında fark ederiz. */

/* Politikanın TEK boğazı. Şekil kontrolü ile sahiplenme kontrolü bir kez
 * aynı fonksiyondaydı ve resmî bir ajana DM göndermeyi imkânsız kılıyordu;
 * ayrımın adı bu yüzden `parseAgentHandle` ve `claimAgentHandle`. Biri
 * diğerinin yerine geçerse kural ya çok geniş ya hiç uygulanmamış olur. */
check(
  /function claimAgentHandle\([\s\S]{0,600}?isReservedHandle\(handle\)[\s\S]{0,400}?containsBlockedWord\(handle\)/u.test(apiSource),
  'Handle sahiplenme kapısı rezerve alan ya da kelime kontrolünü kaybetmiş.',
);
check(
  /const recipientHandle = parseAgentHandle\(/u.test(apiSource),
  'DM alıcısı sahiplenme kapısından geçiriliyor; resmî adlı bir ajana mesaj gönderilemez hâle gelir.',
);

/* Karantina üç yerde birden isteniyor: kayıt, MCP katılımı ve yeniden
 * adlandırma. Birinde unutulması, moderasyonun elden aldığı bir adın o
 * yoldan geri dönmesi demek. */
check(
  (apiSource.match(/requireHandleNotQuarantined\(/gu) ?? []).length >= 4,
  'Karantina kontrolü handle sahiplenen yollardan birinde kaybolmuş.',
);

/* Ajan kuralı bilmiyorsa onu ancak hata mesajından öğrenir. Belge ile kod
 * arasındaki bağ burada. */
const onboardingSource = fs.readFileSync(path.join(ROOT, 'src', 'data', 'agentOnboarding.ts'), 'utf8');
for (const promise of ['handle_reserved', 'handle_too_similar', 'handle_quarantined', 'handleRenameRequiredAt']) {
  check(
    onboardingSource.includes(promise),
    `Ajan belgesi ${promise} durumundan söz etmiyor; ajan kuralı ancak reddedilerek öğrenir.`,
  );
}

/* İskelet iki dilde yazılı — uygulamada ve 0037 göçünde. Eşleme tablosunun
 * kendisini birim testi karşılaştırıyor; buradaki kilit dosyanın yerinde
 * durduğuna bakıyor, çünkü göç silinirse o test de sessizce atlanır. */
check(
  fs.existsSync(path.join(ROOT, 'migrations', '0037_handles_get_a_skeleton.sql')),
  'İskelet göçü kayıp; benzer ad koruması için tekil indeks yok.',
);

/* Yanıt sayısı ve yanıt özeti, gönderi ile yanıtı tek bir OR'la birleştiren
 * biçime geri dönerse SQLite indeks kullanamıyor ve records tablosunu dış
 * sorgunun her satırı için baştan sona tarıyor — maliyet kayıt sayısıyla kare
 * artar. Bugün fark edilmez, kayıt biriktiğinde ilk sıkışan yer burasıdır.
 * Kilit bu yüzden biçime bakıyor: sonucu bozmadığı için hiçbir test yakalamaz. */
const publicRepositorySource = fs.readFileSync(
  path.join(ROOT, 'src', 'server', 'repositories', 'd1', 'd1-public-repository.ts'),
  'utf8',
);
for (const [pattern, where] of [
  [/OR\s*\(\s*r\.kind\s*=\s*'reply'/u, 'reply_count alt sorgusu'],
  [/OR\s*\(\s*target\.kind\s*=\s*'reply'/u, 'yanıt özeti JOIN-i'],
]) {
  check(
    !pattern.test(publicRepositorySource),
    `${where} indekssiz OR biçimine dönmüş; records her satır için baştan taranıyor.`,
  );
}
check(
  publicRepositorySource.includes('CASE r.kind')
    && publicRepositorySource.includes('UNION ALL'),
  'Gönderi ve yanıt dalları ayrı durmuyor; her dal kendi indeksine inemez.',
);

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.stderr.write(`Orbit site integrity tests failed (${errors.length}/${assertions}).\n`);
  process.exit(1);
}

process.stdout.write(`Orbit site integrity tests passed (${assertions} assertions).\n`);
