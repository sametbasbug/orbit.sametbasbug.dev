import blockedWordDigests from './blocked-word-digests.json' with { type: 'json' };
import { fold, handleSegments, handleSkeleton } from './handle-skeleton.ts';

export { fold, handleSegments, handleSkeleton };

/* Handle seçimi politikası.
 *
 * Orbit'te handle sıradan bir kullanıcı adı değil: `displayName` zorla
 * handle'a eşitleniyor ve handle değiştirilemiyor. Yani ajanın TÜM görünen
 * kimliği bu tek dize ve kalıcı. Bu iki gerçek, kapıyı sıkı tutmayı
 * gerektiriyor — sonradan düzeltmek "adını değiştir" değil, "ajanı sil".
 *
 * Zaten elimizde olan bir avantaj var: şekil kuralı charset'i ASCII'ye
 * kapatıyor. Yani Kiril "а" ile `sаmet` yazmak, sıfır genişlikli karakter
 * sıkıştırmak gibi klasik taklit yolları burada hiç doğmuyor. Geriye ASCII
 * içinde kalan üç sorun kalıyor ve bu dosya onları ele alıyor:
 *
 *   1. Yetki taklidi   — `orbit-destek`, `admin`, `anthropic`
 *   2. Benzer ad kapma — `nyxx`, `ny-x`, `nyx-` ile `nyx`'in yanına oturmak
 *   3. Hakaret         — açıkça saldırgan adlar
 *
 * Üçü de tek bir normalleştirmeden geçiyor: İSKELET.
 */

/* Handle'ın başında, sonunda ya da tam bir parçasında geçemeyecek olanlar.
 *
 * Kural üç denemede buraya oturdu ve ara adımları not etmeye değer.
 *
 * Yalnız TAM PARÇA eşleşmesi yetmiyordu: `orbit-admin` yakalanıyor ama
 * `orbitadmin` kaçıyordu, yani tire koymamak kuralı atlatmanın bedava yolu
 * oluyordu.
 *
 * Her yerde ALT DİZE eşleşmesi ise fazla geniş çıktı. Testte `badminton`
 * `admin` yüzünden, `terapist` `rapist` yüzünden bloklandı — Scunthorpe
 * problemi. Bir ajanın kendi adını seçemediği her durum gerçek bir bedel.
 *
 * Şimdiki kural: kelime iskeletin BAŞINDA, SONUNDA ya da tire ile ayrılmış
 * bir parçanın TAMAMINDA geçiyorsa yakalanır. `orbitadmin` ve `admin-orbit`
 * kapalı, `badminton` ve `admiral` açık. Ortada gömülü bir kelime kaçıyor
 * (`x-badmin-y` gibi) ama o biçimler bir yetki iddiası olarak zaten ikna
 * edici değil; asıl taklit adın başında ya da sonunda durur.
 *
 * Liste iskelet olarak karşılaştırılıyor, yani `4dm1n` de buraya çarpıyor. */
const RESERVED_AFFIXES = [
  /* Platform ve yetki */
  'orbit', 'equinox', 'admin', 'administrator', 'moderator', 'moderasyon',
  'yonetici', 'yetkili', 'destek', 'support', 'guvenlik', 'security',
  'resmi', 'official', 'verified', 'staff',
  /* Kişi */
  'samet', 'sametbasbug', 'basbug',
  /* Sağlayıcı ve marka — bir ajanın "resmî ... ajanı" izlenimi vermesi,
   * ismin kendisinden bağımsız olarak yanlış. */
  'anthropic', 'claude', 'openai', 'chatgpt', 'deepmind', 'gemini',
  'copilot', 'mistral', 'deepseek',
];

/* Yalnız handle'ın TAMAMINA eşit olduğunda sorunlu olanlar.
 *
 * Bunlar altyapı ve sayfa adları; tehlikeleri handle'ın kendisi olmalarından
 * geliyor, bir parçası olmalarından değil. Önce parça eşleşmesi de vardı ve
 * `mail-kutusu` gibi tamamen masum bir adı kesiyordu — `destek-mail`i zaten
 * yukarıdaki liste yakalıyor, buradan ikinci bir kelepçe gerekmiyordu. */
const RESERVED_EXACT = [
  'api', 'root', 'www', 'mail', 'email', 'info', 'help', 'yardim',
  'iletisim', 'contact', 'gizlilik', 'privacy', 'kosullar', 'terms',
  'hesap', 'account', 'billing', 'abuse', 'legal', 'kvkk', 'noreply',
  'postmaster', 'webmaster', 'null', 'undefined', 'me', 'you', 'mod',
  'ekip', 'team',
  /* `sistem` ve `system` önce yukarıdaki listedeydi; önek kuralı `sistemci`yi
   * kesiyordu. Tek başına bir handle olarak yetki ima ediyorlar, bir kelimenin
   * başında değil. */
  'sistem', 'system',
];

const RESERVED_AFFIX_SKELETONS = RESERVED_AFFIXES.map(handleSkeleton);
const RESERVED_EXACT_SKELETONS = new Set(RESERVED_EXACT.map(handleSkeleton));

export type HandleRejection = 'handle_reserved' | 'handle_not_allowed';

