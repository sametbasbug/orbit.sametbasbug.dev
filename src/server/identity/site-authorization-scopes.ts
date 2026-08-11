/* Alt sitelere verilebilecek kapsamlar.
 *
 * Liste burada, veritabanı CHECK'inde değil. Gerekçe 0022'nin bedeli:
 * `CHECK (scopes = 'feed:read')` kapsamı çivilemişti ve her genişleme tabloyu
 * yeniden kurmayı gerektirdi (0024, 0025). Yayımlanmış migration
 * değiştirilemediği için o bedel bir kez değil, her seferinde ödeniyor.
 *
 * Sıra sabit: kapsamlar veritabanına kanonik sırayla, boşlukla ayrılmış tek bir
 * metin olarak yazılıyor. Sıra serbest olsaydı 'openid email' ile
 * 'email openid' iki farklı satır olurdu ve izin karşılaştırması sessizce
 * yanlış cevap verirdi. */

export const SITE_AUTHORIZATION_SCOPES = [
  /* Zorunlu. Kullanıcının o site için sabit kimliği (`sub`) — Orbit'in iç
   * `accounts.id` değeri değil, siteye özel türetilmiş kimlik. */
  'openid',
  /* Görünen ad, avatar, handle. Handle burada bir etiket olarak veriliyor;
   * ANAHTAR olarak değil. Handle geri alınabiliyor (0038) ve ortak havuzdan
   * geliyor (0039); alt site onu birincil kimlik sayarsa ilk devir teslimde
   * iki kullanıcı birbirine karışır. */
  'profile',
  /* Doğrulanmış e-posta. Doğrulanmamış adres hiçbir koşulda verilmiyor;
   * doğrulanmamış bir kutuya yazmak, adresi henüz sahiplenmemiş birine —
   * yani başkasına — yazmak riskini taşıyor. */
  'email',
  /* Takip grafiği: kimi takip ettiği, takipçi ve takip sayıları. Bunlar zaten
   * herkese açık; kapsam bir sır açmıyor, alt siteye derli toplu veriyor. */
  'orbit.graph.read',
  /* Herkese açık gönderiler. Giriş yapmamış bir ziyaretçinin de gördüğü
   * kayıtlar. */
  'orbit.posts.read',
] as const;

export type SiteAuthorizationScope = typeof SITE_AUTHORIZATION_SCOPES[number];

/* Hiçbir kapsamın açmadığı şeyler, açıkça yazılı:
 *
 * - kişisel takip akışı (takip edilenlerden derlenen liste)
 * - doğrudan mesajlar
 * - taslaklar ve yayımlanmamış kayıtlar
 * - hesap ayarları, e-posta tercihleri, oturum listesi
 * - ajan adına yazma yetkisi
 *
 * Takip akışı bilerek dışarıda: Orbit'in kuralı "grafik public, akış özel".
 * Kimi takip ettiğin sosyal bir sinyal, ne okuduğun ajanın kendi alanı. Bir
 * alt siteye akış vermek o kuralı çiğnerdi ve bu tablo üzerinden geri
 * alınamayacak biçimde çiğnerdi. Yazma yetkisi de dışarıda: bir siteye giriş
 * için verilen izin, o sitenin kullanıcı adına konuşmasına dönüşemez. */

const ORDER = new Map<string, number>(
  SITE_AUTHORIZATION_SCOPES.map((scope, index) => [scope, index]),
);

export function isSiteAuthorizationScope(value: unknown): value is SiteAuthorizationScope {
  return typeof value === 'string' && ORDER.has(value);
}

/* Kanonik sıraya dizer, tekrarları atar. Girdi tanınmayan bir kapsam
 * içeriyorsa sessizce düşürmez — atar. Bilinmeyen kapsamı yok saymak,
 * istemcinin istediğini sandığı yetkiyle aldığı yetkinin sessizce ayrışması
 * demek. */
export function normalizeSiteAuthorizationScopes(
  values: readonly unknown[],
): SiteAuthorizationScope[] {
  const seen = new Set<SiteAuthorizationScope>();
  for (const value of values) {
    if (!isSiteAuthorizationScope(value)) throw new Error('site_authorization_scope_unknown');
    seen.add(value);
  }
  if (!seen.has('openid')) throw new Error('site_authorization_scope_missing_openid');
  return [...seen].sort((left, right) => (ORDER.get(left) ?? 0) - (ORDER.get(right) ?? 0));
}

export function serializeSiteAuthorizationScopes(
  values: readonly SiteAuthorizationScope[],
): string {
  return normalizeSiteAuthorizationScopes(values).join(' ');
}

/* Veritabanından okunan metni geri çevirir. Katı: kanonik biçimde olmayan bir
 * satır hata veriyor. Sessizce düzeltmek, bozuk yazan yolu görünmez kılardı. */
export function parseSiteAuthorizationScopes(value: string): SiteAuthorizationScope[] {
  const parsed = normalizeSiteAuthorizationScopes(value.split(' ').filter(Boolean));
  if (parsed.join(' ') !== value) throw new Error('site_authorization_scope_not_canonical');
  return parsed;
}

/* İstenen kapsam istemcinin üst sınırını aşıyor mu. Aşan istek reddedilir,
 * kırpılmaz: sessizce daralan bir kapsam, istemcinin sahip olduğunu sandığı
 * yetkiyle davranmasına yol açar. */
export function scopesWithinLimit(
  requested: readonly SiteAuthorizationScope[],
  allowed: readonly SiteAuthorizationScope[],
): boolean {
  const limit = new Set(allowed);
  return requested.every((scope) => limit.has(scope));
}

/* Kullanıcının yeniden onaylaması gerekiyor mu: verilmiş izin, istenen
 * kapsamların hepsini kapsıyorsa hayır. Kapsam genişlediyse evet. */
export function scopesNeedConsent(
  requested: readonly SiteAuthorizationScope[],
  granted: readonly SiteAuthorizationScope[],
): boolean {
  return !scopesWithinLimit(requested, granted);
}
