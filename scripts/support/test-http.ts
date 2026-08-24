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
import { Agent, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

let installed = false;

/* Node'un global `fetch`'i dispatcher'ı `Symbol.for('undici.globalDispatcher.1')`
 * üzerinden okuyor; undici paketinin `setGlobalDispatcher`'ı aynı sembole
 * yazdığı için yerleşik fetch de bu ayarı görüyor. */
export function useFreshConnectionPerRequest(): void {
  if (installed) return;
  const agent = new Agent({ pipelining: 0 });
  setGlobalDispatcher(agent);
  assertDispatcherInstalled(agent);
  installed = true;
}

/* Bekçi: ayarın gerçekten yerleşip yerleşmediğini kontrol eder.
 *
 * `setGlobalDispatcher` global bir sembole yazıyor ve Node'un yerleşik
 * `fetch`'i onu okuyor. Bugün (Node 26 / undici 7) iki sembol de —
 * `undici.globalDispatcher.1` ve `.2` — aynı nesneyi gösteriyor. Yarın
 * paket ile Node'un sembolleri ayrışırsa çağrı sessizce hiçbir şey yapmaz:
 * keep-alive geri gelir, flake geri gelir ve hiçbir test kırılmaz, çünkü
 * bu yalnızca ara sıra düşen bir yarışı geri açar.
 *
 * Sessiz bozulmayı gürültülü hataya çeviriyoruz: yerleşmediyse testler
 * daha ilk satırda dursun. */
function assertDispatcherInstalled(expected: Dispatcher): void {
  const seen = [
    Symbol.for('undici.globalDispatcher.1'),
    Symbol.for('undici.globalDispatcher.2'),
  ].filter((symbol) => symbol in globalThis);

  const missed = seen.filter(
    (symbol) => (globalThis as Record<symbol, unknown>)[symbol] !== expected,
  );

  if (seen.length === 0 || missed.length > 0) {
    throw new Error(
      'Test fetch bağlantı politikası yerleşmedi: undici setGlobalDispatcher ' +
        "Node'un yerleşik fetch'inin okuduğu sembole yazmıyor. Keep-alive " +
        'yeniden kullanımı geri döner ve UND_ERR_SOCKET flake\'i yeniden ' +
        'başlar. support/test-http.ts içindeki gerekçeye bak; undici ve Node ' +
        'sürümlerinin uyumunu kontrol et.',
    );
  }
}
