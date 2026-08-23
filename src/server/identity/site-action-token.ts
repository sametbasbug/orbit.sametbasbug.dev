import type { SiteSigningKey } from './site-id-token';

/* Orbit'in bağlı bir siteye "bu ajan, bu insanın adına, şu işi yapabilir"
 * dediği belge.
 *
 * Kimlik belgesiyle (`site-id-token.ts`) aynı anahtarlarla imzalanıyor ve aynı
 * JWKS'ten doğrulanıyor. İkinci bir anahtar seti kurmadık: siteye ikinci bir
 * anahtar kaynağı öğretmek, ikinci bir döndürme ve iptal yolu demek olurdu.
 *
 * Siteyle PAYLAŞILAN KALICI SIR YOK. Sızacak bir şey olmasın diye; sitenin
 * doğrulama için ihtiyacı olan tek şey herkese açık JWKS.
 */

const encoder = new TextEncoder();

/* Belge ömrü. Ajan bunu saklamıyor — ChatGPT Web gibi istemcilerde konuşmalar
 * arasında kalıcı depo yok ve olsaydı bile saklamasını istemezdik: insan
 * panelden ajan erişimini kapattığında ortada yaşamaya devam eden bir anahtar
 * kalmamalı. Orbit her çağrıda yenisini üretiyor, o yüzden 60 saniye bol. */
export const SITE_ACTION_TOKEN_TTL_MS = 60_000;

export const SITE_ACTION_SCOPE = 'site.actions';

export interface SiteActionTokenClaims {
  issuer: string;
  /** Sitenin `client_id`'si. Belge başka bir siteye taşınamaz. */
  audience: string;
  /** Sitenin o insan için tanıdığı pairwise kimlik — girişte gördüğüyle aynı. */
  subject: string;
  /** İşi yapan ajan. İş insanın adına ama kimin yaptığı kaybolmuyor. */
  actorAgentId: string;
  actorHandle: string;
  /** Belgenin izin verdiği TEK işlem. */
  operationId: string;
  /** Tek kullanımlık kimlik; site tekrar oynatmayı buradan yakalayabilir. */
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

export async function signSiteActionToken(
  key: SiteSigningKey,
  claims: SiteActionTokenClaims,
): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT', kid: key.kid };

  /* `iat`/`exp` saniye, Orbit'in geri kalanı milisaniye. Karıştırmak 1970'te
   * sona eren ya da 50 bin yıl yaşayan bir belge demek; ikisi de sessizce
   * yanlış. Kimlik belgesindeki aynı tuzak. */
  const payload = {
    iss: claims.issuer,
    aud: claims.audience,
    sub: claims.subject,
    /* RFC 8693 "actor": işi insan adına yapan taraf. Site isterse kaydeder;
     * kaydetmese de Orbit tarafında denetim izi duruyor. */
    act: { sub: `agent:${claims.actorAgentId}`, handle: claims.actorHandle },
    scope: SITE_ACTION_SCOPE,
    /* İşlem belgeye GÖMÜLÜ. Bir işlem için alınmış belge, gövdesi
     * değiştirilerek başka bir işleme çevrilemesin diye — aksi halde
     * "listeyi oku" izni "listeyi sil"e dönüşürdü. */
    operation: claims.operationId,
    jti: claims.tokenId,
    iat: Math.floor(claims.issuedAt / 1000),
    exp: Math.floor(claims.expiresAt / 1000),
  };

  const signingInput = `${base64UrlFromString(JSON.stringify(header))}`
    + `.${base64UrlFromString(JSON.stringify(payload))}`;

  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    encoder.encode(signingInput),
  ));

  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}
