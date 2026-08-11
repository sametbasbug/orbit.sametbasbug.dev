/* "Orbit ile devam et" onay ekranı.
 *
 * Bu sayfa tarayıcıda görünen ilk ve tek Orbit yüzeyi olabilir: Anime
 * sitesinden gelen biri Orbit'i belki hiç görmemiştir. O yüzden metin
 * pazarlama değil, envanter — ne verildiği tek tek yazıyor ve verilmeyenler
 * de yazıyor.
 *
 * Neden kendi içinde tam: hata sayfasındaki gerekçenin aynısı. Site CSS'i bir
 * varlık isteği demek; onay ekranının ikinci bir isteğe bağlı olması, kararın
 * okunamadığı bir an doğurur ve kullanıcı ne verdiğini görmeden onaylar.
 *
 * Dinamik değerler (istemci adı, adres) operatör eliyle giriliyor ama yine
 * kaçırılıyor: "bize güvenilir veri" varsayımı, bir gün o veriyi başka bir
 * yerden alan bir yol yazıldığında sessizce yanlış olur. */

import type { SiteAuthorizationScope } from '../identity/site-authorization-scopes';

interface ScopeText {
  title: string;
  detail: string;
}

/* Kapsam metinleri. "Kimliğin" gibi soyut sözcük yok: kullanıcı ne verdiğini
 * somut görmeli. */
const SCOPE_TEXTS: Record<SiteAuthorizationScope, ScopeText> = {
  openid: {
    title: 'Bu sitede kim olduğun',
    detail: 'Yalnız bu siteye özel bir kimlik numarası. Orbit hesabının kendi numarası verilmiyor ve başka siteler aynı numarayı görmüyor.',
  },
  profile: {
    title: 'Görünen adın, kullanıcı adın ve profil resmin',
    detail: 'Orbit profilinde herkese açık olan bilgiler.',
  },
  email: {
    title: 'E-posta adresin',
    detail: 'Site bu adresi kendi veritabanına kaydeder. Buradan verdiğin izni sonra geri alsan da o kopya sitede kalır — adresini geri çağırmanın bir yolu yok.',
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

/* Hiçbir kapsamın açmadığı şeyler. Ekranda yazıyor, çünkü bir onay ekranının
 * en çok işe yarayan cümlesi neyin verilmediğini söyleyen cümledir. */
const WITHHELD = [
  'Kimleri okuduğun — yani takip akışın',
  'Mesajların',
  'Taslakların ve yayımlamadığın kayıtların',
  'Hesap ayarların',
];

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
h2 { margin: 1.5rem 0 0.6rem; font-size: 0.8rem; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); }
ul { margin: 0; padding: 0; list-style: none; }
li { padding: 0.7rem 0; border-top: 1px solid var(--line); }
li:first-child { border-top: none; }
li strong { display: block; font-weight: 600; }
li span { color: var(--muted); font-size: 0.88rem; }
.withheld li { padding: 0.3rem 0; border: none; color: var(--muted); font-size: 0.9rem; }
.withheld li::before { content: "—"; margin-right: 0.5rem; }
.who { margin: 1.5rem 0 0; padding: 0.9rem 1rem; border: 1px solid var(--line);
  border-radius: 0.6rem; font-size: 0.9rem; color: var(--muted); }
.who strong { color: var(--ink); }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
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
  accountDisplayName: string;
  ticket: string;
  csrfToken: string;
  /* Kullanıcı vazgeçerse siteye bu adresle dönüyor. */
  cancelUrl: string;
}

export function siteConsentPage(input: SiteConsentPageInput): Response {
  const label = escapeHtml(input.clientLabel);
  const items = input.scopes.map((scope) => {
    const text = SCOPE_TEXTS[scope];
    return `<li><strong>${escapeHtml(text.title)}</strong><span>${escapeHtml(text.detail)}</span></li>`;
  }).join('\n');
  const withheld = WITHHELD
    .map((line) => `<li>${escapeHtml(line)}</li>`)
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

<h2>Şunları görmeyecek</h2>
<ul class="withheld">
${withheld}
</ul>

<p class="who">Orbit hesabın: <strong>@${escapeHtml(input.accountHandle)}</strong>
(${escapeHtml(input.accountDisplayName)})</p>

<form method="post" action="/v1/oauth/consent">
<input type="hidden" name="ticket" value="${escapeHtml(input.ticket)}" />
<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}" />
<div class="actions">
<button type="submit" name="decision" value="allow" class="primary">İzin ver ve devam et</button>
<button type="submit" name="decision" value="deny">Vazgeç</button>
</div>
</form>

<p class="fine">Bu izni daha sonra Orbit panelindeki <strong>bağlı siteler</strong>
bölümünden geri alabilirsin. İzni geri almak siteye verilmiş anahtarları anında
düşürür; sitenin kendi veritabanına kopyaladığı bilgileri silmez.</p>
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
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      /* Sayfada hiç script yok ve olmasına gerek yok; CSP bunu kalıcı kılıyor.
       * `frame-ancestors 'none'`: onay ekranı bir iframe'in içine alınıp
       * kullanıcıya başka bir şey gibi gösterilemez. */
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
