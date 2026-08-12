/* "Orbit ile devam et" onay ekranı.
 *
 * Bu sayfa tarayıcıda görünen ilk ve tek Orbit yüzeyi olabilir: Equinox
 * Rota'dan gelen biri Orbit'i belki hiç görmemiştir. O yüzden metin pazarlama
 * değil, envanter — ne verildiği yazıyor, verilmeyenler de yazıyor. Ama kısa:
 * uzun bir envanter okunmuyor ve okunmayan bir envanter hiç yoktur.
 *
 * Neden kendi içinde tam: hata sayfasındaki gerekçenin aynısı. Site CSS'i bir
 * varlık isteği demek; onay ekranının ikinci bir isteğe bağlı olması, kararın
 * okunamadığı bir an doğurur ve kullanıcı ne verdiğini görmeden onaylar.
 *
 * Dinamik değerler (istemci adı, adres) operatör eliyle giriliyor ama yine
 * kaçırılıyor: "bize güvenilir veri" varsayımı, bir gün o veriyi başka bir
 * yerden alan bir yol yazıldığında sessizce yanlış olur. */

import type { SiteAuthorizationScope } from '../identity/site-authorization-scopes';

/* Kapsam metinleri iki katmanlı.
 *
 * `title` ekranda görünen tek satır; `detail` yalnız "Bunlar ne demek?"
 * açıldığında görünüyor. Sebep: bu ekranı okuyan insanların çoğu okumuyor ve
 * uzun bir metin okunmayı azaltıyor. Kısa liste, gerçekten bakan kişinin
 * saniyeler içinde ne verdiğini görmesini sağlıyor; ayrıntı isteyene duruyor.
 *
 * Ayrıntıyı tümden atmadım: e-postanın geri alınamazlığı gibi şeyler kararın
 * gerçek bedeli ve ekranda hiç bulunmaması, bilerek gizlemek olurdu. Katmanlı
 * olması ikisini birden karşılıyor — kısa metin okunuyor, bedel erişilebilir
 * kalıyor.
 *
 * `title` null ise satır listede hiç görünmüyor: `openid` kullanıcıya bir şey
 * söylemiyor ("bu sitede kim olduğun" zaten girmenin tanımı) ve listede bir
 * satır harcaması, okunacak dört satırı beşe çıkarıp hiçbirinin okunmaması
 * riskini artırıyor. */
interface ScopeText {
  title: string | null;
  detail: string;
}

const SCOPE_TEXTS: Record<SiteAuthorizationScope, ScopeText> = {
  openid: {
    title: null,
    detail: 'Bu siteye özel bir kimlik numarası. Orbit hesabının kendi numarası verilmiyor; başka siteler aynı numarayı görmüyor.',
  },
  profile: {
    title: 'Adın, kullanıcı adın ve profil resmin',
    detail: 'Orbit profilinde herkese açık olan bilgiler.',
  },
  email: {
    /* Parantez içindeki üç sözcük bilerek kısa listede: adresin siteye
     * KOPYALANDIĞI, sonradan geri alınamayan tek sonuç. */
    title: 'E-posta adresin (site kendi kaydına alır)',
    detail: 'Site adresi kendi veritabanına yazar. İzni sonra geri alsan da o kopya sitede kalır; adresini geri çağırmanın bir yolu yok.',
  },
  'orbit.graph.read': {
    title: 'Kimi takip ettiğin',
    detail: 'Takip listen ve takipçi sayıların. Bunlar Orbit’te zaten herkese açık.',
  },
  'orbit.posts.read': {
    title: 'Herkese açık gönderilerin',
    detail: 'Orbit’te giriş yapmamış bir ziyaretçinin de görebildiği kayıtlar.',
  },
};

/* Verilmeyenler tek satıra indi. Dört maddelik liste okunmuyordu; bu cümle
 * okunuyor ve aynı şeyi söylüyor. */
const WITHHELD_LINE = 'Takip akışın, mesajların, taslakların ve hesap ayarların paylaşılmıyor.';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --ink: #16181d; --muted: #5b6270; --paper: #fbfbfc;
  --card: #ffffff; --line: #e3e5ea; --accent: #2f4bd8; --accent-ink: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1af;
  --paper: #14161a; --card: #191c21; --line: #2a2e36; --accent: #7d93ff; --accent-ink: #10131a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
  background: var(--paper); color: var(--ink);
  font: 1rem/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 33rem; background: var(--card);
  border: 1px solid var(--line); border-radius: 0.9rem; padding: 1.75rem; }
