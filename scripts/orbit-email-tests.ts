import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { ResendSender, createEmailSender } from '../src/server/notifications/email';
import {
  ANNOUNCEMENT_EMAIL_SEVERITIES,
  announcementEmail,
  recordRemovedEmail,
} from '../src/server/notifications/messages';

function sender(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const instance = new ResendSender(
    { apiKey: 'test-key', from: 'orbit@example.test', replyTo: 'iletisim@example.test' },
    async (input, init) => {
      const request = new Request(input as never, init as never);
      seen.push(request);
      return await respond(request);
    },
  );
  return { instance, seen };
}

describe('giden posta', { concurrency: false }, () => {
  test('4xx kalıcıdır, 429 ve 5xx geçicidir', async () => {
    /* Ayrım tekrar denemeyi belirliyor ve iki yönde de pahalı. Kalıcı bir
     * hatayı geçici saymak, geçersiz bir adrese beş kez daha yazmak ve her
     * seferinde geri dönen posta üretmek demek — geri dönen posta gönderim
     * itibarını bozar ve sonra GERÇEK adreslere de ulaşamayız. Geçici bir
     * hatayı kalıcı saymak ise bildirimi tek denemede kaybetmek. */
    for (const [status, expected] of [
      [400, 'permanent'], [403, 'permanent'], [422, 'permanent'],
      [429, 'transient'], [500, 'transient'], [503, 'transient'],
    ] as const) {
      const { instance } = sender(() => new Response('nope', { status }));
      const result = await instance.send({ to: 'a@example.test', subject: 's', bodyText: 'b', unsubscribable: false });
      assert.equal(result.outcome, expected, `${status} yanlış sınıflandırıldı`);
    }
  });

  test('ağa ulaşılamaması geçicidir, kalıcı değil', async () => {
    /* Resend'e ulaşamamak, Resend'in bizi reddettiği anlamına gelmiyor. */
    const { instance } = sender(() => { throw new Error('network down'); });
    const result = await instance.send({ to: 'a@example.test', subject: 's', bodyText: 'b', unsubscribable: false });
    assert.equal(result.outcome, 'transient');
  });

  test('List-Unsubscribe yalnız kapatılabilir postaya konur', async () => {
    /* Kapatılamayan bir postaya bu başlığı koymak, tutulmayacak bir söz
     * vermek olur: insan tıklar, hiçbir şey değişmez. */
    const { instance, seen } = sender(() => Response.json({ id: 'x' }));
    await instance.send({ to: 'a@example.test', subject: 's', bodyText: 'b', unsubscribable: true });
    await instance.send({ to: 'a@example.test', subject: 's', bodyText: 'b', unsubscribable: false });
    const bodies = await Promise.all(seen.map(async (request) => await request.json() as {
      headers?: Record<string, string>;
      reply_to?: string;
    }));
    assert.ok(bodies[0].headers?.['List-Unsubscribe'], 'duyuru postasında çıkış başlığı yok');
    assert.equal(bodies[1].headers, undefined, 'kapatılamayan postaya çıkış başlığı konmuş');
    assert.equal(bodies[0].reply_to, 'iletisim@example.test', 'yanıtlar insanın okuduğu kutuya gitmiyor');
  });

  test('anahtar eksikse gönderim kapalıdır ve bu bir arıza değildir', async () => {
    /* Yerel geliştirme, test ve staging bu hâlde çalışıyor. Kuyruk
     * yazılmaya devam eder, yalnız boşaltılmaz; gönderim açıldığında
     * bekleyenler gider. Sessizce "gönderildi" demek yalan olurdu. */
    assert.equal(createEmailSender({}), null);
    assert.equal(createEmailSender({ RESEND_API_KEY: 'k' }), null, 'gönderen adresi olmadan gönderim açılmış');
    assert.equal(createEmailSender({ RESEND_API_KEY: 'k', ORBIT_EMAIL_FROM: 'a@b.test' }), null);
    assert.ok(createEmailSender({
      RESEND_API_KEY: 'k', ORBIT_EMAIL_FROM: 'a@b.test', ORBIT_EMAIL_REPLY_TO: 'c@b.test',
    }));
  });

  test('posta metinleri kapatma yolunu doğru anlatır', async () => {
    const announcement = announcementEmail({
      title: 'Kota değişikliği', bodyMarkdown: 'Yayın kotası arttı.', severity: 'warning',
    });
    assert.match(announcement.subject, /^\[Uyarı\] /u);
    assert.match(announcement.bodyText, /dashboard adresinden kapatabilirsin/u);

    const moderation = recordRemovedEmail({ agentHandle: 'nyx', reason: 'kural ihlali' });
    /* Kapatılamayan postada sebebin yazılı olması lazım: kapatma yolunu
     * arayıp bulamayan insan spam işaretler, o da teslim itibarını bozar. */
    assert.match(moderation.bodyText, /kapatılamaz/u);
    assert.doesNotMatch(moderation.bodyText, /kapatabilirsin/u);
  });

  test('panel ile sunucu aynı seviye listesini kullanır', () => {
    /* Panel istemci tarafında olduğu için listeyi içe aktaramıyor, kopya
     * tutuyor. Kopya ayrışırsa kutu açık kalır, kişi postalanacağını
     * sanır ve sunucu 400 döner — yani kullanıcı hatası gibi görünen bir
     * bizim hatamız. Kaynak dosyadan okuyup karşılaştırıyoruz. */
    const client = readFileSync(new URL('../src/scripts/dashboard.js', import.meta.url), 'utf8');
    const match = client.match(/const ANNOUNCEMENT_EMAIL_SEVERITIES = \[([^\]]*)\]/u);
    assert.ok(match, 'panelde seviye listesi bulunamadı');
    const clientList = match[1].split(',')
      .map((part) => part.trim().replace(/^'|'$/gu, ''))
      .filter((part) => part !== '');
    assert.deepEqual(clientList, [...ANNOUNCEMENT_EMAIL_SEVERITIES]);
    assert.ok(!clientList.includes('info'), 'bilgi duyuruları postalanabilir görünüyor');
  });
});
