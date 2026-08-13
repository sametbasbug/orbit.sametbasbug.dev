import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { claimPort, releasePort, reserveWorkerPorts, RESERVATION_DIRECTORY } from './orbit-test-ports';

/* Bu dosyanın ölçtüğü şey bir gecelik regresyon hatası.
 *
 * `test:d1` yedi ayrı süreçte wrangler dev başlatıyor ve portları
 * çakışabiliyordu; gerekçe orbit-test-ports.ts'in başında yazılı. Yarışı
 * düzeltmek yetmez — düzeltmenin geri alınmadığını da ölçmek gerekiyor,
 * çünkü bu tür bir hata geri geldiğinde "ara sıra kırmızı" gibi görünür,
 * kırık gibi değil, ve öyle görünen şeyler yeniden çalıştırılıp geçilir. */

const TSX = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const claimed: number[] = [];

after(() => {
  for (const port of claimed) releasePort(port);
});

/* Rezervasyonu tutan bir çocuk süreç: portları alıp yazıyor, sonra
 * kendisine dur denene kadar bekliyor. Beklemesi şart — süreç biterse
 * rezervasyonlar serbest kalır ve test hiçbir şey ölçmemiş olur. */
/* Üst düzey await yok: tsx `--eval` girdisini CommonJS olarak derliyor ve
 * orada üst düzey await bir sözdizimi hatası. */
const HOLDER = `
void (async () => {
  const module = await import(${JSON.stringify(path.join(process.cwd(), 'scripts', 'orbit-test-ports.ts'))});
  console.log(JSON.stringify(await module.reserveWorkerPorts()));
  await new Promise((resolve) => process.stdin.once('data', resolve));
})();
`;

async function holdPortsInAChildProcess(): Promise<{
  ports: Promise<{ port: number; inspectorPort: number }>;
  stop: () => void;
}> {
  const child = spawn(process.execPath, [TSX, '--eval', HOLDER], {
    cwd: process.cwd(),
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += String(chunk); });
  const ports = new Promise<{ port: number; inspectorPort: number }>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
      if (line) resolve(JSON.parse(line) as { port: number; inspectorPort: number });
    });
    child.once('exit', (code) => {
      reject(new Error(`Port holder exited with ${code} before reserving:\n${output}\n${errors}`));
    });
  });
  return { ports, stop: () => { child.stdin.write('\n'); child.kill('SIGTERM'); } };
}

describe('test worker port reservation', () => {
  test('concurrent processes never receive the same port', async () => {
    /* Yarışın gerçek şekli bu: aynı anda başlayan süreçler.
     *
     * Ama bu testin ne kadar kanıtladığı konusunda dürüst olmak gerek:
     * eski ayırıcıyla aynı deneyi macOS'ta 40 tur koşturdum, tek bir
     * çakışma çıkmadı — işletim sistemi geçici portları sırayla dağıtıyor
     * ve pencere dar. Yani bu test bir gerileme yakalarsa şanstan yakalar.
     * Asıl ölçüm aşağıdaki iki testte; bu, aradaki sözleşmenin uçtan uca
     * durduğunu görmek için burada. */
    const holders = await Promise.all(
      Array.from({ length: 8 }, () => holdPortsInAChildProcess()),
    );
    try {
      const reserved = await Promise.all(holders.map((holder) => holder.ports));
      const all = reserved.flatMap(({ port, inspectorPort }) => [port, inspectorPort]);
      assert.equal(all.length, 16);
      assert.equal(new Set(all).size, all.length, `duplicate ports handed out: ${all.join(', ')}`);
    } finally {
      for (const holder of holders) holder.stop();
    }
  });

  test('a port stays reserved after the probe socket is closed', async () => {
    /* Hatanın kalbi. Ayırıcı soketi kapatıyor — kapatmak zorunda, yoksa
     * wrangler portu bağlayamaz — ve o andan itibaren port işletim sistemi
     * için boş. Rezervasyon dosyası tam bu aralığı kapatıyor. */
    const { port } = await reserveWorkerPorts();
    claimed.push(port);
    assert.ok(existsSync(path.join(RESERVATION_DIRECTORY, String(port))));
    assert.equal(claimPort(port), false, 'a held port was handed out a second time');
  });

  test('a reservation left behind by a dead process is reclaimed', async () => {
    /* Çöken bir koşu işaretini geride bırakır. Bu temizlenmezse aralık
     * yavaş yavaş zehirlenir ve bir süre sonra hiçbir port alınamaz —
     * yani düzeltme, zamanla kendi arızasına dönüşür. */
    const { port } = await reserveWorkerPorts();
    releasePort(port);
    const reservation = path.join(RESERVATION_DIRECTORY, String(port));

    /* Kesinlikle yaşamayan bir pid: kendi çocuğumuzu başlatıp ölmesini
     * bekliyoruz. Uydurma bir sayı yazmak, o sayının o an gerçekten
     * kullanımda olmadığına güvenmek olurdu. */
    const dead = spawn(process.execPath, ['--eval', 'process.exit(0)']);
    const deadPid = dead.pid;
    assert.ok(deadPid);
    await new Promise((resolve) => dead.once('exit', resolve));

    writeFileSync(reservation, String(deadPid));
    assert.equal(claimPort(port), true, 'a stale reservation was not reclaimed');
    claimed.push(port);
    assert.equal(readFileSync(reservation, 'utf8'), String(process.pid));
  });
});
