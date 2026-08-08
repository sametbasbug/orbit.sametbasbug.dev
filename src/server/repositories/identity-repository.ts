import type { ConnectionTrace } from '../identity/connection';

export interface OAuthFlowRow {
  id: string;
  stateDigest: string;
  pkceVerifierDigest: string;
  redirectUri: string;
  /* Kişinin Gizlilik Politikası ve Kullanım Koşulları'nı onayladığı an ve
   * onayladığı metnin sürümü. Akış satırına yazılıyor çünkü akış satırı
   * sunucuda doğuyor: tarayıcıdan gelen bir "kabul ettim" kanıt değil, ama
   * /start içinde yazılmış bir satır kanıt. Dönüşte bu alanlar boşsa giriş
   * tamamlanmıyor. */
  termsAcceptedAt: number | null;
  termsVersion: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

/* Bir giriş anında kaydedilen onay. Hem kayıtta hem her girişte yazılıyor:
 * elimizdeki değer "bir zamanlar kabul etmişti" değil, "en son ne zaman ve
 * hangi metni". Koşullar değiştiğinde kimin yeni metni gördüğünü de bu
 * cevaplıyor. */
export interface TermsConsent {
  acceptedAt: number;
  version: string;
}

export interface GithubIdentityRow {
  identityId: string;
  accountId: string;
  providerUserId: string;
  accountStatus: 'active' | 'suspended' | 'closed';
}

export interface SessionView {
  sessionId: string;
  accountId: string;
  secretDigest: string;
  hashVersion: number;
  csrfDigest: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt: number | null;
  accountStatus: 'active' | 'suspended' | 'closed';
}

export interface AccountView {
  id: string;
  /**
   * Orbit'in kendi hesap tanımlayıcısı. Kayıt anında GitHub kullanıcı adından
   * türetilir ama ondan bağımsızdır ve benzersizlik kısıtı taşır; GitHub'daki
   * ad değiştiğinde bu alan değişmez.
   */
  handle: string;
  /**
   * GitHub'daki güncel kullanıcı adı. Her girişte tazelenir. Kullanıcıya
   * "GitHub hesabın" diye bir şey gösteriliyorsa gösterilmesi gereken budur.
   */
  githubLogin: string | null;
  displayName: string;
  avatarUrl: string | null;
  roles: string[];
  agentQuota: number;
  /* Duyuru postalarını almak isteyip istemediği. Yalnız duyuruyu kapsar:
   * hesap, moderasyon ve güvenlik bildirimleri kapatılamaz. */
  announcementEmails: boolean;
}

export interface NewSessionRow {
  id: string;
  secretDigest: string;
  hashVersion: number;
  csrfDigest: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface GithubProfileSnapshot {
  userId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  /* GitHub'ın doğruladığı birincil adres. Kullanıcı izni vermezse veya
   * doğrulanmış adresi yoksa null kalır ve giriş yine tamamlanır: adres
   * bir kolaylık, kimlik değil. Kimliği taşıyan alan userId. */
  email: string | null;
}

/* Bir giriş anının bağlantı izi. Girişle aynı batch'te yazılıyor: giriş
 * başarılıysa iz de vardır, giriş düşerse iz de düşer. Ayrı bir yazma
 * olsaydı "giriş oldu ama izi tutulamadı" hâli sessizce mümkün olurdu. */
export interface NewSignInEvent {
  id: string;
  eventType: 'registration' | 'sign_in';
  trace: ConnectionTrace;
}

export interface IdentityRepository {
  createOAuthFlow(flow: OAuthFlowRow): Promise<void>;
  getOAuthFlow(selector: string): Promise<OAuthFlowRow | null>;
  findGithubIdentity(providerUserId: string): Promise<GithubIdentityRow | null>;
  /* Dönüşte "bu GitHub hesabı bizde var mı" sorusunun tek cevabı. Eskiden
   * bunun yanında bir de davet okunuyordu ve ikisi tek sorguda geliyordu;
   * davet kalkınca geriye sadece bu kaldı. */
  getGithubIdentity(providerUserId: string): Promise<GithubIdentityRow | null>;
  loginExistingIdentity(input: {
    flowId: string;
    identity: GithubIdentityRow;
    profile: GithubProfileSnapshot;
    session: NewSessionRow;
    consent: TermsConsent;
    auditEventId: string;
    signInEvent: NewSignInEvent;
    requestId: string;
    now: number;
  }): Promise<void>;
  /* Son pencerelerde açılan hesap sayısı. İki sayı tek sorgudan geliyor:
   * kayıt yolunda iki ayrı gidiş-dönüş, kapıyı korumak için ödenmesi
   * gereksiz bir bedel. */
  countRecentRegistrations(input: {
    ip: string | null;
    ipSince: number;
    globalSince: number;
  }): Promise<{ fromIp: number; total: number }>;
  registerGithubIdentity(input: {
    flowId: string;
    accountId: string;
    identityId: string;
    roleId: string;
    handle: string;
    profile: GithubProfileSnapshot;
    session: NewSessionRow;
    consent: TermsConsent;
    agentQuota: number;
    loginAuditEventId: string;
    signInEvent: NewSignInEvent;
    requestId: string;
    now: number;
  }): Promise<void>;
  getSession(selector: string): Promise<SessionView | null>;
  touchSession(sessionId: string, now: number, idleExpiresAt: number): Promise<void>;
  getAccount(accountId: string): Promise<AccountView | null>;
  revokeSession(input: {
    sessionId: string;
    accountId: string;
    auditEventId: string;
    requestId: string;
    now: number;
    reason: string;
  }): Promise<void>;
  cleanup(
    now: number,
    oauthCutoff: number,
    sessionCutoff: number,
    signInEventCutoff: number,
  ): Promise<{
    oauthFlows: number;
    sessions: number;
    idempotencyKeys: number;
    signInEvents: number;
  }>;
}
