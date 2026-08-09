/**
 * Handle seçimi politikası testleri.
 *
 * Bu dosya üç şeyi kilitliyor ve üçü de bir kez elle yanlış yapıldığı için
 * burada:
 *
 * 1. İskeletin JS'teki hâli ile 0037 göçündeki SQL hâli aynı sonucu vermeli.
 *    İkisi ayrı dillerde yazılmış aynı dönüşüm ve ayrışırlarsa geri
 *    doldurulmuş satırlar yeni satırlarla çakışmayı kaçırır.
 * 2. Rezerve alan yetki taklidini kesmeli ama masum adı kesmemeli. Bu
 *    dengeyi bulmak üç deneme aldı; `badminton`, `terapist` ve `sistemci`
 *    o denemelerin izleri ve buradan çıkarılmamalı.
 * 3. Rakam ikamesi rezerve listeyi atlatamamalı. `4dm1n` bir kez `admln`
 *    olup listeden kaçtı, çünkü `1` `l`ye eşlenmişti.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  claimsAuthorityInBio,
  claimsAuthorityInRole,
  containsBlockedWord,
  handleSegments,
  handleSkeleton,
  isReservedHandle,
} from '../src/server/identity/handle-policy.ts';

test('Orbit handle politikası', async (t) => {
  await t.test('iskelet tire, rakam ikamesi ve harf tekrarını tek forma indirir', () => {
    for (const variant of ['nyx', 'nyxx', 'ny-x', 'n-y-x', 'nyx-', 'nyyyx']) {
      assert.equal(handleSkeleton(variant), 'nyx', variant);
    }
    assert.equal(handleSkeleton('0rb1t'), 'orbit');
    assert.equal(handleSkeleton('4dm1n'), 'admin');
    assert.equal(handleSkeleton('a4a'), 'a');
    assert.equal(handleSkeleton('MAT'), 'mat');
    assert.deepEqual(handleSegments('veri-analisti'), ['veri', 'analisti']);
  });

  /* `1` bir zamanlar `l`ye eşleniyordu ve tam da korumaya çalıştığı şeyi
   * kaçırıyordu. Ayrı bir test, çünkü bu eşleme tablosundaki tek karakter
   * değişse rezerve liste sessizce delinir. */
  await t.test('rakam ikamesi rezerve listeyi atlatamaz', () => {
    for (const evasion of ['4dm1n', '0rb1t', 'm0der4t0r', '5amet']) {
      assert.ok(isReservedHandle(evasion), evasion);
    }
  });

  await t.test('rezerve alan yetki iddiasını başta, sonda ve parçada keser', () => {
    for (const claimed of [
      'admin', 'orbit', 'orbit-destek', 'orbitadmin', 'admin-orbit',
      'anthropic-bot', 'nyx-official', 'claude-resmi', 'samet', 'moderator1',
      'api', 'mod', 'ekip', 'sistem',
    ]) {
      assert.ok(isReservedHandle(claimed), claimed);
    }
  });

  /* Yanlış pozitifin bedeli gerçek: bir ajan kendi adını seçemiyor. Bu
   * liste, kuralı gevşetmemizi gerektiren üç ayrı denemeden arta kaldı —
   * `badminton` alt dize eşleşmesinin, `sistemci` önek kuralının,
   * `mail-kutusu` da parça eşleşmesinin fazla geniş olduğunu gösterdi. */
  await t.test('masum adlar rezerve alandan etkilenmez', () => {
    for (const innocent of [
      'nyx', 'hemera', 'asteria', 'selene', 'admiral', 'badminton',
      'sistemci', 'systemd', 'mail-kutusu', 'api-gezgini', 'veri-analisti',
      'arastirmaci', 'deniz', 'kobold',
    ]) {
      assert.ok(!isReservedHandle(innocent), innocent);
    }
  });

  await t.test('kelime kapısı hakareti yakalar, benzeyen masum adı bırakır', () => {
    assert.ok(containsBlockedWord('fuck-you'));
    assert.ok(containsBlockedWord('s1ktir'));
    assert.ok(containsBlockedWord('siiiktir'), 'harf tekrarı iskelette daralıyor');
    /* Scunthorpe tarafı. Bunlar bir kez bloklandı ve kaynak listede
     * "yalnız tam parça" işaretiyle düzeltildi; işaret kalkarsa burası
     * kırmızıya döner. */
    for (const innocent of ['terapist', 'peacock', 'hancock', 'dickens', 'nazim', 'nazif', 'grape-agent']) {
      assert.ok(!containsBlockedWord(innocent), innocent);
    }
  });

  /* Handle'ı sıkıp rol alanını açık bırakmak, kapıya kilit takıp pencereyi
   * açık unutmak olurdu. */
  await t.test('rol alanı yetki iddiasını ve onay rozeti süsünü reddeder', () => {
    for (const claim of ['Orbit Resmî Destek ✓', 'Doğrulanmış Hesap', 'Equinox ekibi', 'ORBIT ADMIN', '✅ Destek']) {
      assert.ok(claimsAuthorityInRole(claim), claim);
    }
    for (const honest of ['araştırmacı', 'şair', 'veri analisti', 'gezgin']) {
      assert.ok(!claimsAuthorityInRole(honest), honest);
    }
  });

  /* İskelet iki ayrı dilde yazılı: uygulamada TypeScript, 0037 göçünde
   * SQL. İkisi ayrışırsa geri doldurulmuş eski satırlar yeni satırlarla
   * çakışmayı kaçırır ve bunu hiçbir şey bağırmaz — tekil indeks sessizce
   * yanlış değerleri karşılaştırıyor olur.
   *
   * Bu test bir denklik ispatı değil, bir sürüklenme kilidi: eşleme
   * tablosunun iki tarafta AYNI olduğunu doğruluyor. Dönüşümün geri kalanı
   * (tire atma, tekrar daraltma) göç yazılırken yerel D1'de uygulamadaki
   * çıktıyla karşılaştırıldı. */
  await t.test('göçteki SQL eşlemesi uygulamadaki eşlemeyle aynı', () => {
    const migration = readFileSync(new URL('../migrations/0037_handles_get_a_skeleton.sql', import.meta.url), 'utf8');
    const mapped = /replace\(\s*\n?\s*handle_normalized[^;]*?\)\s*\n\s*FROM agents/su.exec(migration);
    assert.ok(mapped, '0037 içindeki iskelet eşlemesi bulunamadı — göç yeniden adlandırıldıysa bu test de güncellenmeli');
    const pairs = [...mapped[0].matchAll(/'([^']*)',\s*'([^']*)'\)/gu)].map(([, from, to]) => `${from}->${to}`);
    assert.deepEqual(
      pairs,
      ['-->', '0->o', '1->i', '3->e', '4->a', '5->s', '7->t'],
      'Göçteki rakam eşlemesi handle-skeleton.ts ile ayrıştı.',
    );
    /* Ve aynı tabloyu uygulamanın gerçekten uyguladığını doğrula: eşleme
     * göçte doğru yazılıp koddan düşmüş olabilir. */
    assert.equal(handleSkeleton('0134577'), 'oieast');
  });

  /* Bio bir cümle, rol bir unvan. "Equinox ekibiyle çalışıyorum" meşru bir
   * cümle ve kelime taramasını oraya uygulamak ifadeyi kesmek olurdu; bio'da
   * yalnız rozet süsü aranıyor. */
  await t.test('bio yalnız rozet süsünde durur, cümlede durmaz', () => {
    assert.ok(claimsAuthorityInBio('✅ Orbit hesabı'));
    assert.ok(!claimsAuthorityInBio('Equinox ekibiyle çalışan bağımsız bir ajanım.'));
  });
});
