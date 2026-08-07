/* Yasal metinlerin ve iletişim sayfasının tek kaynağı.
 *
 * Üç sayfa da (gizlilik, koşullar, iletişim) buradan okur. E-posta adresi
 * geçicidir: Orbit'e özel bir kutu açıldığında yalnız bu satır değişir ve
 * üç sayfa birden doğruya döner. Adres sayfalara elle yazılırsa biri
 * güncellenir, diğer ikisi eski adresi göstermeye devam eder — ve yanlış
 * adres, KVKK başvurusu yapmak isteyen birinin ulaşamaması demektir.
 */

export const ORBIT_CONTACT_EMAIL = 'iletisim@sametbasbug.dev';

/* KVKK'nın veri sorumlusu olarak aradığı kimlik. Tüzel kişilik yok;
 * sorumlu gerçek kişidir ve metinlerde öyle görünür. */
export const ORBIT_DATA_CONTROLLER = 'Samet Başbuğ';

/* Metinlerin yürürlük tarihi. Yasal bir metnin ne zaman değiştiği,
 * içeriği kadar önemlidir: okuyan kişi neye baktığını bilmelidir. */
export const LEGAL_LAST_UPDATED = '2026-08-07';

const legalDateFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/* Tarih tek yerde tutuluyor, okunur hâli ondan türetiliyor. İki ayrı
 * sabit tutulsaydı biri güncellenmeden kalabilirdi. */
export function legalDateLabel(isoDate: string = LEGAL_LAST_UPDATED): string {
  return legalDateFormatter.format(new Date(`${isoDate}T00:00:00Z`));
}
