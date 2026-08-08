/* GitHub'dan dönüşte işler ters gittiğinde insanın gördüğü sayfa.
 *
 * Neden var: bu uç bir API ucu değil, tarayıcının yönlendirildiği adres.
 * Buradan JSON dönmek, giriş yapmaya çalışan birine süslü parantezlerle
 * `{"error":{"code":"invitation_required"}}` göstermek demek. Kapı davetliyken
 * bunu görecek kişi sayısı sıfıra yakındı; kapı açıldığında bu yol hız
 * tavanının da çıkışı olacak ve tavana çarpan kişi gerçek bir abone olacak.
 *
 * Neden kendi içinde tam: site CSS'i bir varlık isteği demek ve bu sayfanın
 * gösterildiği an, bir şeyin zaten yolunda gitmediği an. Hata sayfasının
 * ikinci bir isteğe bağlı olması, hatanın kendisinden kötü bir arıza olurdu.
 * Renkler ve yazı tipi bu yüzden sistemin kendisinden alınıyor; sayfa
 * Orbit'e benzemiyor ama her koşulda okunuyor.
 *
 * Metinler koda gömülü ve dışarıdan hiçbir değer araya girmiyor: seçim bir
 * eşleme tablosundan yapılıyor, birleştirme yok. Kaçırılmış bir kaçış
 * karakteri riski böylece hiç doğmuyor.
 */

interface OAuthErrorText {
  title: string;
  body: string;
}

const OAUTH_ERROR_TEXTS: Record<string, OAuthErrorText> = {
  registration_rate_limited: {
    title: 'Şu an yeni kayıt alamıyoruz',
    body: 'Kısa bir süre içinde açılan hesap sayısı sınıra ulaştı. Bir süre sonra tekrar dene — hesabın açılmadı, ama başka hiçbir şey de olmadı.',
  },
  registration_closed: {
    title: 'Yeni kayıtlar geçici olarak durduruldu',
    body: 'Şu anda yeni hesap açmıyoruz. Mevcut bir hesabın varsa girişin etkilenmez; yeni kayıt için bir süre sonra tekrar dene.',
  },
  terms_not_accepted: {
    title: 'Onay alınamadı',
    body: 'Gizlilik Politikası ve Kullanım Koşulları onayı bu giriş için kayda geçmemiş. Sayfaya dönüp kutuyu işaretleyerek yeniden dene.',
  },
  account_unavailable: {
    title: 'Hesabın şu anda kullanılamıyor',
    body: 'Hesabın askıya alınmış veya kapatılmış. Bunun bir yanlışlık olduğunu düşünüyorsan bize yaz.',
  },
};

const FALLBACK: OAuthErrorText = {
  title: 'Giriş tamamlanamadı',
  body: 'GitHub’dan dönüş sırasında bir şey ters gitti. Genellikle bağlantının süresi dolmuş oluyor; baştan denemek yetiyor.',
};

export function oauthCallbackErrorPage(code: string, status: number): Response {
  const text = OAUTH_ERROR_TEXTS[code] ?? FALLBACK;
  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${text.title} · Equinox Orbit</title>
<style>
:root { color-scheme: light dark; --ink: #16181d; --muted: #5b6270; --paper: #fbfbfc; --line: #e3e5ea; }
@media (prefers-color-scheme: dark) { :root { --ink: #eceef2; --muted: #9aa1af; --paper: #14161a; --line: #2a2e36; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem;
  background: var(--paper); color: var(--ink);
  font: 1rem/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; border: 1px solid var(--line); border-radius: 0.75rem; padding: 2rem; }
h1 { margin: 0 0 0.75rem; font-size: 1.35rem; line-height: 1.3; }
p { margin: 0 0 1.5rem; color: var(--muted); }
a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>${text.title}</h1>
<p>${text.body}</p>
<p><a href="/">Orbit ana sayfasına dön</a> · <a href="/iletisim">İletişim</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      /* Hata sayfası önbelleğe girmemeli: hız tavanı geçici bir durum ve
       * kenarda duran bir kopya, tavan düştükten sonra da insana kapalı
       * kapı gösterirdi. */
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
