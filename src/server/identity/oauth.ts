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
