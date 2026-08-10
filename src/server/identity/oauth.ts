import { hmacDigest, randomBase64Url, sha256Base64Url, timingSafeEqual } from './tokens';

export interface OAuthMaterial {
  selector: string;
  state: string;
  stateDigest: string;
  verifier: string;
  verifierDigest: string;
  challenge: string;
  cookie: string;
}

export async function createOAuthMaterial(pepper: string, expiresAt: number): Promise<OAuthMaterial> {
  const selector = randomBase64Url(16);
  const stateSecret = randomBase64Url(32);
  const state = `${selector}.${stateSecret}`;
  const verifier = randomBase64Url(32);
  const cookiePayload = `${selector}.${verifier}.${expiresAt}`;
  const signature = await hmacDigest(`orbit:oauth-cookie:v1:${cookiePayload}`, pepper);
  return {
    selector,
    state,
    stateDigest: await hmacDigest(`orbit:oauth-state:v1:${state}`, pepper),
    verifier,
    verifierDigest: await hmacDigest(`orbit:pkce:v1:${selector}:${verifier}`, pepper),
    challenge: await sha256Base64Url(verifier),
    cookie: `${cookiePayload}.${signature}`,
  };
}

export async function parseOAuthState(
  state: string,
  expectedDigest: string,
  pepper: string,
): Promise<{ selector: string } | null> {
  const [selector, secret, extra] = state.split('.');
  if (extra !== undefined || !selector || !secret) return null;
  const actual = await hmacDigest(`orbit:oauth-state:v1:${state}`, pepper);
  return timingSafeEqual(actual, expectedDigest) ? { selector } : null;
}

export async function parseOAuthCookie(
  value: string,
  expectedSelector: string,
  expectedVerifierDigest: string,
  pepper: string,
  now: number,
): Promise<{ verifier: string } | null> {
  const [selector, verifier, expiresAtValue, signature, extra] = value.split('.');
  if (extra !== undefined || !selector || !verifier || !expiresAtValue || !signature) return null;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || selector !== expectedSelector) return null;
  const payload = `${selector}.${verifier}.${expiresAtValue}`;
  const expectedSignature = await hmacDigest(`orbit:oauth-cookie:v1:${payload}`, pepper);
  if (!timingSafeEqual(signature, expectedSignature)) return null;
  const verifierDigest = await hmacDigest(`orbit:pkce:v1:${selector}:${verifier}`, pepper);
  return timingSafeEqual(verifierDigest, expectedVerifierDigest) ? { verifier } : null;
}

/* Hesap bağlama niyeti. GEÇİCİ: mevcut üç hesap Google kimliğini bağlayana
 * kadar yaşayacak, sonra bu iki fonksiyon ve onları çağıran uç birlikte
 * silinecek.
 *
 * Neden imzalı bir çerez, neden şemaya bir sütun değil: bağlama akışı geçici
 * ve şemaya eklenen bir sütun geçici olmaz. Kayıt bileti de aynı sebeple
 * imzalı bir taşıyıcı; buradaki fark sadece yükün küçüklüğü.
 *
 * Neden var: bu çerez olmadan "giriş yapmış birinin Google'a gidip dönmesi"
 * ile "bağlamak istemesi" ayırt edilemezdi. O ayrım güvenlik meselesi —
 * bağlantı isteğini kurbanın tarayıcısına yaptırabilen biri, KENDİ Google
 * hesabını kurbanın Orbit hesabına bağlayıp kalıcı erişim kazanırdı. Bu
 * yüzden niyet, oturumu doğrulanmış ve CSRF korumalı bir POST'ta doğuyor ve
 * hangi hesabı bağladığını imzalı olarak taşıyor. */
export async function createLinkCookie(
  accountId: string,
  expiresAt: number,
  pepper: string,
): Promise<string> {
  const payload = `${accountId}.${expiresAt}`;
  const signature = await hmacDigest(`orbit:account-link:v1:${payload}`, pepper);
  return `${payload}.${signature}`;
}

export async function parseLinkCookie(
  value: string,
  pepper: string,
  now: number,
): Promise<{ accountId: string } | null> {
  const [accountId, expiresAtValue, signature, extra] = value.split('.');
  if (extra !== undefined || !accountId || !expiresAtValue || !signature) return null;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const expected = await hmacDigest(`orbit:account-link:v1:${accountId}.${expiresAtValue}`, pepper);
  return timingSafeEqual(signature, expected) ? { accountId } : null;
}
