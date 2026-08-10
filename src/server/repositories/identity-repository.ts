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

/* Kimlik sağlayıcıları. Google birincil kapı; GitHub yalnız göç süresince
 * duruyor ve mevcut üç hesap Google kimliğini kendi oturumunda bağlayınca
 * hem buradan hem şemadan kalkacak.
 *
 * Listenin kısa kalması bir tercih değil, kararın kendisi: federe bir hesabın
 * güvenliği bağlı sağlayıcıların EN ZAYIFINA eşit. İki adımlı doğrulaması
 * olmayan bir sağlayıcı eklemek, güçlü olanın getirdiği korumayı tümüyle
 * iptal eder. Yeni bir kapı ancak o zemini karşılıyorsa açılır. */
export type AuthProvider = 'github' | 'google';

export interface ProviderIdentityRow {
  identityId: string;
  accountId: string;
  provider: AuthProvider;
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
   * Orbit'in kendi hesap tanımlayıcısı. Kayıtta kullanıcı seçer, ortak
   * havuzdan gelir ve değişmez; sağlayıcıdaki ad veya adres değiştiğinde bu
   * alan etkilenmez.
   */
  handle: string;
  /**
   * Sağlayıcıdaki güncel etiket — Google'da e-posta adresi, GitHub'da
   * kullanıcı adı. Her girişte tazelenir. Kullanıcıya "hangi hesapla
   * bağlısın" diye bir şey gösteriliyorsa gösterilmesi gereken budur.
   */
  providerLogin: string | null;
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

/* Sağlayıcıdan bağımsız profil anlık görüntüsü. İki sağlayıcı da kendi
 * cevabını buna çeviriyor; bu katmandan sonrası hangi kapıdan gelindiğini
 * yalnız `provider` alanından biliyor. */
export interface ProviderProfileSnapshot {
  /* Sağlayıcının değişmeyen kimliği: GitHub'da sayısal id, Google'da `sub`.
   * Kullanıcı adını, adresini ve adını değiştirebilir; bu değişmez. */
  userId: string;
  /* Kullanıcıya "hangi hesapla bağlısın" derken gösterilecek etiket.
   * GitHub'da kullanıcı adı, Google'da e-posta adresi. Bir posta kutusu
   * değil — posta yalnız `email` alanına gider. */
  login: string;
  displayName: string;
  avatarUrl: string | null;
  /* Sağlayıcının DOĞRULADIĞI adres. Doğrulanmamışsa, alınamamışsa veya
   * kullanıcı izin vermemişse null kalır ve giriş yine tamamlanır: adres
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
  /* Dönüşte "bu sağlayıcı hesabı bizde var mı" sorusunun tek cevabı.
   *
   * Sağlayıcı da anahtarın parçası: şemadaki tekillik `(provider,
   * provider_user_id)` üzerinde. Yalnız kimliğe bakmak, iki sağlayıcının
   * sayısal kimliklerinin bir gün çakışması hâlinde iki yabancıyı aynı hesaba
   * sokardı. */
  findProviderIdentity(
    provider: AuthProvider,
    providerUserId: string,
  ): Promise<ProviderIdentityRow | null>;
  loginExistingIdentity(input: {
    flowId: string;
    identity: ProviderIdentityRow;
    profile: ProviderProfileSnapshot;
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
  /* Kayıt artık OAuth akış satırını TÜKETMİYOR ve bu bilinçli.
   *
   * Google'da kullanıcı adı olmadığı için handle'ı kullanıcı seçiyor, yani
   * kayıt callback'te bitmiyor: kimlik doğrulanıyor, imzalı bir bekleyen-kayıt
   * bileti veriliyor, hesap ikinci bir istekte açılıyor. Akış satırının ömrü
   * on dakika ve handle seçmek daha uzun sürebilir; tüketimi orada istemek,
   * yavaş davranan kullanıcıyı kaydın sonunda kapıda bırakırdı.
   *
   * Tekrar oynatmaya karşı koruma yerini değiştirdi, kaybolmadı: bilet imzalı
   * ve süreli, üstelik şemadaki `(provider, provider_user_id)` tekilliği aynı
   * kimlikle ikinci bir hesabın açılmasını zaten reddediyor. Yani bir bilet
   * kaç kez oynatılırsa oynatılsın en fazla bir hesap doğuyor. */
  registerProviderIdentity(input: {
    provider: AuthProvider;
    accountId: string;
    identityId: string;
    roleId: string;
    handle: string;
    profile: ProviderProfileSnapshot;
    session: NewSessionRow;
    consent: TermsConsent;
    agentQuota: number;
    loginAuditEventId: string;
    signInEvent: NewSignInEvent;
    requestId: string;
    now: number;
  }): Promise<void>;
  /* Var olan bir hesaba ikinci bir sağlayıcı kimliği ekler. GEÇİCİ: göçün
   * mekanizması bu ve göç bitince kalkacak.
   *
   * Hesabın kendisine dokunmuyor — ne görünen ad, ne avatar, ne onay. Bağlama
   * bir giriş değil: kişi zaten girmiş durumda ve yaptığı şey yalnız ikinci
   * bir anahtarı aynı kilide tanıtmak. Profil alanlarını buradan tazelemek,
   * bir tıklamayı sessiz bir profil değişikliğine çevirirdi. */
  linkProviderIdentity(input: {
    accountId: string;
    identityId: string;
    provider: AuthProvider;
    profile: ProviderProfileSnapshot;
    auditEventId: string;
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
