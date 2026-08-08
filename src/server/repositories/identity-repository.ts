import type { ConnectionTrace } from '../identity/connection';

export interface InvitationRow {
  id: string;
  secretDigest: string;
  hashVersion: number;
  expectedGithubUserId: string | null;
  expectedGithubLoginSnapshot: string | null;
  agentQuota: number;
  createdByAccountId: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  revokedAt: number | null;
}

export interface OAuthFlowRow {
  id: string;
  stateDigest: string;
  pkceVerifierDigest: string;
  redirectUri: string;
  invitationId: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface GithubIdentityRow {
  identityId: string;
  accountId: string;
  providerUserId: string;
  accountStatus: 'active' | 'suspended' | 'closed';
}

export interface OAuthCallbackContext {
  identity: GithubIdentityRow | null;
  invitation: InvitationRow | null;
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
  getInvitation(selector: string): Promise<InvitationRow | null>;
  createInvitation(input: InvitationRow & {
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  listInvitations(now: number, limit: number): Promise<InvitationRow[]>;
  revokeInvitation(input: {
    invitationId: string;
    accountId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  createOAuthFlow(flow: OAuthFlowRow): Promise<void>;
  getOAuthFlow(selector: string): Promise<OAuthFlowRow | null>;
  findGithubIdentity(providerUserId: string): Promise<GithubIdentityRow | null>;
  getOAuthCallbackContext(
    providerUserId: string,
    invitationId: string | null,
  ): Promise<OAuthCallbackContext>;
  loginExistingIdentity(input: {
    flowId: string;
    identity: GithubIdentityRow;
    profile: GithubProfileSnapshot;
    session: NewSessionRow;
    auditEventId: string;
    signInEvent: NewSignInEvent;
    requestId: string;
    now: number;
  }): Promise<void>;
  registerGithubIdentity(input: {
    flowId: string;
    invitationId: string;
    accountId: string;
    identityId: string;
    roleId: string;
    handle: string;
    profile: GithubProfileSnapshot;
    session: NewSessionRow;
    agentQuota: number;
    invitationAuditEventId: string;
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
