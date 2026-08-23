import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SiteActionCatalogError,
  normalizeSiteActionCatalog,
  validateOperationInput,
} from '../src/server/identity/site-action-catalog';
import {
  SITE_ACTION_SCOPE,
  signSiteActionToken,
} from '../src/server/identity/site-action-token';
import { importSiteSigningKey } from '../src/server/identity/site-id-token';

/* Bağlı site eylemlerinin sözleşmesi.
 *
 * Buradaki iddiaların çoğu REDDETME yolları. Sebebi şu: katalog dosyası
 * Orbit'e ait değil, siteye ait. Orbit onu okuyup hem ajana sunuyor hem de
 * kendi girdi doğrulamasında çalıştırıyor. Yani o dosyaya güvenmek, başkasının
 * yazdığı şemayı kendi kodumuz olarak koşturmak demek.
 */

const gecerliKatalog = {
  version: 1,
  operations: [
    {
      operationId: 'rota.listeyeEkle',
      summary: 'Listeye anime ekler.',
      idempotent: true,
      input: {
        type: 'object',
        required: ['animeId', 'durum'],
        additionalProperties: false,
        properties: {
          animeId: { type: 'string', maxLength: 300 },
          durum: { enum: ['IZLIYOR', 'BITTI', 'PLANLI', 'BIRAKTI'] },
          puan: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
  ],
};

function reddedilmeli(katalog: unknown, neden: string) {
  assert.throws(
    () => normalizeSiteActionCatalog(katalog),
    SiteActionCatalogError,
    neden,
  );
}

describe('bağlı site eylem kataloğu', () => {
  test('geçerli katalog kabul ediliyor', () => {
    const parsed = normalizeSiteActionCatalog(gecerliKatalog);
    assert.equal(parsed.operations.length, 1);
    assert.equal(parsed.operations[0].operationId, 'rota.listeyeEkle');
    assert.equal(parsed.operations[0].idempotent, true);
  });

  test('katalogdaki actionsEndpoint yok sayılıyor, hata vermiyor', () => {
    /* Adres kayıttan okunuyor. Kontratın erken sürümüne göre dosya hazırlamış
       bir site yüzünden kataloğun tamamı düşmemeli — ama o alanın gövdedeki
       değeri de hiçbir şeyi etkilememeli. */
    const parsed = normalizeSiteActionCatalog({
      ...gecerliKatalog,
      actionsEndpoint: 'https://saldirgan.example/al',
    });
    assert.equal(parsed.operations.length, 1);
    assert.ok(!('actionsEndpoint' in parsed));
  });

  test('şema dilinin dışına çıkan anahtarlar reddediliyor', () => {
    /* Bu üçü tesadüfen seçilmedi: `$ref` uzak adres çeker, `pattern` düzenli
       ifade çalıştırır (ReDoS), `allOf` iç içe geçip doğrulayıcıyı patlatır.
       Ajanın gördüğü şema aynı zamanda BİZİM koşturduğumuz şema. */
    for (const kotu of [{ $ref: 'https://x/y' }, { pattern: '(a+)+$' }, { allOf: [] }]) {
      reddedilmeli(
        { version: 1, operations: [{ ...gecerliKatalog.operations[0], input: kotu }] },
        `${Object.keys(kotu)[0]} kabul edilmemeli`,
      );
    }
  });

  test('aşırı derin şema reddediliyor', () => {
    let derin: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 12; i += 1) {
      derin = { type: 'object', properties: { alt: derin } };
    }
    reddedilmeli(
      { version: 1, operations: [{ ...gecerliKatalog.operations[0], input: derin }] },
      'özyinelemeli doğrulayıcı yığını taşırabilir',
    );
  });

  test('yinelenen operationId reddediliyor', () => {
    reddedilmeli(
      { version: 1, operations: [gecerliKatalog.operations[0], gecerliKatalog.operations[0]] },
      'hangi işlemin çalışacağı belirsiz kalır',
    );
  });

  test('biçimsiz operationId reddediliyor', () => {
    for (const kotu of ['listeyeEkle', 'rota..ekle', 'rota.', '.ekle', 'ro ta.ekle']) {
      reddedilmeli(
        { version: 1, operations: [{ ...gecerliKatalog.operations[0], operationId: kotu }] },
        `${kotu} reddedilmeli`,
      );
    }
  });

  test('boş katalog ve yanlış sürüm reddediliyor', () => {
    reddedilmeli({ version: 1, operations: [] }, 'boş katalog');
    reddedilmeli({ version: 2, operations: gecerliKatalog.operations }, 'bilinmeyen sürüm');
    reddedilmeli(null, 'nesne olmayan katalog');
  });
});

describe('girdi doğrulaması', () => {
  const schema = gecerliKatalog.operations[0].input;

  test('geçerli girdi geçiyor', () => {
    validateOperationInput({ animeId: 'kitsu:1376', durum: 'IZLIYOR' }, schema);
    validateOperationInput({ animeId: 'kitsu:1376', durum: 'BITTI', puan: 9 }, schema);
  });

  test('eksik zorunlu alan reddediliyor', () => {
    assert.throws(() => validateOperationInput({ animeId: 'x' }, schema), SiteActionCatalogError);
  });

  test('tanımsız alan reddediliyor', () => {
    /* Ajanın uydurduğu bir alanı sessizce siteye taşımak, sitenin beklemediği
       bir şeyi yazmasına yol açabilir. */
    assert.throws(
      () => validateOperationInput({ animeId: 'x', durum: 'IZLIYOR', gizli: true }, schema),
      SiteActionCatalogError,
    );
  });

  test('additionalProperties belirtilmemişse de kapalı', () => {
    const acikUnutulmus = { type: 'object', properties: { a: { type: 'string' } } };
    assert.throws(
      () => validateOperationInput({ a: 'x', b: 'y' }, acikUnutulmus),
      SiteActionCatalogError,
      'varsayılan kapalı olmalı; şemayı yazan siteye güvenip açık bırakmıyoruz',
    );
  });

  test('enum dışı değer reddediliyor', () => {
    assert.throws(
      () => validateOperationInput({ animeId: 'x', durum: 'HERHANGI' }, schema),
      SiteActionCatalogError,
    );
  });

  test('sayı sınırları uygulanıyor', () => {
    for (const puan of [0, 11, 5.5]) {
      assert.throws(
        () => validateOperationInput({ animeId: 'x', durum: 'BITTI', puan }, schema),
        SiteActionCatalogError,
        `puan ${puan} reddedilmeli`,
      );
    }
  });

  test('metin uzunluğu uygulanıyor', () => {
    assert.throws(
      () => validateOperationInput({ animeId: 'x'.repeat(301), durum: 'BITTI' }, schema),
      SiteActionCatalogError,
    );
  });
});

describe('devretme belgesi', () => {
  test('belge işlemi taşıyor ve aktörü kaybetmiyor', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const key = await importSiteSigningKey(JSON.stringify({ ...jwk, kid: 'k1' }));

    const now = 1_760_000_000_000;
    const token = await signSiteActionToken(key, {
      issuer: 'https://orbit.sametbasbug.dev',
      audience: 'orbit-equinox-rota',
      subject: 'pairwise-abc',
      actorAgentId: 'agent-1',
      actorHandle: 'selene',
      operationId: 'rota.listeyeEkle',
      tokenId: 'jti-1',
      issuedAt: now,
      expiresAt: now + 60_000,
    });

    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
    assert.equal(claims.aud, 'orbit-equinox-rota', 'belge başka siteye taşınamamalı');
    assert.equal(claims.sub, 'pairwise-abc', 'site kullanıcıyı girişte gördüğü kimlikle bulmalı');
    assert.equal(claims.scope, SITE_ACTION_SCOPE);
    /* İşlem belgeye gömülü: bir işlem için alınmış belge, gövdesi
       değiştirilerek başka bir işleme çevrilememeli. */
    assert.equal(claims.operation, 'rota.listeyeEkle');
    /* İş insanın adına ama kimin yaptığı kaybolmuyor. */
    assert.equal(claims.act.sub, 'agent:agent-1');
    assert.equal(claims.act.handle, 'selene');
    assert.equal(claims.exp - claims.iat, 60, 'ömür 60 saniye');

    const dogru = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    assert.ok(dogru, 'imza gerçekten doğrulanmalı; sahte bir yeşil işe yaramaz');
  });
});
