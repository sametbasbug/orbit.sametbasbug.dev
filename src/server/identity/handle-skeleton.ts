/* Handle normalleştirmesi. Politika kararlarından ayrı bir dosyada duruyor
 * çünkü engelli kelime üreticisi de aynı normalleştirmeyi kullanmak zorunda:
 * kaynak listedeki kelimeler ile bir handle aynı işlemden geçmezse liste
 * boşuna yazılmış olur. Üretici `handle-policy`yi çağıramaz — o dosya
 * üreticinin henüz yazmadığı özet dosyasını içe aktarıyor. Bu ayrım, o
 * döngüyü kırmak için.
 *
 * Burada karar yok, yalnız dönüşüm var. Neyin yasak olduğu `handle-policy`de.
 */

/* Rakamdan harfe eşleme. Yalnız görsel olarak güçlü olanlar var; `2→z` ya da
 * `6→g` gibi zayıf benzerlikler kasten dışarıda, çünkü her eşleme meşru
 * handle'ları da birbirine çarpıştırıyor ve zayıf bir benzerlik için bu bedel
 * ödenmez.
 *
 * `1` bir kez `l`ye eşlenmişti; yanlıştı. Leet yazımında `1` neredeyse her
 * zaman `i` demek ve o hâliyle `4dm1n` iskelette `admln` oluyordu — yani
 * rezerve listeyi rakam ikamesine karşı korumak için konan eşleme, tam da o
 * ikameyi kaçırıyordu. Testte görülüp düzeltildi.
 *
 * Harften harfe eşleme (`i→l` gibi) yok: `mail` ile `mall`'ı çakıştırmak,
 * engellediği taklitten daha çok masum ada dokunurdu. */
const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/* İskelet: tireler atılmış, rakamlar harfe çevrilmiş, tekrarlar daraltılmış
 * tek parça. `nyx`, `nyxx`, `ny-x`, `n-y-x` ve `nyx-` hepsi `nyx`.
 *
 * Tekrar daraltması bilinçli bir taviz içeriyor: `matt` ile `mat` artık aynı
 * anda var olamaz. Küçük bir platformda bu bir kayıp değil, tam da istenen —
 * harf ikizlemek bir adı kapmanın en ucuz yolu ve bunu kapatmanın bedeli
 * "iki benzer ad birlikte duramaz"dan ibaret. */
export function handleSkeleton(handle: string): string {
  return collapse(mapLeet(handle.toLowerCase().replaceAll('-', '')));
}

/* Tire ayrılmış parçalar, aynı dönüşümden geçmiş hâlde. Parça sınırı
 * korunuyor çünkü kısa rezerve kelimeler ancak tam bir parçaya eşit
 * olduklarında anlamlı: `api` bir handle olarak sorunlu, `terapist`in
 * içinde değil. */
export function handleSegments(handle: string): string[] {
  return handle
    .toLowerCase()
    .split('-')
    .map((segment) => collapse(mapLeet(segment)))
    .filter((segment) => segment !== '');
}

function mapLeet(value: string): string {
  let mapped = '';
  for (const character of value) mapped += LEET_MAP[character] ?? character;
  return mapped;
}

function collapse(value: string): string {
  return value.replace(/(.)\1+/gu, '$1');
}

/* FNV-1a, iki farklı tohumla katlanmış. Kriptografik değil ve olması da
 * gerekmiyor: engelli kelime listesinde saklanan bir sır yok, yalnızca bir
 * kaynak deposunda açık metin olarak durmasını istemediğimiz bir liste var.
 * Kısa kelimelerin özetini kırmak isteyen biri bunu dakikalar içinde yapar;
 * bu bir gizleme, bir engelleme değil.
 *
 * Eşzamanlı çalışması, kayıt başına birkaç yüz kez çağrıldığı için
 * WebCrypto'nun async özetlerine tercih edildi. */
export function fold(value: string): string {
  return `${fnv1a(value, 0x811c9dc5)}${fnv1a(value, 0x01000193)}`;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
