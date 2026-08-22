#!/usr/bin/env node
/* Orbit'e yeni bir alt site istemcisi kaydetmek için SQL üretir.
 *
 * NEDEN BİR BETİK: 0041 dinamik kaydı bilerek kapattı — kendi kendine
 * kaydolabilen bir istemci yüzeyi, onay ekranında rastgele bir ismin
 * görünmesine izin vermek demekti. Ama karşılığında kayıt hiç
 * belgelenmedi: `oauth_clients`e satır ekleyen tek kod bir test worker'ı.
 * Anime elle girilmiş ve nasıl girildiği hiçbir yerde yazmıyor. Her
 * Equinox sitesini Orbit'e bağlayacaksak bu adımın tekrarlanabilir olması
 * gerekiyor.
 *
 * NEDEN SQL BASIYOR, VERİTABANINA YAZMIYOR: yazmak için üretim
 * kimlik bilgisi gerekirdi. Betik yalnız metin üretiyor; nereye
 * uygulanacağına operatör karar veriyor ve komutu kendi gözüyle görüyor.
 *
 * SIRLAR STDIN'DEN GELİR, ARGÜMANDAN DEĞİL. Komut satırı argümanları
 * `ps` çıktısında ve kabuk geçmişinde görünür. Betik ne peper'ı ne de
 * istemci sırrını EKRANA BASAR; çıktıda yalnız özet vardır.
 *
 * Kullanım:
 *   printf '%s\n%s\n' "$PEPPER" "$CLIENT_SECRET" \
 *     | node scripts/orbit-site-client-register.mjs ayar.json
 *
 * `ayar.json` biçimi:
 *   {
 *     "clientId": "orbit-haber",
 *     "label": "Equinox Haber",
 *     "siteUrl": "https://haber.sametbasbug.dev",
 *     "scopes": ["openid", "profile"],
 *     "redirectUris": ["https://haber.sametbasbug.dev/giris/orbit/donus"],
 *     "environment": "production"
 *   }
 */

import { readFileSync } from 'node:fs';

/* Orbit'in `TOKEN_HASH_VERSION` sabitiyle aynı olmak ZORUNDA. Ayrıştığı gün
 * satır yazılır ama istemci kimlik doğrulaması sessizce reddedilir. */
const TOKEN_HASH_VERSION = 1;

/* `site-authorization-scopes.ts` ile aynı liste ve aynı SIRA. Sıra önemli:
 * kapsamlar veritabanına kanonik sırayla, boşlukla ayrılmış tek metin olarak
 * yazılıyor; 'profile openid' ile 'openid profile' iki farklı satır olurdu. */
const SITE_AUTHORIZATION_SCOPES = [
  'openid',
  'profile',
  'email',
  'orbit.graph.read',
  'orbit.posts.read',
];

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/* api.ts:4153 ile birebir aynı: HMAC-SHA256, base64url, dolgusuz, ve aynı
 * alan öneki. Önek olmadan aynı peper'la üretilen başka bir özet bu alanda
 * geçerli olurdu. */
export async function siteClientSecretDigest(secret, pepper) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const imza = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`orbit:site-client-secret:v1:${secret}`),
  );
  return base64Url(new Uint8Array(imza));
}

/* SQL metin kaçışı. Değerler doğrulamadan geçiyor ama tek tırnak yine de
 * kaçırılıyor: doğrulamayı gevşetecek bir sonraki değişiklik burayı
 * hatırlamayabilir. */
