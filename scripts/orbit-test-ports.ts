import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Test worker'larının portlarını dağıtan tek yer.
 *
 * Yedi D1 test dosyası kendi `wrangler dev`'ini başlatıyor ve `test:d1`
 * onları beşerli koşuyor. Her dosya portunu şöyle seçiyordu: 0'a bağlan,
 * işletim sisteminin verdiği portu oku, soketi kapat, wrangler'ı o portla
 * başlat. Kulağa doğru geliyor ve yanlış — soketi kapatmakla wrangler'ın
 * o portu bağlaması arasında saniyeler var. O aralıkta ikinci bir test
 * süreci sorarsa işletim sistemi aynı portu ona da verebilir, çünkü artık
 * boştur. İkisi de başlar, biri bağlanır, diğeri workerd düzeyinde ölür:
 *
 *   Fatal uncaught kj::Exception: ::bind(...): Address already in use
 *
 * 13 Ağustos'ta gecelik regresyon tam olarak böyle düştü ve aynı commit
 * ikinci denemede yeşil geçti. Bu, düzeltilmesi en kolay hata türü değil
 * ama görmezden gelinmesi en kolay olanı: rastgele kırmızı olan bir iş,
 * kimsenin okumadığı bir işe dönüşür — gecelik regresyonun var olma
 * sebebinin tam tersi.
 *
 * Buradaki çözüm, portu soket kapandıktan SONRA da rezerve tutmak. Süreçler
 * ayrı olduğu için rezervasyon süreç içi bir küme olamaz; dosya sisteminde
 * duruyor. `open(..., 'wx')` çekirdek düzeyinde atomik: aynı anda iki süreç
 * denerse yalnız biri kazanır, diğeri EEXIST alır ve başka bir port ister.
 *
 * Rezervasyon dosyası sahibinin pid'ini taşıyor. Çöken bir koşu işaretini
 * geride bırakır ve bir daha temizlemez; o yüzden EEXIST gördüğümüzde
 * sahibin hâlâ yaşayıp yaşamadığına bakıyoruz. Pid'ler tekrar kullanılabilir,
 * yani bu kontrol teorik olarak yanılabilir — yanıldığında sonuç bugünkü
 * davranış, yani daha kötüsü değil.
 *
 * Bu, portu makinedeki BAŞKA bir programın kapmasına karşı bir güvence
 * değil; ona karşı atomik bir yol zaten yok. Ölçtüğümüz ve düzelttiğimiz
 * yarış, testlerin kendi aralarındaki. */

export const RESERVATION_DIRECTORY = path.join(tmpdir(), 'orbit-test-ports');
const RESERVATION_ATTEMPTS = 100;

const held = new Set<number>();
let releaseRegistered = false;

async function askOperatingSystemForAPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not allocate a local test port.'));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    /* EPERM: süreç var ama bize ait değil — yaşıyor sayılır.
     * ESRCH: böyle bir süreç yok — işaret çöp. */
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* Tek bir portu rezerve etmeyi dener. Dışa açık, çünkü rezervasyonun iki
 * ilginç hâli — sahibi yaşıyor, sahibi ölmüş — ancak buradan doğrudan
 * ölçülebiliyor; işletim sisteminden belirli bir portu istemenin yolu yok. */
export function claimPort(port: number): boolean {
  mkdirSync(RESERVATION_DIRECTORY, { recursive: true });
  const reservation = path.join(RESERVATION_DIRECTORY, String(port));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(reservation, 'wx');
      writeSync(handle, String(process.pid));
      closeSync(handle);
      held.add(port);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    /* İkinci tur yalnız işaretin çöp olduğunu kanıtlarsak çalışıyor. */
    let owner = 0;
    try {
      owner = Number.parseInt(readFileSync(reservation, 'utf8').trim(), 10);
    } catch {
      return false;
    }
    if (!Number.isInteger(owner) || owner <= 0 || ownerIsAlive(owner)) return false;
    try {
      unlinkSync(reservation);
    } catch {
      return false;
    }
  }
  return false;
}

export function releasePort(port: number): void {
  held.delete(port);
  try {
    unlinkSync(path.join(RESERVATION_DIRECTORY, String(port)));
  } catch {
    /* Rezervasyonu bırakmak en iyi çabadır: burada atılan bir hata
     * testin gerçek sonucunu gizler. */
  }
}

function releaseHeldPorts(): void {
  for (const port of [...held]) releasePort(port);
}

async function reservePort(): Promise<number> {
  if (!releaseRegistered) {
    process.on('exit', releaseHeldPorts);
    releaseRegistered = true;
  }
  for (let attempt = 0; attempt < RESERVATION_ATTEMPTS; attempt += 1) {
    const port = await askOperatingSystemForAPort();
    if (claimPort(port)) return port;
  }
  throw new Error(
    `Could not reserve a free local port after ${RESERVATION_ATTEMPTS} attempts.`,
  );
}

/* Her wrangler dev iki port istiyor: biri Worker, biri inspector. İkisini
 * birlikte veriyoruz — ayrı ayrı istendiğinde her çağıran aynı "aynı portu
 * iki kez alma" kontrolünü kendisi yazmak zorunda kalıyordu. */
export async function reserveWorkerPorts(): Promise<{ port: number; inspectorPort: number }> {
  const port = await reservePort();
  const inspectorPort = await reservePort();
  return { port, inspectorPort };
}
