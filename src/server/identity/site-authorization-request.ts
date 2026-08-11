/* Onay ekranından geri dönen isteğin imzalı hâli.
 *
 * Neden bir bilet: onay ekranı bir form ve formdan dönen her alan kullanıcının
 * (ya da sayfaya müdahale eden birinin) değiştirebileceği bir alandır. Kapsamı,
 * yönlendirme adresini ve PKCE sorusunu gizli input olarak taşısaydık, "izin
 * ver"e basan kişi aslında ekranda okuduğundan başka bir şeye izin vermiş
 * olabilirdi — ekranda `openid` yazarken gövdede `orbit.posts.read` gidebilirdi.
 *
 * Bilet /authorize içinde sunucuda doğuyor, HMAC ile imzalanıyor ve
 * /consent'te yeniden doğrulanıyor. Yani onay ekranının gösterdiği şey ile
 * kaydedilen şeyin aynı olduğunu imza garanti ediyor.
 *
 * Desen MCP tarafından geliyor (`mcp-authorization-ticket.ts`); oradaki bilet
 * bir ajana yetki verirken aynı işi yapıyor. */

import {
  normalizeSiteAuthorizationScopes,
  type SiteAuthorizationScope,
} from './site-authorization-scopes';
import { hmacDigest, timingSafeEqual } from './tokens';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = 'orb_site_req_v1';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
/* Onay ekranı bu kadar süre açık kalabilir. Kısa tutmanın bedeli yok: süresi
 * geçen bilet kullanıcıyı siteye geri gönderiyor ve site akışı yeniden
 * başlatıyor — kaybedilen tek şey bir tık. */
const MAX_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export interface SiteAuthorizationRequest {
  /* Veritabanındaki istemci satırının kimliği; `client_id` değil. Bilet
   * doğrulandıktan sonra ikinci bir arama yapmamak için. */
  clientRowId: string;
  clientId: string;
  redirectUri: string;
  scopes: SiteAuthorizationScope[];
  /* İstemcinin gönderdiği `state` — geri dönerken birebir iade ediliyor. */
  state: string;
  codeChallenge: string;
  nonce: string | null;
  issuedAt: number;
  expiresAt: number;
}

function base64UrlEncode(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    return decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum;
}

function isRequest(value: unknown): value is SiteAuthorizationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  /* Alan kümesi tam eşleşmeli. Fazladan bir alan, ileride eklenen bir alanın
   * eski biletlerde sessizce tanımsız kalmasına açık kapı bırakırdı. */
  const expected = [
    'clientId', 'clientRowId', 'codeChallenge', 'expiresAt', 'issuedAt',
    'nonce', 'redirectUri', 'scopes', 'state',
  ];
  if (Object.keys(record).sort().join(',') !== expected.sort().join(',')) return false;

  return boundedString(record.clientRowId, 200)
    && boundedString(record.clientId, 255)
    && boundedString(record.redirectUri, 500)
    && boundedString(record.state, 500)
    && boundedString(record.codeChallenge, 128)
    && (record.nonce === null || boundedString(record.nonce, 200))
    && Array.isArray(record.scopes)
    && typeof record.issuedAt === 'number'
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.issuedAt)
    && Number.isFinite(record.expiresAt);
}

export async function createSiteAuthorizationRequestTicket(
  request: SiteAuthorizationRequest,
  pepper: string,
): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify({
    clientRowId: request.clientRowId,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    scopes: normalizeSiteAuthorizationScopes(request.scopes),
    state: request.state,
    codeChallenge: request.codeChallenge,
    nonce: request.nonce,
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
  }));
  const signature = await hmacDigest(`orbit:site-authorization-request:v1:${payload}`, pepper);
  return `${PREFIX}.${payload}.${signature}`;
}

export async function verifySiteAuthorizationRequestTicket(
  ticket: string,
  pepper: string,
  now: number,
): Promise<SiteAuthorizationRequest | null> {
  const [prefix, payload, signature, extra] = ticket.split('.');
  if (extra !== undefined || prefix !== PREFIX || !payload || !signature) return null;

  const expected = await hmacDigest(`orbit:site-authorization-request:v1:${payload}`, pepper);
  if (!timingSafeEqual(signature, expected)) return null;

  const decoded = base64UrlDecode(payload);
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!isRequest(parsed)) return null;

  /* Kapsamlar tekrar normalize ediliyor: imza payload'ı bağlıyor ama içindeki
   * listenin kanonik olduğunu bağlamıyor, ve kanonik olmayan bir liste
   * veritabanındaki izinle karşılaştırıldığında yanlış cevap verir. */
  let scopes: SiteAuthorizationScope[];
  try {
    scopes = normalizeSiteAuthorizationScopes(parsed.scopes);
  } catch {
    return null;
  }

  if (parsed.expiresAt <= parsed.issuedAt) return null;
  if (parsed.expiresAt - parsed.issuedAt > MAX_TTL_MS) return null;
  if (parsed.issuedAt - CLOCK_SKEW_MS > now) return null;
  if (parsed.expiresAt <= now) return null;

  return { ...parsed, scopes };
}
