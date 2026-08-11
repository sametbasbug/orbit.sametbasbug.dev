/* Alt sitelere verilen ID token'ın imzası, JWKS ve keşif belgesi.
 *
 * İmza asimetrik (ES256) ve bu bir tercih değil, şart: Supabase custom OIDC
 * sağlayıcısı simetrik imzayı (HS256) kabul etmiyor ve doğrulama anahtarını
 * keşif belgesindeki `jwks_uri` üzerinden kendisi çekiyor. Simetrik imza
 * seçseydik her istemciye kendi sırrımızı vermemiz gerekirdi — yani her yeni
 * site, imzayı taklit edebilecek bir taraf olurdu.
 *
 * Anahtar bir sır olarak duruyor ve JSON Web Key biçiminde: özel anahtarla
 * açık anahtar aynı yapıdan türetiliyor, yani JWKS için ikinci bir
 * yapılandırma satırı yok. İkiye ayırmak, birini döndürüp diğerini unutmanın
 * mümkün olduğu bir durum yaratırdı. */

import type { SiteAuthorizationScope } from './site-authorization-scopes';

const encoder = new TextEncoder();

export interface SiteSigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, string>;
}

export interface SiteIdTokenClaims {
  issuer: string;
  subject: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string | null;
  /* Kapsamın izin verdiği profil alanları. Hangi alanın gireceğine çağıran
   * karar veriyor; burada verilmeyen alan token'a hiç yazılmıyor. */
  name?: string;
  preferredUsername?: string;
  picture?: string | null;
  email?: string | null;
  emailVerified?: boolean;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(encoder.encode(value));
}

const JWK_PRIVATE_FIELDS = ['kty', 'crv', 'x', 'y', 'd', 'kid'] as const;

/* Sırdaki anahtarı okur. Katı: eksik alanlı, yanlış eğrili veya `kid`siz bir
 * anahtar hata veriyor.
 *
 * `kid` zorunlu, çünkü anahtar değişimi ekleme yoluyla yapılıyor: yeni anahtar
 * yayınlanıyor, eski bir süre JWKS'te kalıyor, sonra düşüyor. `kid` olmadan
 * doğrulayan taraf hangi anahtarı deneyeceğini bilemez — ve Supabase `kid`
 * bekliyor. */
export async function importSiteSigningKey(secret: string): Promise<SiteSigningKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('site_signing_key_not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('site_signing_key_not_object');
  }
  const record = parsed as Record<string, unknown>;
  for (const field of JWK_PRIVATE_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) {
      throw new Error(`site_signing_key_missing:${field}`);
    }
  }
  if (record.kty !== 'EC') throw new Error('site_signing_key_unsupported_kty');
  if (record.crv !== 'P-256') throw new Error('site_signing_key_unsupported_curve');

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: record.x as string,
      y: record.y as string,
      d: record.d as string,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  return {
    kid: record.kid as string,
    privateKey,
    /* Açık anahtar özel alanı (`d`) taşımıyor. Bu satır JWKS'e giden şey ve
     * `d`'yi buradan elemek tek bir yerde yapılıyor — her çağıranın kendi
     * elemesine bırakılsaydı bir gün biri unuturdu ve özel anahtar public bir
     * uçtan yayınlanırdı. */
    publicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: record.x as string,
      y: record.y as string,
      kid: record.kid as string,
      use: 'sig',
      alg: 'ES256',
    },
  };
}

export async function signSiteIdToken(
  key: SiteSigningKey,
  claims: SiteIdTokenClaims,
): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT', kid: key.kid };

  /* Saniye cinsinden: JWT'nin `exp`, `iat` alanları saniye sayıyor, Orbit'in
   * geri kalanı milisaniye. Karıştırmak, 1970'te sona eren ya da 50 bin yıl
   * yaşayan bir token demek — ikisi de sessizce yanlış. */
  const payload: Record<string, unknown> = {
    iss: claims.issuer,
    sub: claims.subject,
    aud: claims.audience,
    iat: Math.floor(claims.issuedAt / 1000),
    exp: Math.floor(claims.expiresAt / 1000),
  };
  if (claims.nonce !== null) payload.nonce = claims.nonce;
  if (claims.name !== undefined) payload.name = claims.name;
  if (claims.preferredUsername !== undefined) payload.preferred_username = claims.preferredUsername;
  if (claims.picture !== undefined && claims.picture !== null) payload.picture = claims.picture;
  if (claims.email !== undefined && claims.email !== null) {
    payload.email = claims.email;
    payload.email_verified = claims.emailVerified === true;
  }

  const signingInput = `${base64UrlFromString(JSON.stringify(header))}`
    + `.${base64UrlFromString(JSON.stringify(payload))}`;

  /* Web Crypto ECDSA imzası zaten ham r||s (64 bayt) döndürüyor — JWS'in
   * istediği biçim bu. DER'e çevirmek gerekmiyor; çevirmek bozardı. */
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    encoder.encode(signingInput),
  ));

  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}

export function siteJwks(keys: readonly SiteSigningKey[]): { keys: Array<Record<string, string>> } {
  return { keys: keys.map((key) => key.publicJwk) };
}

export interface SiteDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  scopes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  claims_supported: string[];
}

/* Keşif belgesi. Supabase bunu `{issuer}/.well-known/openid-configuration`
 * adresinden çekiyor ve uçları buradan öğreniyor; elle uç adresi girilen bir
 * yapılandırma yok. Yani bu belgedeki bir yazım hatası, "giriş çalışmıyor"
 * diye görünür ve sebebini söylemez.
 *
 * `subject_types_supported` yalnız `pairwise`: her istemci aynı insanı farklı
 * bir `sub` ile görüyor ve public (ortak) kimlik hiç sunulmuyor. */
export function siteDiscoveryDocument(
  issuer: string,
  scopes: readonly SiteAuthorizationScope[],
): SiteDiscoveryDocument {
  return {
    issuer,
    authorization_endpoint: `${issuer}/v1/oauth/authorize`,
    token_endpoint: `${issuer}/v1/oauth/token`,
    userinfo_endpoint: `${issuer}/v1/oauth/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['ES256'],
    scopes_supported: [...scopes],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    /* İstemci sırrı gövdede ya da Basic başlığında; ikisi de kabul, çünkü
     * istemci kütüphaneleri ikisini de kullanıyor. Sırsız (public) istemci
     * yok: her site sunucu tarafında bir sır tutabiliyor. */
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'iss', 'sub', 'aud', 'iat', 'exp', 'nonce',
      'name', 'preferred_username', 'picture', 'email', 'email_verified',
    ],
  };
}
