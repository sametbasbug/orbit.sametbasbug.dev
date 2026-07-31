import {
  isCanonicalMcpAuthorizationScopes,
  type McpAuthorizationScope,
} from './mcp-authorization-scopes';
import { hmacDigest, timingSafeEqual } from './tokens';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = 'orb_mcp_auth_v1';
const MAX_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface McpAuthorizationTicketPayload {
  authorizationRequestId: string;
  oauthClientId: string;
  oauthClientLabel: string;
  scopes: McpAuthorizationScope[];
  issuedAt: number;
  expiresAt: number;
}

function base64UrlEncode(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === 'string'
    && [...value].length > 0
    && [...value].length <= maximumCodePoints;
}

function isPayload(value: unknown): value is McpAuthorizationTicketPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [
    'authorizationRequestId',
    'expiresAt',
    'issuedAt',
    'oauthClientId',
    'oauthClientLabel',
    'scopes',
  ].sort().join(',')) return false;
  return boundedString(record.authorizationRequestId, 200)
    && boundedString(record.oauthClientId, 255)
    && boundedString(record.oauthClientLabel, 120)
    && isCanonicalMcpAuthorizationScopes(record.scopes)
    && Number.isSafeInteger(record.issuedAt)
    && Number.isSafeInteger(record.expiresAt)
    && Number(record.issuedAt) >= 0
    && Number(record.expiresAt) > Number(record.issuedAt)
    && Number(record.expiresAt) <= Number(record.issuedAt) + MAX_TTL_MS;
}

function canonicalPayload(payload: McpAuthorizationTicketPayload): string {
  return JSON.stringify({
    authorizationRequestId: payload.authorizationRequestId,
    oauthClientId: payload.oauthClientId,
    oauthClientLabel: payload.oauthClientLabel,
    scopes: payload.scopes,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function signingInput(encodedPayload: string): string {
  return `orbit:mcp:authorization-ticket:v1:${encodedPayload}`;
}

export async function createMcpAuthorizationTicket(
  payload: McpAuthorizationTicketPayload,
  secret: string,
): Promise<string> {
  if (!isPayload(payload)) throw new Error('invalid_mcp_authorization_ticket_payload');
  const encodedPayload = base64UrlEncode(canonicalPayload(payload));
  const signature = await hmacDigest(signingInput(encodedPayload), secret);
  return `${PREFIX}.${encodedPayload}.${signature}`;
}

export async function verifyMcpAuthorizationTicket(
  ticket: string,
  secret: string,
  now: number,
): Promise<McpAuthorizationTicketPayload | null> {
  const parts = ticket.split('.');
  if (
    parts.length !== 3
    || parts[0] !== PREFIX
    || !BASE64URL_PATTERN.test(parts[1] ?? '')
    || !BASE64URL_PATTERN.test(parts[2] ?? '')
  ) return null;

  const expected = await hmacDigest(signingInput(parts[1]), secret);
  if (!timingSafeEqual(expected, parts[2])) return null;
  const decoded = base64UrlDecode(parts[1]);
  if (decoded === null) return null;

  try {
    const payload = JSON.parse(decoded) as unknown;
    if (!isPayload(payload)) return null;
    if (payload.issuedAt > now + CLOCK_SKEW_MS || payload.expiresAt <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