h1 { margin: 0 0 0.35rem; font-size: 1.3rem; line-height: 1.35; }
.site { margin: 0 0 1.5rem; color: var(--muted); font-size: 0.9rem; word-break: break-all; }
h2 { margin: 1.35rem 0 0.5rem; font-size: 0.8rem; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); }
ul { margin: 0; padding: 0; list-style: none; }
li { padding: 0.4rem 0 0.4rem 1.3rem; position: relative; }
li::before { content: "✓"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
.withheld { margin: 1rem 0 0; color: var(--muted); font-size: 0.9rem; }
details { margin: 1rem 0 0; font-size: 0.88rem; }
summary { cursor: pointer; color: var(--muted); }
details ul { margin-top: 0.6rem; }
details li { padding: 0.35rem 0 0.35rem 1.3rem; color: var(--muted); }
details li::before { content: "·"; }
details li strong { display: block; color: var(--ink); font-weight: 600; }
.who { margin: 1.35rem 0 0; font-size: 0.9rem; color: var(--muted); }
.who strong { color: var(--ink); }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.35rem; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.25rem; border-radius: 0.55rem;
  border: 1px solid var(--line); cursor: pointer; background: transparent; color: inherit; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.fine { margin: 1.25rem 0 0; font-size: 0.82rem; color: var(--muted); }
`;

/* Siteye GERİ DÖNÜLEMEYEN hatalar.
 *
 * Bir OAuth hatası normalde istemcinin yönlendirme adresine `error=` ile
 * gönderilir. Ama istemci tanınmıyorsa ya da yönlendirme adresi listede
 * yoksa, o adres güvenilir değil: hatayı oraya göndermek, ucu saldırganın
 * seçtiği adrese parametre taşıyan bir araca çevirir. Bu iki durumda kullanıcı
 * Orbit'te kalıyor ve sayfayı biz gösteriyoruz. */
const SITE_ERROR_TEXTS = {
  unknown_client: {
    title: 'Bu site Orbit’e bağlı değil',
    body: 'Geldiğin site Orbit’te kayıtlı bir uygulama olarak tanınmıyor. Bağlantı eski olabilir. Girişi site üzerinden yeniden başlatmayı dene.',
  },
  invalid_redirect_uri: {
    title: 'Geri dönüş adresi tanınmıyor',
    body: 'Site, Orbit’te kayıtlı olmayan bir adrese dönmek istedi. Güvenlik gereği o adrese hiçbir şey göndermedik ve giriş burada durdu.',
  },
  unavailable: {
    title: 'Orbit ile giriş şu anda kapalı',
    body: 'Bu Orbit kurulumunda site girişi yapılandırılmamış. Bir yanlışlık olduğunu düşünüyorsan bize yaz.',
  },
} as const;

export type SiteAuthorizationErrorKind = keyof typeof SITE_ERROR_TEXTS;

export function siteAuthorizationErrorPage(
  kind: SiteAuthorizationErrorKind,
  status: number,
): Response {
  const text = SITE_ERROR_TEXTS[kind];
  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(text.title)} · Equinox Orbit</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(text.title)}</h1>
<p class="site">${escapeHtml(text.body)}</p>
<p class="fine"><a href="/">Orbit ana sayfasına dön</a> · <a href="/iletisim">İletişim</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      /* Hata sayfasında form yok, o yüzden burada `no-referrer` kalabiliyor:
       * Origin sorunu yalnız form gönderen sayfayı ilgilendiriyor. */
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export interface SiteConsentPageInput {
  clientLabel: string;
  clientSiteUrl: string;
  scopes: readonly SiteAuthorizationScope[];
  accountHandle: string;
  ticket: string;
  csrfToken: string;
}

export function siteConsentPage(input: SiteConsentPageInput): Response {
  const label = escapeHtml(input.clientLabel);
  const items = input.scopes
    .map((scope) => ({ scope, text: SCOPE_TEXTS[scope] }))
    .filter((entry) => entry.text.title !== null)
    .map((entry) => `<li>${escapeHtml(entry.text.title as string)}</li>`)
    .join('\n');
  const details = input.scopes
    .map((scope) => SCOPE_TEXTS[scope])
    .map((text) => (text.title === null
      ? `<li>${escapeHtml(text.detail)}</li>`
      : `<li><strong>${escapeHtml(text.title)}</strong>${escapeHtml(text.detail)}</li>`))
    .join('\n');

  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${label} için izin · Equinox Orbit</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<!-- Virgül bir süs değil. Virgülsüz hâlde "Equinox Rota Orbit hesabınla" tek
     bir isim gibi okunuyor ve Orbit de bağlanmak isteyen taraflardan biri
     sanılıyor. Site adı ile Orbit'in arasındaki sınırı bu virgül çiziyor. -->
<h1>${label}, Orbit hesabınla devam etmek istiyor</h1>
<p class="site">${escapeHtml(input.clientSiteUrl)}</p>

<h2>Bu site şunları görecek</h2>
<ul>
${items}
</ul>
<p class="withheld">${escapeHtml(WITHHELD_LINE)}</p>

<details>
<summary>Bunlar ne demek?</summary>
<ul>
${details}
</ul>
</details>

<p class="who">Orbit hesabın: <strong>@${escapeHtml(input.accountHandle)}</strong></p>

<form method="post" action="/v1/oauth/consent">
<input type="hidden" name="ticket" value="${escapeHtml(input.ticket)}" />
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
<div class="actions">
<button type="submit" name="decision" value="allow" class="primary">İzin ver ve devam et</button>
<button type="submit" name="decision" value="deny">Vazgeç</button>
</div>
</form>

<p class="fine">İzni Orbit panelindeki <strong>bağlı siteler</strong> bölümünden
geri alabilirsin; sitedeki oturumu ayrıca kapatman gerekir.</p>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      /* Onay ekranı önbelleğe girmiyor: içinde tek kullanımlık bir bilet ve
       * CSRF değeri var, ve geri tuşuyla dönülüp yeniden gönderilmesi
       * beklenmiyor. */
      'cache-control': 'no-store',
      /* `no-referrer` DEĞİL, ve bu fark staging'de öğrenildi.
       *
       * Referrer politikası `no-referrer` olduğunda tarayıcı, bu sayfadan
       * çıkan form gönderiminin `Origin` başlığını literal `null` yapıyor —
       * yani kendi politikamız, kendi köken kontrolümüzün önünü kesiyordu ve
       * "İzin ver" düğmesi `origin_forbidden` alıyordu.
       *
       * `same-origin` ikisini birden veriyor: aynı kökene giden istekte gerçek
       * Origin gönderiliyor, çapraz kökene çıkarken referrer yine hiç
       * sızmıyor — yani siteye dönerken adresimiz ve içindeki kod başka bir
       * yere taşınmıyor. */
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      /* Sayfada hiç script yok ve olmasına gerek yok; CSP bunu kalıcı kılıyor.
       * `frame-ancestors 'none'`: onay ekranı bir iframe'in içine alınıp
       * kullanıcıya başka bir şey gibi gösterilemez.
       *
       * `form-action` BİLEREK YOK. Üç kez denendi, üç kez kullanıcıyı kesti.
       *
       * Chrome bu direktifi yalnız formun action adresine değil, gönderimden
       * sonra gelen yönlendirme ZİNCİRİNİN TAMAMINA uyguluyor. Bizim zincir
       * şöyle: kendi ucumuz -> Supabase -> site. İlk iki adımı listeye
       * yazdığımızda üçüncüsü kaldı ve tam olarak aynı arıza tekrarladı: izin
       * kaydedildi, kod takas edildi, anahtarlar üretildi, ve tarayıcı siteye
       * hiç varmadı. Ekranda onay sayfası olduğu gibi duruyor; ne hata, ne
       * uyarı. Chrome'un konsol iletisi de yanıltıyor, çünkü suçu zincirin
       * ilk adresine atıyor — izinli olan adrese.
       *
       * İzole bir deneyle ölçüldü: aynı sayfa, aynı CSP, iki kollu. Son adım
       * izinli kökene giderse ulaşıyor, izinsiz kökene giderse engelleniyor.
       * Yani zinciri baştan sona saymak gerekiyor.
       *
       * Zincirin sonrası bize ait değil: siteye döndükten sonra sitenin kendisi
       * bir daha yönlendirebilir (Rota'da `/hesap` -> `/hesap/` böyle bir adım).
       * Kontrol etmediğimiz bir zinciri listeye yazmaya çalışmak, sessizce
       * kırılan bir liste tutmak demek.
       *
       * Karşılığında ne kaybediyoruz: `form-action` sayfanın formunun başka bir
       * yere gönderilmesini engelliyor. Ama bu sayfada script yok (yukarıdaki
       * `default-src 'none'` ve `base-uri 'none'` bunu kalıcı kılıyor) ve form
       * action'ı sunucuda basılıyor — yani onu değiştirebilecek bir yol zaten
       * kapalı. Kapalı bir yola ikinci kilit takmanın bedeli, kullanıcının
       * girişinin sessizce ölmesiydi. */
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
