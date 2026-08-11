import type { SiteAuthorizationScope } from '../identity/site-authorization-scopes';

export {
  SITE_AUTHORIZATION_SCOPES,
  type SiteAuthorizationScope,
} from '../identity/site-authorization-scopes';

export interface SiteClientView {
  id: string;
  clientId: string;
  secretDigest: string;
  hashVersion: number;
  label: string;
  siteUrl: string;
  allowedScopes: SiteAuthorizationScope[];
  environment: 'production' | 'development';
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
  redirectUris: string[];
}

export interface SiteGrantView {
  id: string;
  clientId: string;
  clientLabel: string;
  clientSiteUrl: string;
  accountId: string;
  scopes: SiteAuthorizationScope[];
  consentVersion: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface SiteAuthorizationCodeView {
  id: string;
  grantId: string;
  codeDigest: string;
  hashVersion: number;
  redirectUri: string;
  pkceChallenge: string;
  nonce: string | null;
  scopes: SiteAuthorizationScope[];
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface SiteTokenView {
  id: string;
  grantId: string;
  tokenType: 'access' | 'refresh';
  secretDigest: string;
  hashVersion: number;
  replacedById: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

/* Anahtar çiftini doğrularken hesabın durumu da lazım: askıya alınmış bir
 * hesabın anahtarı geçerli görünmemeli. Ayrı bir sorgu yerine aynı okumada
 * geliyor — iki sorgu arasında hesabın askıya alınabileceği bir aralık
 * bırakmamak için. */
export interface SiteTokenResolution {
  token: SiteTokenView;
  grant: SiteGrantView;
  accountStatus: 'active' | 'suspended' | 'closed';
  clientStatus: 'active' | 'revoked';
  subject: string;
}

export interface SiteAuthorizationRepository {
  getClientByClientId(clientId: string): Promise<SiteClientView | null>;

  /* Site başına kimlik. Varsa mevcut olanı döndürüyor, yoksa verilen değeri
   * yazıyor. Kimliği çağıran üretiyor (evdeki desen: `createEntityId`), çünkü
   * rastgelelik repository'nin işi değil. */
  ensureSubject(input: {
    id: string;
    clientId: string;
    accountId: string;
    subject: string;
    createdAt: number;
  }): Promise<string>;

  getGrant(input: { clientId: string; accountId: string }): Promise<SiteGrantView | null>;

  getGrantById(grantId: string): Promise<SiteGrantView | null>;

  listAccountGrants(accountId: string): Promise<SiteGrantView[]>;

  /* Onay ekranının yazdığı yer: izin satırı (yeni ya da tazelenmiş) ve ona
   * bağlı tek kullanımlık kod aynı işlemde doğuyor. */
  recordConsentWithCode(input: {
    grant: {
      id: string;
      clientId: string;
      accountId: string;
      scopes: SiteAuthorizationScope[];
      consentVersion: string;
      now: number;
    };
    code: {
      id: string;
      codeDigest: string;
      hashVersion: number;
      redirectUri: string;
      pkceChallenge: string;
      nonce: string | null;
      scopes: SiteAuthorizationScope[];
      createdAt: number;
      expiresAt: number;
    };
    auditEventId: string;
    requestId: string;
  }): Promise<SiteGrantView>;

  getAuthorizationCodeByDigest(codeDigest: string): Promise<SiteAuthorizationCodeView | null>;

  /* Kodu tek kullanımlık yapan adım. Sonuç `false` ise kod ya yoktu, ya
   * süresi geçmişti, ya da daha önce kullanılmıştı — çağıran üçünü ayırt
   * etmeye çalışmıyor, hepsi reddedilecek. */
  consumeAuthorizationCode(input: { codeId: string; consumedAt: number }): Promise<boolean>;

  issueTokenPair(input: {
    grantId: string;
    access: { id: string; secretDigest: string; hashVersion: number; expiresAt: number };
    refresh: { id: string; secretDigest: string; hashVersion: number; expiresAt: number };
    /* Rotasyonda dolu: hangi yenileme anahtarının yerine geçtiği. */
    replacesRefreshTokenId: string | null;
    auditEventId: string;
    auditEventType: 'site.tokens_issued' | 'site.tokens_rotated';
    requestId: string;
    now: number;
  }): Promise<void>;

  resolveToken(input: {
    secretDigest: string;
    tokenType: 'access' | 'refresh';
  }): Promise<SiteTokenResolution | null>;

  /* Kullanılmış bir yenileme anahtarının ikinci kez gelmesi. Tek satırı değil
   * o izne ait bütün anahtarları düşürüyor: elimizde iki kopya olduğunu
   * biliyoruz ama hangisinin saldırganda olduğunu bilmiyoruz. */
  revokeGrantTokens(input: {
    grantId: string;
    reason: string;
    auditEventId: string;
    requestId: string;
    revokedAt: number;
  }): Promise<number>;

  markRefreshTokenUsed(input: {
    tokenId: string;
    usedAt: number;
  }): Promise<boolean>;

  touchGrant(input: { grantId: string; usedAt: number }): Promise<boolean>;

  /* Kullanıcının "bağlı siteler"den iptali. İzin ve bütün anahtarları aynı
   * işlemde düşüyor; ayrı adımlar olsaydı arada kalan anahtar iptalden sonra
   * 15 dakika daha yaşardı. */
  revokeGrant(input: {
    grantId: string;
    actorAccountId: string;
    reason: string;
    auditEventId: string;
    requestId: string;
    revokedAt: number;
  }): Promise<void>;

  deleteExpiredAuthorizationCodes(input: { deleteBefore: number }): Promise<number>;
}
