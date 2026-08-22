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
 * ÜRETİM İÇİN BU BETİK DEĞİL, `POST /v1/site-clients` KULLANILIYOR: özet
 * peper'la hesaplanıyor ve peper bir Worker sırrı, geri okunamıyor. Uç onu
 * Worker'ın içinde hesaplıyor, yani peper hiç dışarı çıkmıyor.
 *
 * Betik YEREL GELİŞTİRME için duruyor: elinde çalışan bir Orbit ve
 * `platform_owner` oturumu yokken yerel D1'e istemci eklemenin kısa yolu.
 * Doğrulama ve özet hesabı ucun kullandığı modülden geliyor, yani iki yol
 * aynı kuralları uyguluyor.
 *
 * SIRLAR STDIN'DEN GELİR, ARGÜMANDAN DEĞİL. Komut satırı argümanları
 * `ps` çıktısında ve kabuk geçmişinde görünür. Betik ne peper'ı ne de
 * istemci sırrını EKRANA BASAR; çıktıda yalnız özet vardır.
 *
 * Kullanım (tsx ile — düz `node` uzantısız TS import'unu çözemiyor):
 *   printf '%s\n%s\n' "$PEPPER" "$CLIENT_SECRET" \
 *     | npm run site-client:sql -- ayar.json
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

/* Doğrulama ve özet ucun kullandığı modülden. İkinci bir kopya olsaydı biri
 * gevşetildiğinde hangi kuralın geçerli olduğu, isteğin hangi yoldan geldiğine
 * bağlı hale gelirdi. */
import {
  MIN_CLIENT_SECRET_LENGTH,
  normalizeSiteClientDeclaration,
  siteClientSecretDigest,
} from '../src/server/identity/site-client-registration.ts';

/* `TOKEN_HASH_VERSION` ile aynı olmak zorunda. */
const TOKEN_HASH_VERSION = 1;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/* SQL metin kaçışı. Değerler doğrulamadan geçiyor ama tek tırnak yine de
 * kaçırılıyor: doğrulamayı gevşetecek bir sonraki değişiklik burayı
 * hatırlamayabilir. */
function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
  if (istemciSirri.length < MIN_CLIENT_SECRET_LENGTH) {
    console.error(`istemci sırrı en az ${MIN_CLIENT_SECRET_LENGTH} karakter olmalı (öneri: openssl rand -base64 48)`);
    process.exit(2);
  }

  const ayar = normalizeSiteClientDeclaration(JSON.parse(readFileSync(yol, 'utf-8')));
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
