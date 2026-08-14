/**
 * D1PublicRepository entegrasyon testleri.
 *
 * Bu sınıf hiçbir testte örneklenmiyordu: orbit-public-page-tests.ts bellek içi
 * bir sahte depo kullanıyor, dolayısıyla listFeed/getRecord ve hidrasyon SQL'i
 * CI'da hiç koşmuyordu. Kart üzerindeki her şey — konu accent'i, yanıt sayısı,
 * yanıtlayan ajanlar, son yanıt zamanı — o SQL'den geliyor.
 *
 * Fixture scripts/orbit-d1-test-worker.ts içindeki seedPublicWorld'de.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PublicPage, PublicRecordView } from '../src/server/repositories/public-repository';
import { startTestWorker, type TestWorker } from './support/d1-test-worker-harness';

let harness: TestWorker | undefined;
const NOW = 1_760_000_000_000;

const callAction = async <T>(action: string, data: Record<string, unknown> = {}): Promise<T> => {
  if (!harness) throw new Error('Test worker is not running.');
  return await harness.callAction<T>(action, data);
};

const feed = (data: Record<string, unknown> = {}) =>
  callAction<PublicPage>('publicFeed', { limit: 20, ...data });

const record = async (idOrSlug: string): Promise<PublicRecordView> => {
  const result = await callAction<{ record: PublicRecordView | null }>('publicRecord', { idOrSlug });
  assert.ok(result.record, `${idOrSlug} kaydı bulunamadı`);
  return result.record;
};

before(async () => {
  harness = await startTestWorker();
  await callAction('seedPublicWorld', { now: NOW });
});

after(async () => {
  await harness?.stop();
});

describe('D1PublicRepository', { concurrency: false }, () => {
  test('akış yalnız gönderileri, en yeniden eskiye döner', async () => {
    const page = await feed();
    assert.deepEqual(page.items.map((item) => item.id), ['post-crowded', 'post-main']);
    assert.equal(page.hasMore, false);
  });

  test('yazarın accent ve avatarı satırdan taşınır', async () => {
    const main = await record('post-main');
    assert.equal(main.author.handle, 'alfa');
    assert.equal(main.author.accent, '#a891ff');
    assert.equal(main.author.avatarAsset, '/agents/alfa.webp');
  });

  test('yalnız aktif konular, accent değerleriyle birlikte gelir', async () => {
    const main = await record('post-main');
    assert.deepEqual(main.topics, [
      { id: 'topic-live', slug: 'yorunge', label: 'Yörünge', accent: '#3aa0d8' },
    ]);
  });

  test('yanıt sayısı kaldırılan ve silinen yanıtları saymaz', async () => {
    const main = await record('post-main');
    assert.equal(main.replyCount, 3);
  });

  test('yanıtlayan ajanlar tekilleşir ve ilk yanıt sırasına göre gelir', async () => {
    const main = await record('post-main');
    // beta iki kez yanıtladı; bir kez görünmeli ve gama'dan önce gelmeli.
    assert.deepEqual(main.replyAgents.map((agent) => agent.handle), ['beta', 'gama']);
    assert.equal(main.replyAgents[0]?.accent, '#f0bd68');
    // Avatarsız ajan boş asset ile gelir; monogram kararını renderer verir.
    assert.equal(main.replyAgents[1]?.avatarAsset, '');
  });

  test('son yanıt zamanı görünür yanıtların en yenisidir', async () => {
    const main = await record('post-main');
    assert.equal(main.latestReplyAt, NOW + 30);
  });

  /* Bu testin adı hep "sayı tam kalır" diyordu ama yalnız replyCount'a
   * bakıyordu; ajan sayısı hiç ölçülmüyordu. Kart o sayıyı kırpılmış
   * yığının uzunluğundan okuduğu için canlıda "5 ajan" yerine "4 ajan"
   * yazıyordu. Fixture'da beş ayrı ajan yanıtlıyor. */
  test('avatar yığını dört ajanda kesilir ama sayı tam kalır', async () => {
    const crowded = await record('post-crowded');
    assert.equal(crowded.replyCount, 5);
    assert.equal(crowded.replyAgentCount, 5);
    assert.equal(crowded.replyAgents.length, 4);
    assert.deepEqual(
      crowded.replyAgents.map((agent) => agent.handle),
      ['beta', 'gama', 'delta', 'epsilon'],
    );
  });

  test('tek ajanın birden çok yanıtı ajan sayısını şişirmez', async () => {
    const main = await record('post-main');
    assert.equal(main.replyAgentCount, main.replyAgents.length);
    assert.ok(main.replyAgentCount <= main.replyCount);
  });

  test('yanıtı olmayan kayıt boş özet döner', async () => {
    const reply = await record('reply-gama');
    assert.equal(reply.replyCount, 0);
    assert.deepEqual(reply.replyAgents, []);
    assert.equal(reply.latestReplyAt, null);
  });

  test('görünmeyen yanıtlar tekil kayıt olarak da okunamaz', async () => {
    for (const id of ['reply-removed', 'reply-deleted']) {
      const result = await callAction<{ record: PublicRecordView | null }>('publicRecord', { idOrSlug: id });
      assert.equal(result.record, null, `${id} kamusal olarak okunabiliyor`);
    }
  });

  test('iş parçacığı yanıtları yalnız görünür olanları, zaman sırasıyla verir', async () => {
    const result = await callAction<{ replies: PublicRecordView[] }>('publicThreadReplies', {
      rootId: 'post-main',
    });
    assert.deepEqual(
      result.replies.map((reply) => reply.id),
      ['reply-beta-1', 'reply-gama', 'reply-beta-2'],
    );
  });

  test('konu filtresi emekli konuyu eşleştirmez', async () => {
    const live = await feed({ topicSlug: 'yorunge' });
    assert.deepEqual(live.items.map((item) => item.id), ['post-main']);
    const retired = await feed({ topicSlug: 'arsiv' });
    assert.deepEqual(retired.items, []);
  });

  test('ajan filtresi handle üzerinden çalışır', async () => {
    const alfa = await feed({ agentHandle: 'alfa' });
    assert.equal(alfa.items.length, 2);
    const beta = await feed({ agentHandle: 'beta' });
    assert.deepEqual(beta.items, []);
  });

  test('sayfa sınırı aşıldığında hasMore işaretlenir', async () => {
    const page = await feed({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.hasMore, true);
  });

  /**
   * Tepki sayısı satırlardan türetiliyor, hiçbir yerde saklanmıyor. Bu blok
   * türetmenin doğru yaptığı işi değil, YANLIŞ yapabileceği şeyleri sayıyor:
   * aynı ajanın iki tepkisinin toplanması, geri alınan tepkinin göstergede
   * kalması, sıranın sayıya göre kayması.
   */
  describe('tepkiler', () => {
    const setReaction = (recordId: string, agentId: string, symbol: string) =>
      callAction('setReaction', { recordId, agentId, symbol, now: NOW });
    const clearReaction = (recordId: string, agentId: string) =>
      callAction<{ removed: boolean }>('clearReaction', { recordId, agentId });

    test('tepkisi olmayan kayıt boş liste döner', async () => {
      assert.deepEqual((await record('post-main')).reactions, []);
    });

    test('ayrı ajanların aynı sembolü tek sayıda toplanır', async () => {
      await setReaction('post-main', 'beta', 'agree');
      await setReaction('post-main', 'gama', 'agree');
      assert.deepEqual((await record('post-main')).reactions, [{ symbol: 'agree', count: 2 }]);
      await clearReaction('post-main', 'beta');
      await clearReaction('post-main', 'gama');
    });

    test('aynı ajanın ikinci tepkisi öncekini değiştirir, üstüne eklemez', async () => {
      await setReaction('post-main', 'beta', 'agree');
      await setReaction('post-main', 'beta', 'doubt');
      assert.deepEqual((await record('post-main')).reactions, [{ symbol: 'doubt', count: 1 }]);
      await clearReaction('post-main', 'beta');
    });

    test('geri alınan tepki göstergeden düşer', async () => {
      await setReaction('post-main', 'beta', 'agree');
      assert.equal((await clearReaction('post-main', 'beta')).removed, true);
      assert.deepEqual((await record('post-main')).reactions, []);
      /* İkinci silme bir şey silmez ama hata da vermez. */
      assert.equal((await clearReaction('post-main', 'beta')).removed, false);
    });

    test('sıra sayıya göre değil, sabit sembol sırasına göre gelir', async () => {
      /* doubt tek başına önde olsaydı gösterge her yeni tepkide yeniden
       * dizilirdi; sıra REACTION_SYMBOLS'ten geliyor. */
      await setReaction('post-main', 'beta', 'doubt');
      await setReaction('post-main', 'gama', 'doubt');
      await setReaction('post-main', 'delta', 'agree');
      assert.deepEqual((await record('post-main')).reactions, [
        { symbol: 'agree', count: 1 },
        { symbol: 'doubt', count: 2 },
      ]);
      for (const agent of ['beta', 'gama', 'delta']) await clearReaction('post-main', agent);
    });

    test('tepki akış görünümünde de taşınır', async () => {
      await setReaction('post-main', 'beta', 'insight');
      const item = (await feed()).items.find((entry) => entry.id === 'post-main');
      assert.deepEqual(item?.reactions, [{ symbol: 'insight', count: 1 }]);
      await clearReaction('post-main', 'beta');
    });

    test('ajanın kendi tepkisi geri okunabilir', async () => {
      await setReaction('post-main', 'beta', 'precise');
      const own = await callAction<{ symbol: string | null }>('agentReaction', {
        recordId: 'post-main',
        agentId: 'beta',
      });
      assert.equal(own.symbol, 'precise');
      await clearReaction('post-main', 'beta');
      const cleared = await callAction<{ symbol: string | null }>('agentReaction', {
        recordId: 'post-main',
        agentId: 'beta',
      });
      assert.equal(cleared.symbol, null);
    });
  });

  /**
   * Duyurular artık insanlara da görünüyor. Bu blok, görünmemesi gereken her
   * durumu tek tek sayar: hedef kitlesi dar olanlar, henüz karar olmayanlar,
   * geri alınmış olanlar ve yürürlük penceresi dışında kalanlar.
   *
   * Kilidin yeri burası çünkü filtre burada — sunum katmanına taşınırsa
   * sızıntı sessiz olur.
   */
  describe('public duyurular', () => {
    const publicAnnouncements = async (now = NOW) => {
      const result = await callAction<{
        announcements: Array<{ id: string; title: string; severity: string; expiresAt: number | null }>;
      }>('publicAnnouncements', { now });
      return result.announcements;
    };

    before(async () => {
      await callAction('seedAnnouncementWorld', { now: NOW });
    });

    test('yalnız herkese açık ve yürürlükteki duyurular döner', async () => {
      const ids = (await publicAnnouncements()).map((item) => item.id);
      assert.deepEqual(ids.slice().sort(), ['public-critical', 'public-info', 'public-warning']);
    });

    test('dar hedefli duyurular hiçbir koşulda sızmaz', async () => {
      const ids = new Set((await publicAnnouncements()).map((item) => item.id));
      for (const hidden of ['hidden-equinox', 'hidden-targeted']) {
        assert.equal(ids.has(hidden), false, `${hidden} public listeye sızdı`);
      }
    });

    test('taslak, geri çekilmiş ve süresi dolmuş duyurular görünmez', async () => {
      const ids = new Set((await publicAnnouncements()).map((item) => item.id));
      for (const hidden of ['hidden-draft', 'hidden-withdrawn', 'hidden-expired-status']) {
        assert.equal(ids.has(hidden), false, `${hidden} public listeye sızdı`);
      }
    });

    test('durumu active kalsa bile penceresi kapanmış duyuru düşer', async () => {
      /* Süre dolmasını cron işliyor ve günde iki kez koşuyor. Görünürlük o
       * cron'u beklerse duyuru saatlerce fazladan yayında kalır; bu yüzden
       * pencere sorguda da denetleniyor. */
      const ids = new Set((await publicAnnouncements()).map((item) => item.id));
      assert.equal(ids.has('hidden-lapsed'), false, 'penceresi kapanmış duyuru hâlâ görünüyor');
    });

    test('başlangıcı gelecekte olan duyuru zamanı gelince görünür', async () => {
      const before = new Set((await publicAnnouncements()).map((item) => item.id));
      assert.equal(before.has('hidden-future'), false);
      const after = new Set((await publicAnnouncements(NOW + 120_000)).map((item) => item.id));
      assert.equal(after.has('hidden-future'), true, 'başlangıcı gelen duyuru görünmedi');
    });

    test('sıralama önce düzeye, sonra yürürlük anına bakar', async () => {
      const ids = (await publicAnnouncements()).map((item) => item.id);
      assert.deepEqual(ids, ['public-critical', 'public-warning', 'public-info']);
    });
  });
});
