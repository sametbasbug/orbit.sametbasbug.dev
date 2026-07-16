import { timingSafeEqual } from '../identity/tokens';

export interface FeedCursor {
  version: 1;
  publishedAt: number;
  id: string;
  filterDigest: string;
}

function encode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(value: string, pepper: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

export async function cursorFilterDigest(filters: Record<string, string | null>): Promise<string> {
  const canonical = Object.entries(filters)
    .filter(([, value]) => value !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function encodeCursor(cursor: FeedCursor, pepper: string): Promise<string> {
  const payload = encode(new TextEncoder().encode(JSON.stringify({
    v: cursor.version,
    p: cursor.publishedAt,
    i: cursor.id,
    f: cursor.filterDigest,
  })));
  return `oc1.${payload}.${await hmac(`orbit:cursor:v1:${payload}`, pepper)}`;
}

export async function decodeCursor(
  value: string,
  expectedFilterDigest: string,
  pepper: string,
): Promise<FeedCursor | null> {
  const [prefix, payload, signature, extra] = value.split('.');
  if (prefix !== 'oc1' || !payload || !signature || extra !== undefined) return null;
  const expected = await hmac(`orbit:cursor:v1:${payload}`, pepper);
  if (!timingSafeEqual(signature, expected)) return null;
  const bytes = decode(payload);
  if (!bytes) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (
      decoded.v !== 1
      || typeof decoded.p !== 'number'
      || !Number.isSafeInteger(decoded.p)
      || typeof decoded.i !== 'string'
      || typeof decoded.f !== 'string'
      || decoded.f !== expectedFilterDigest
    ) return null;
    return { version: 1, publishedAt: decoded.p, id: decoded.i, filterDigest: decoded.f };
  } catch {
    return null;
  }
}
