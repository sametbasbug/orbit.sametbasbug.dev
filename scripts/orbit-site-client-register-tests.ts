/* `orbit-site-client-register.mjs` sınamaları.
 *
 * En önemlisi ilk testtir: özet, Orbit'in KENDİ `hmacDigest`iyle
 * karşılaştırılıyor, yeniden yazılmış bir referansla değil. Betikteki
 * hesap Orbit'ten ayrılırsa satır sorunsuz yazılır ama istemci kimlik
 * doğrulaması sessizce reddedilir — üretimde teşhisi zor bir hata.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { hmacDigest } from '../src/server/identity/tokens';
import { sqlUret } from './orbit-site-client-register.mjs';
import {
  normalizeSiteClientDeclaration as ayariDogrula,
  siteClientSecretDigest,
} from '../src/server/identity/site-client-registration';

const GECERLI = {
  clientId: 'orbit-haber',
  label: 'Equinox Haber',
  siteUrl: 'https://haber.sametbasbug.dev',
  scopes: ['openid', 'profile'],
  redirectUris: ['https://haber.sametbasbug.dev/giris/orbit/donus'],
  environment: 'production',
};

test('özet Orbit\'in kendi hmacDigest\'iyle birebir aynı', async () => {
  for (const [sir, pepper] of [
    ['istemci-sirri-abcdefghijklmnopqrstuvwxyz', 'peper-1'],
    ['ünïcode-içeren-sır-ĞŞİıöç', 'peper-türkçe-ĞŞİ'],
    /* Boş sır bilerek var: özetin kendisi boş girdide de tanımlı olmalı.
     * Boş PEPER yok — WebCrypto sıfır uzunluklu HMAC anahtarını reddediyor
     * ve betik zaten boş peper'la çalışmayı en baştan kesiyor. */
    ['', 'peper'],
  ]) {
    const bizim = await siteClientSecretDigest(sir, pepper);
    // api.ts:4153'teki çağrının aynısı.
    const orbitin = await hmacDigest(`orbit:site-client-secret:v1:${sir}`, pepper);
    assert.equal(bizim, orbitin, `ayrışma: ${sir}`);
  }
});

test('özet base64url, dolgusuz ve 43 karakter — canlı satırla aynı biçim', async () => {
  const ozet = await siteClientSecretDigest('a'.repeat(48), 'peper');
  assert.equal(ozet.length, 43);
  assert.match(ozet, /^[A-Za-z0-9_-]+$/u);
});

test('alan öneki gerçekten uygulanıyor', async () => {
  const onekli = await siteClientSecretDigest('sir', 'peper');
  const oneksiz = await hmacDigest('sir', 'peper');
  assert.notEqual(onekli, oneksiz);
});

test('kapsamlar kanonik sıraya diziliyor', () => {
  const ayar = ayariDogrula({ ...GECERLI, scopes: ['profile', 'openid'] });
  assert.deepEqual(ayar.scopes, ['openid', 'profile']);
});

test('openid olmadan reddediliyor', () => {
  assert.throws(() => ayariDogrula({ ...GECERLI, scopes: ['profile'] }), /openid/u);
});

test('tanınmayan kapsam reddediliyor', () => {
  assert.throws(
    () => ayariDogrula({ ...GECERLI, scopes: ['openid', 'orbit.dm.read'] }),
    /unknown scope/u,
  );
});

test('parça taşıyan yönlendirme adresi reddediliyor', () => {
  assert.throws(
    () => ayariDogrula({ ...GECERLI, redirectUris: ['https://x.dev/geri#kod'] }),
    /fragment/u,
  );
});

test('production ortamında localhost reddediliyor', () => {
  assert.throws(
    () => ayariDogrula({ ...GECERLI, redirectUris: ['http://localhost:4321/geri'] }),
    /must be https/u,
  );
});

test('development ortamında localhost kabul ediliyor', () => {
  const ayar = ayariDogrula({
    ...GECERLI,
    environment: 'development',
    siteUrl: 'http://localhost:4321',
    redirectUris: ['http://localhost:4321/giris/orbit/donus'],
  });
  assert.equal(ayar.redirectUris.length, 1);
});

test('düz http uzak adres reddediliyor', () => {
  assert.throws(
    () => ayariDogrula({ ...GECERLI, redirectUris: ['http://haber.sametbasbug.dev/geri'] }),
    /must be https/u,
  );
});

test('SQL tek tırnağı kaçırıyor', () => {
  const ayar = ayariDogrula({ ...GECERLI, label: "Samet'in Haberi" });
  const sql = sqlUret({
    ayar, ozet: 'OZET', satirId: 'ID', yonlendirmeIdleri: ['R1'], simdi: 1,
  });
  assert.match(sql, /'Samet''in Haberi'/u);
});

test('SQL tek işlemde ve her yönlendirme adresi için satır üretiyor', () => {
  const ayar = ayariDogrula({
    ...GECERLI,
    redirectUris: ['https://haber.sametbasbug.dev/a', 'https://haber.sametbasbug.dev/b'],
  });
  const sql = sqlUret({
    ayar, ozet: 'OZET', satirId: 'ID', yonlendirmeIdleri: ['R1', 'R2'], simdi: 7,
  });
  assert.match(sql, /^BEGIN TRANSACTION;/u);
  assert.match(sql, /COMMIT;$/u);
  assert.equal(sql.match(/INSERT INTO oauth_client_redirect_uris/gu)?.length, 2);
  assert.match(sql, /'openid profile'/u);
  // hash_version sabiti SQL'e gerçekten giriyor mu.
  assert.match(sql, /'OZET', 1,/u);
});
