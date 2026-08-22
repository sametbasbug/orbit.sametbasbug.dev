/* Alt site istemcisinin kaydı — doğrulama ve özet.
 *
 * Tek doğruluk kaynağı: hem `POST /v1/site-clients` ucu hem
 * `scripts/orbit-site-client-register.mjs` buradan besleniyor. İki kopya
 * olsaydı biri gevşetildiğinde diğeri sıkı kalırdı ve hangisinin geçerli
 * olduğu, isteğin hangi yoldan geldiğine bağlı hale gelirdi.
 */

import { SITE_AUTHORIZATION_SCOPES, type SiteAuthorizationScope } from './site-authorization-scopes';
import { hmacDigest } from './tokens';

export interface SiteClientDeclaration {
  clientId: string;
  label: string;
  siteUrl: string;
  scopes: SiteAuthorizationScope[];
  redirectUris: string[];
  environment: 'production' | 'development';
}

/* İstemci sırrının alt sınırı. Güçlü bir imza, zayıf bir sırla anlamsızdır;
 * ve bu sır bir insanın akılda tutacağı şey değil, üretilip bir kasaya
 * konacak şey. */
export const MIN_CLIENT_SECRET_LENGTH = 32;

export function siteClientSecretDigest(secret: string, pepper: string): Promise<string> {
  /* Alan öneki: aynı peper'la üretilen başka bir özetin bu alanda geçerli
   * olmasını engelliyor. api.ts bunu aynen çağırıyordu; buraya taşındı. */
  return hmacDigest(`orbit:site-client-secret:v1:${secret}`, pepper);
}

export class SiteClientDeclarationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`site_client_declaration_invalid: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

/** Bildirimi doğrular ve kanonik biçimde döner.
 *
 * Kapsamlar kanonik SIRAYA diziliyor: veritabanına boşlukla ayrılmış tek metin
 * olarak yazılıyorlar ve sıra serbest olsaydı 'profile openid' ile
 * 'openid profile' iki farklı satır olurdu. */
export function normalizeSiteClientDeclaration(value: unknown): SiteClientDeclaration {
  const problems: string[] = [];
  const input = (value ?? {}) as Record<string, unknown>;
  const { clientId, label, siteUrl, scopes, redirectUris, environment } = input;

  if (typeof clientId !== 'string' || clientId.trim().length < 8 || clientId.length > 255) {
    problems.push('clientId must be 8-255 characters');
  }
  if (typeof label !== 'string' || label.trim().length < 1 || label.length > 120) {
    problems.push('label must be 1-120 characters');
  }
  if (environment !== 'production' && environment !== 'development') {
    problems.push("environment must be 'production' or 'development'");
  }
  if (typeof siteUrl !== 'string'
    || !(siteUrl.startsWith('https://') || siteUrl.startsWith('http://localhost'))) {
    problems.push('siteUrl must start with https:// or http://localhost');
  }

  let normalizedScopes: SiteAuthorizationScope[] = [];
  if (!Array.isArray(scopes) || scopes.length === 0) {
    problems.push('scopes must be a non-empty array');
  } else {
    const unknown = scopes.filter(
      (scope) => !SITE_AUTHORIZATION_SCOPES.includes(scope as SiteAuthorizationScope),
    );
    if (unknown.length > 0) problems.push(`unknown scope: ${unknown.join(', ')}`);
    if (new Set(scopes).size !== scopes.length) problems.push('scopes contains duplicates');
    /* `openid` zorunlu: `sub` claim'i onunla geliyor ve `sub` olmadan site
     * kullanıcıyı hiç tanıyamaz. */
    if (!scopes.includes('openid')) problems.push("scopes must include 'openid'");
    normalizedScopes = SITE_AUTHORIZATION_SCOPES.filter(
      (scope) => scopes.includes(scope),
    ) as SiteAuthorizationScope[];
  }

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    problems.push('redirectUris must be a non-empty array');
  } else {
    for (const uri of redirectUris) {
      if (typeof uri !== 'string') {
        problems.push('redirect_uri must be a string');
        continue;
      }
      /* 0041'in tetikleyicisi bunu zaten reddediyor; burada da reddetmenin
       * sebebi hata mesajının SQLite'tan değil buradan gelmesi. */
      if (uri.includes('#')) problems.push(`redirect_uri must not carry a fragment: ${uri}`);
      if (uri.length < 8 || uri.length > 500) {
        problems.push(`redirect_uri must be 8-500 characters: ${uri}`);
      }
      const localDev = environment === 'development' && uri.startsWith('http://localhost');
      if (!uri.startsWith('https://') && !localDev) {
        problems.push(`redirect_uri must be https:// (localhost only for development): ${uri}`);
      }
    }
    if (new Set(redirectUris).size !== redirectUris.length) {
      problems.push('redirectUris contains duplicates');
    }
  }

  if (problems.length > 0) throw new SiteClientDeclarationError(problems);

  return {
    clientId: (clientId as string).trim(),
    label: (label as string).trim(),
    siteUrl: siteUrl as string,
    environment: environment as 'production' | 'development',
    redirectUris: redirectUris as string[],
    scopes: normalizedScopes,
  };
}
