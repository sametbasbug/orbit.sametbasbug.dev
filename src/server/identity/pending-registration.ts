import type { AuthProvider, ProviderProfileSnapshot } from '../repositories/identity-repository';
import { hmacDigest, timingSafeEqual } from './tokens';

/* Kimliği doğrulanmış ama henüz hesabı olmayan kişinin bileti.
 *
 * Neden var: Google'da kullanıcı adı yok. GitHub'da handle kullanıcı adından
 * türüyordu ve kayıt callback'in içinde tek adımda bitiyordu; Google'da handle'ı
 * kullanıcı seçmek zorunda, yani doğrulanmış kimlikle açılmış hesap arasında
 * bir ekran duruyor. Bu bilet o aralığı taşıyor.
 *
 * Neden veritabanı satırı değil: satır olsaydı yeni bir tablo, yeni bir
 * temizlik işi ve yarıda bırakılmış her kayıt için bir çöp kayıt demekti.
 * Bilet imzalı ve süreli; sunucunun kendi ürettiği bir kanıt, tarayıcıdan
 * gelen bir iddia değil. Aynı kalıp `mcp-authorization-ticket` içinde zaten
 * var ve orada da aynı sebeple seçilmişti.
 *
 * Neden tekrar oynatılabilir olması sorun değil: bilet aynı sağlayıcı
 * kimliğini taşıyor ve şemadaki `(provider, provider_user_id)` tekilliği aynı
 * kimlikle ikinci hesabı reddediyor. Bilet kaç kez oynatılırsa oynatılsın en
 * fazla bir hesap doğuyor.
 *
 * ONAY bilette taşınıyor. Kişi Gizlilik Politikası ve Koşullar'ı Google'a
 * gitmeden ÖNCE onaylıyor, onay sunucuda akış satırına yazılıyor ve buraya
 * taşınıyor. Bileti üreten sunucu olduğu için bu, tarayıcının "kabul ettim"
 * demesinden farklı: kanıtı biz imzaladık. */

const PREFIX = 'orb_signup_v1';
/* On beş dakika. Akış satırının on dakikalık ömründen uzun olması kasıtlı:
 * o pencere Google'a gidip dönmeyi ölçüyor, bu pencere bir insanın kendine
 * isim seçmesini. İkisi aynı süre olsaydı, adını düşünen kullanıcı kaydın
 * sonunda kapıda kalırdı. */
const MAX_TTL_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PendingRegistrationPayload {
  provider: AuthProvider;
  profile: ProviderProfileSnapshot;
  termsAcceptedAt: number;
  termsVersion: string;
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

function isProfile(value: unknown): value is ProviderProfileSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'avatarUrl,displayName,email,login,userId') {
    return false;
  }
  return typeof record.userId === 'string' && record.userId.length > 0
    && typeof record.login === 'string' && record.login.length > 0
    && typeof record.displayName === 'string' && record.displayName.length > 0
    && (record.avatarUrl === null || typeof record.avatarUrl === 'string')
    && (record.email === null || typeof record.email === 'string');
}

function isPayload(value: unknown): value is PendingRegistrationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',')
    !== 'expiresAt,issuedAt,profile,provider,termsAcceptedAt,termsVersion') {
    return false;
  }
  return (record.provider === 'github' || record.provider === 'google')
    && isProfile(record.profile)
    && Number.isSafeInteger(record.termsAcceptedAt) && Number(record.termsAcceptedAt) > 0
    && typeof record.termsVersion === 'string' && record.termsVersion.length > 0
    && Number.isSafeInteger(record.issuedAt) && Number(record.issuedAt) >= 0
    && Number.isSafeInteger(record.expiresAt)
    && Number(record.expiresAt) > Number(record.issuedAt)
    && Number(record.expiresAt) <= Number(record.issuedAt) + MAX_TTL_MS;
}

/* Alan sırası sabit yazılıyor. `JSON.stringify` nesne anahtarlarını ekleme
 * sırasına göre yazıyor; imzalanan dize ile doğrulanan dize arasında sıra
 * farkı doğarsa imza tutmaz ve hata "geçersiz bilet" diye görünür — sebebi
 * görünmeyen bir hata. */
function canonicalPayload(payload: PendingRegistrationPayload): string {
  return JSON.stringify({
    provider: payload.provider,
    profile: {
      userId: payload.profile.userId,
      login: payload.profile.login,
      displayName: payload.profile.displayName,
      avatarUrl: payload.profile.avatarUrl,
      email: payload.profile.email,
    },
    termsAcceptedAt: payload.termsAcceptedAt,
    termsVersion: payload.termsVersion,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function signingInput(encodedPayload: string): string {
  return `orbit:pending-registration:v1:${encodedPayload}`;
}

export async function createPendingRegistration(
  payload: PendingRegistrationPayload,
  secret: string,
): Promise<string> {
  if (!isPayload(payload)) throw new Error('invalid_pending_registration_payload');
  const encodedPayload = base64UrlEncode(canonicalPayload(payload));
  const signature = await hmacDigest(signingInput(encodedPayload), secret);
  return `${PREFIX}.${encodedPayload}.${signature}`;
}

export async function verifyPendingRegistration(
  ticket: string,
  secret: string,
  now: number,
): Promise<PendingRegistrationPayload | null> {
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

export const PENDING_REGISTRATION_TTL_MS = MAX_TTL_MS;
