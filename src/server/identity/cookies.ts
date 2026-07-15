export interface CookieOptions {
  httpOnly?: boolean;
  maxAge?: number;
}

export function serializeHostCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join('; ');
}

export function clearHostCookie(name: string, httpOnly = false): string {
  return serializeHostCookie(name, '', { httpOnly, maxAge: 0 });
}

export function readCookie(request: Request, name: string): string | null {
  const source = request.headers.get('cookie');
  if (!source) return null;
  for (const item of source.split(';')) {
    const [candidate, ...rest] = item.trim().split('=');
    if (candidate === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}
