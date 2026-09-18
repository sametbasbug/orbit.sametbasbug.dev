/**
 * Yerel test worker'larına giden fetch'lerin bağlantı politikası.
 *
 * Belirti şuydu: CI'da ara sıra, bir testin ilk `fetch`'i hiçbir iddiaya
 * varmadan 3-4 ms içinde düşüyordu.
 *
 *   TypeError: fetch failed
 *     cause: SocketError: other side closed  (UND_ERR_SOCKET)
 *     socket: { bytesWritten: 370, bytesRead: 1631 }
 *
 * `bytesRead` sıfır değil: soket daha önce bir yanıt taşımış, yani bu yeni
 * kurulan bir bağlantı değil, undici'nin havuzundan gelen bir keep-alive
 * bağlantısı. Sunucu onu kapatmış (FIN), istemci ölü sokete yazmış.
 *
 * Neden istemci FIN'i görmüyor: bu test dosyaları worker ayaktayken
 * `spawnSync` ile ikinci wrangler süreçleri koşturuyor (migration, importer,
 * d1 execute). `spawnSync` olay döngüsünü saniyelerce tamamen durduruyor.
 * O sürede undici ne soketin FIN'ini işleyebiliyor ne de kendi boşta kalma
 * zamanlayıcısını (varsayılan 4 sn) çalıştırıp soketi havuzdan atabiliyor.
 * `spawnSync` döner dönmez gelen `fetch` isteği aynı senkron adımda ölü
 * sokete yazılıyor. Sunucu tarafında da bir güvence yok: workerd yanıtta
 * `Keep-Alive` başlığı göndermiyor, yani boşta kalan bir bağlantıyı ne
 * zaman kapatacağını istemciye hiç söylemiyor.
 *
 * HTTP/1.1'de bunun sağlıklı bir çözümü yok: yazmadan önce bağlantının
 * hâlâ açık olup olmadığını bilmenin yolu yoktur. Normal istemciler bunu
 * "güvenli isteği bir kez tekrar dene" ile örter; testte hatayı örtmek
 * istemiyoruz. Kalan tek sağlam seçenek bağlantıyı hiç yeniden
 * kullanmamak: `pipelining: 0` undici'de keep-alive'ı kapatır, her istek
 * kendi bağlantısını açar ve yarış ortadan kalkar. Yerelde birkaç düzine
 * istek için maliyeti ölçülemeyecek kadar küçük.
 */
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

let installed = false;

/* Node'un global `fetch`'i ile npm'den kurulu undici aynı dispatcher
 * sözleşmesini paylaşır. Sembolün sürüm eki undici major'ları arasında
 * değişebilir; bu yüzden aşağıdaki bekçi tek bir tarihsel sembole bağlanmaz.
 * Bu sözleşmenin gerçekten Node `fetch`'ine ulaştığı ayrıca
 * orbit-test-ports-tests.ts içindeki MockAgent regresyonuyla ölçülür. */
export function useFreshConnectionPerRequest(): void {
  if (installed) return;
  const agent = new Agent({ pipelining: 0 });
  setGlobalDispatcher(agent);
  assertDispatcherInstalled(agent);
  installed = true;
}

/* Bekçi: ayarın gerçekten yerleşip yerleşmediğini kontrol eder.
 *
 * Undici 7 aynı dispatcher'ı hem `.1` hem `.2` sembolünde görüyordu;
 * undici 8 ile eski `.1` slotu Node tarafından tutulurken yeni paket `.2`
 * slotunu kullanıyor. Bütün tarihsel slotların aynı nesne olmasını istemek
 * geçerli major yükseltmesini yanlış negatifle durdurur.
 *
 * Bunun yerine paket API'sinin beklenen dispatcher'ı döndürmesini ve bilinen
 * global slotlardan en az birinin aynı nesneyi taşımasını istiyoruz. Node'un
 * yerleşik fetch'inin de bu dispatcher'ı kullandığı ayrı regresyon testinde
 * davranışsal olarak doğrulanıyor. */
function assertDispatcherInstalled(expected: Dispatcher): void {
  const symbols = [
    Symbol.for('undici.globalDispatcher.1'),
    Symbol.for('undici.globalDispatcher.2'),
    Symbol.for('undici.globalDispatcher.3'),
  ];
  const seen = symbols.filter((symbol) => symbol in globalThis);
  const matching = seen.filter(
    (symbol) => (globalThis as Record<symbol, unknown>)[symbol] === expected,
  );

  if (getGlobalDispatcher() !== expected || matching.length === 0) {
    throw new Error(
      'Test fetch bağlantı politikası yerleşmedi: undici setGlobalDispatcher ' +
        "beklenen global dispatcher'ı kurmadı. Keep-alive yeniden kullanımı " +
        "geri döner ve UND_ERR_SOCKET flake'i yeniden başlar. " +
        'support/test-http.ts içindeki gerekçeye bak; undici ve Node ' +
        'sürümlerinin uyumunu kontrol et.',
    );
  }
}
