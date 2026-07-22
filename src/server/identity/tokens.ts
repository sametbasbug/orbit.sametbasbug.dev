import { TOKEN_HASH_VERSION } from './constants';

const encoder = new TextEncoder();
const TOKEN_PATTERN = /^(orb_(?:inv|sess|agent|reg)_v1)_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

export type TokenFamily = 'invitation' | 'session' | 'agent' | 'registration';

const PREFIXES: Record<TokenFamily, string> = {
  invitation: 'orb_inv_v1',
  session: 'orb_sess_v1',
  agent: 'orb_agent_v1',
  registration: 'orb_reg_v1',
};

const FAMILIES_BY_PREFIX = new Map(
  Object.entries(PREFIXES).map(([family, prefix]) => [prefix, family as TokenFamily]),
);

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function hmac(value: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

export interface GeneratedOpaqueToken {
  token: string;
  selector: string;
  secret: string;
  digest: string;
  hashVersion: number;
}

export interface ParsedOpaqueToken {
  family: TokenFamily;
  selector: string;
  secret: string;
}

export async function createOpaqueToken(
  family: TokenFamily,
  pepper: string,
): Promise<GeneratedOpaqueToken> {
  const selector = base64Url(randomBytes(16));
  const secret = base64Url(randomBytes(32));
  const token = `${PREFIXES[family]}_${selector}_${secret}`;
  return {
    token,
    selector,
    secret,
    digest: await digestOpaqueToken(family, selector, secret, pepper),
    hashVersion: TOKEN_HASH_VERSION,
  };
}

export function parseOpaqueToken(token: string): ParsedOpaqueToken | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const family = FAMILIES_BY_PREFIX.get(match[1]);
  if (!family) return null;
  return { family, selector: match[2], secret: match[3] };
}

export async function digestOpaqueToken(
  family: TokenFamily,
  selector: string,
  secret: string,
  pepper: string,
): Promise<string> {
  return await hmac(`orbit:${family}:v1:${selector}:${secret}`, pepper);
}

export async function verifyOpaqueToken(
  token: string,
  expectedFamily: TokenFamily,
  expectedDigest: string,
  pepper: string,
): Promise<ParsedOpaqueToken | null> {
  const parsed = parseOpaqueToken(token);
  if (!parsed || parsed.family !== expectedFamily) return null;
  const actual = await digestOpaqueToken(
    parsed.family,
    parsed.selector,
    parsed.secret,
    pepper,
  );
  return timingSafeEqual(actual, expectedDigest) ? parsed : null;
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length === 0 || b.length === 0) return false;
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  }
  return mismatch === 0;
}

export function randomBase64Url(bytes: number): string {
  return base64Url(randomBytes(bytes));
}

export async function sha256Base64Url(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : Uint8Array.from(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function hmacDigest(value: string, pepper: string): Promise<string> {
  return await hmac(value, pepper);
}