function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function ayariDogrula(ayar) {
  const hatalar = [];
  const { clientId, label, siteUrl, scopes, redirectUris, environment } = ayar;

  if (typeof clientId !== 'string' || clientId.trim().length < 8 || clientId.length > 255) {
    hatalar.push('clientId 8-255 karakter olmalı');
  }
  if (typeof label !== 'string' || label.trim().length < 1 || label.length > 120) {
    hatalar.push('label 1-120 karakter olmalı');
  }
  if (environment !== 'production' && environment !== 'development') {
    hatalar.push("environment 'production' veya 'development' olmalı");
  }
  if (typeof siteUrl !== 'string'
    || !(siteUrl.startsWith('https://') || siteUrl.startsWith('http://localhost'))) {
    hatalar.push('siteUrl https:// veya http://localhost ile başlamalı');
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    hatalar.push('scopes boş olamaz');
  } else {
    const taninmayan = scopes.filter((s) => !SITE_AUTHORIZATION_SCOPES.includes(s));
    if (taninmayan.length > 0) hatalar.push(`tanınmayan kapsam: ${taninmayan.join(', ')}`);
    /* `openid` zorunlu: `sub` claim'i onunla geliyor ve `sub` olmadan site
     * kullanıcıyı tanıyamaz. */
    if (!scopes.includes('openid')) hatalar.push("scopes 'openid' içermeli");
    if (new Set(scopes).size !== scopes.length) hatalar.push('scopes tekrar içeriyor');
  }

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    hatalar.push('redirectUris boş olamaz');
  } else {
    for (const uri of redirectUris) {
      /* Tetikleyicinin (0041) reddedeceği adresi buraya kadar getirmiyoruz:
       * hata mesajını SQLite'tan değil buradan almak daha anlaşılır. */
      if (typeof uri !== 'string' || uri.includes('#')) {
        hatalar.push(`redirect_uri parça (#) taşıyamaz: ${uri}`);
        continue;
      }
      if (uri.length < 8 || uri.length > 500) {
        hatalar.push(`redirect_uri 8-500 karakter olmalı: ${uri}`);
      }
      const yerelGelistirme = environment === 'development' && uri.startsWith('http://localhost');
      if (!uri.startsWith('https://') && !yerelGelistirme) {
        hatalar.push(`redirect_uri https:// olmalı (localhost yalnız development'ta): ${uri}`);
      }
    }
  }

  if (hatalar.length > 0) throw new Error(`ayar geçersiz:\n  - ${hatalar.join('\n  - ')}`);

  /* Kanonik sıraya diziliyor; girdideki sıra yok sayılıyor. */
  return {
    clientId: clientId.trim(),
    label: label.trim(),
    siteUrl,
    environment,
    redirectUris,
    scopes: SITE_AUTHORIZATION_SCOPES.filter((s) => scopes.includes(s)),
  };
}

export function sqlUret({ ayar, ozet, satirId, yonlendirmeIdleri, simdi }) {
  const satirlar = [
    'BEGIN TRANSACTION;',
    '',
    'INSERT INTO oauth_clients (',
    '  id, client_id, secret_digest, hash_version, label, site_url,',
    '  allowed_scopes, environment, status, created_at',
    ') VALUES (',
    `  ${q(satirId)}, ${q(ayar.clientId)}, ${q(ozet)}, ${TOKEN_HASH_VERSION},`,
    `  ${q(ayar.label)}, ${q(ayar.siteUrl)},`,
    `  ${q(ayar.scopes.join(' '))}, ${q(ayar.environment)}, 'active', ${simdi}`,
    ');',
    '',
  ];
  ayar.redirectUris.forEach((uri, i) => {
    satirlar.push(
      'INSERT INTO oauth_client_redirect_uris (id, client_id, redirect_uri, created_at)',
      `VALUES (${q(yonlendirmeIdleri[i])}, ${q(satirId)}, ${q(uri)}, ${simdi});`,
      '',
    );
  });
  satirlar.push('COMMIT;');
  return satirlar.join('\n');
}

function kimlikUret() {
  return base64Url(crypto.getRandomValues(new Uint8Array(18)));
}

async function main() {
  const yol = process.argv[2];
  if (!yol) {
    console.error('kullanım: … | node scripts/orbit-site-client-register.mjs <ayar.json>');
    process.exit(2);
  }

  const girdi = readFileSync(0, 'utf-8').split('\n');
  const pepper = girdi[0]?.trim() ?? '';
  const istemciSirri = girdi[1]?.trim() ?? '';
  if (!pepper || !istemciSirri) {
    console.error('stdin iki satır bekliyor: 1) ORBIT_SITE_TOKEN_PEPPER_V1  2) istemci sırrı');
    process.exit(2);
  }
  /* Zayıf bir istemci sırrı, güçlü bir imzayı anlamsız kılar. */
  if (istemciSirri.length < 32) {
    console.error('istemci sırrı en az 32 karakter olmalı (öneri: openssl rand -base64 48)');
    process.exit(2);
  }

  const ayar = ayariDogrula(JSON.parse(readFileSync(yol, 'utf-8')));
  const ozet = await siteClientSecretDigest(istemciSirri, pepper);

  console.log(sqlUret({
    ayar,
    ozet,
    satirId: kimlikUret(),
    yonlendirmeIdleri: ayar.redirectUris.map(() => kimlikUret()),
    simdi: Date.now(),
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((hata) => {
    console.error(String(hata.message ?? hata));
    process.exit(1);
  });
}