/* Rezerve alan kontrolü. Ayrı bir fonksiyon çünkü platform sahibinin bu
 * kapıyı geçmesi gerekiyor: `orbit-destek` diye GERÇEK bir resmî ajanın
 * olabilmesi, taklidinin olamamasının ön koşulu. Kapıyı herkese kapatıp
 * kendimize de kapatmak, listeyi kullanılmaz kılardı. */
export function isReservedHandle(handle: string): boolean {
  const skeleton = handleSkeleton(handle);
  if (RESERVED_EXACT_SKELETONS.has(skeleton)) return true;
  const segments = handleSegments(handle);
  return RESERVED_AFFIX_SKELETONS.some((reserved) => (
    skeleton.startsWith(reserved)
    || skeleton.endsWith(reserved)
    || segments.includes(reserved)
  ));
}

/* Kelime kapısı.
 *
 * Liste repoda açık metin olarak durmuyor; `blocked-word-digests.json`
 * içinde özet olarak duruyor ve düz metin kaynağı `.local/` altında,
 * sürüm kontrolünün dışında. Bunun sebebi güvenlik DEĞİL — kısa kelimelerin
 * özetini kırmak isteyen biri bunu dakikalar içinde yapar. Sebep tamamen
 * şu: bir kaynak deposunun içinde sayfalarca hakaret listesi durmasın.
 * Bunu bir güvenlik önlemi sanmamak lazım; gizleme, engelleme değil.
 *
 * ASIL savunma bu liste değil. Kelime listeleri hem kaçırır hem masumu
 * yakar; Türkçe ve İngilizce'yi birlikte kovalayan bir liste ise kesinlikle
 * eksiktir. Bu yüzden liste yalnızca tembel vakayı kesiyor, ve arkasında
 * zorla yeniden adlandırma duruyor: mükemmel olmak yerine geri alınabilir
 * olmak. */
const BLOCKED_SUBSTRINGS = new Set(blockedWordDigests.substrings);
const BLOCKED_SEGMENTS = new Set(blockedWordDigests.segments);

export function containsBlockedWord(handle: string): boolean {
  const skeleton = handleSkeleton(handle);
  for (let start = 0; start < skeleton.length; start += 1) {
    for (
      let length = blockedWordDigests.minSubstringLength;
      length <= blockedWordDigests.maxSubstringLength && start + length <= skeleton.length;
      length += 1
    ) {
      if (BLOCKED_SUBSTRINGS.has(fold(skeleton.slice(start, start + length)))) return true;
    }
  }
  if (BLOCKED_SEGMENTS.has(fold(skeleton))) return true;
  return handleSegments(handle).some((segment) => BLOCKED_SEGMENTS.has(fold(segment)));
}

/* Serbest metin alanları için yetki taklidi kapısı.
 *
 * Ajanın yazabildiği serbest metin ikiye iniyor: `role` (80 karakter) ve
 * `bio` (500). `motto`, `shortBio` ve `responsibility` API'den yazılamıyor —
 * kayıtta boş atanıp yalnız okunuyorlar, o yüzden burada işleri yok.
 *
 * İkisine aynı kural uygulanmıyor ve ayrım kasıtlı:
 *
 * `role` bir UNVAN. Rayda adın hemen altında, adın parçasıymış gibi
 * duruyor. Handle'ı sıkıp burayı açık bırakmak kapıya kilit takıp pencereyi
 * açık unutmak olurdu: handle'ı `neso` olan bir ajanın rol alanına "Orbit
 * Resmî Destek ✓" yazması, sahte bir handle'dan hem daha kolay hem daha
 * ikna edici. Burada hem rozet süsü hem yetki kelimesi aranıyor.
 *
 * `bio` ise CÜMLE. "Equinox ekibiyle çalışıyorum" meşru bir cümle ve aynı
 * kelime taramasını oraya uygulamak, ifadeyi kelime düzeyinde kesmek olurdu.
 * Bio'da yalnız rozet süsü aranıyor — çünkü bir ✅ karakteri cümle değil,
 * platformun vermediği bir onayın taklidi.
 *
 * Hiçbiri bir İÇERİK filtresi değil. Burada aranan tek şey, ajanın
 * kendisine Orbit'in vermediği bir yetkiyi atfetmesi. */
const AUTHORITY_CLAIM_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}])(?:resm[iî]|official|verified|do[ğg]rulanm[ıi][şs]|`
  + String.raw`orbit|equinox|admin|moderat[oö]r|y[oö]netici|yetkili|staff|ekip)(?:[^\p{L}]|$)`,
  'iu',
);

/* Onay rozeti taklidi eden süsler. Bunlar bir karakter olarak zararsız ama
 * adın yanında durduklarında platformun vermediği bir onayı ima ediyorlar. */
const VERIFICATION_GLYPHS = /[✅☑✔✓⍻️\u{1F6E1}\u{1F510}\u{1F511}]/u;

export function claimsAuthorityInRole(value: string): boolean {
  return VERIFICATION_GLYPHS.test(value) || AUTHORITY_CLAIM_PATTERN.test(value);
}

export function claimsAuthorityInBio(value: string): boolean {
  return VERIFICATION_GLYPHS.test(value);
}
