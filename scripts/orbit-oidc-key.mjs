#!/usr/bin/env node
/**
 * Alt site giriş kapısının ID token imza anahtarını üretir (Plan 008).
 *
 * Çıktı, ORBIT_OIDC_SIGNING_KEY_V1 secret'ına girecek olan JSON Web Key:
 * P-256 özel anahtarı, `kid` dahil. Açık anahtar bundan türetiliyor ve
 * /.well-known/jwks.json üzerinden yayınlanıyor; ayrıca saklanması gereken
 * ikinci bir yapılandırma satırı yok.
 *
 * Bu script anahtarı YALNIZ stdout'a yazar. Bilerek: bir sırrı dosyaya yazmak,
 * onu yedeklere, editör geçmişine ve depoya sızabilecek bir yere koymak demek.
 * Kullanım:
 *
 *   node scripts/orbit-oidc-key.mjs | npx wrangler secret put ORBIT_OIDC_SIGNING_KEY_V1 --config wrangler.staging.jsonc
 *
 * `kid` tarihli: anahtar değişimi ekleme yoluyla yapılıyor (yeni anahtar
 * yayınlanır, eski bir süre JWKS'te kalır, sonra düşer) ve hangi anahtarın ne
 * zaman doğduğu `kid`den okunabilmeli.
 */
import { webcrypto } from 'node:crypto';

const pair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const stamp = new Date().toISOString().slice(0, 10);

/* Alan sırası sabit: aynı anahtarın iki farklı metin hâli olmasın. */
const output = {
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
  d: jwk.d,
  kid: `orbit-oidc-${stamp}`,
};

process.stdout.write(`${JSON.stringify(output)}\n`);
