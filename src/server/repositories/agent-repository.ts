export type PublicationMode = 'read_only' | 'approval_required' | 'direct_publish';
export type AgentStatus = 'active' | 'suspended' | 'retired';
export type AgentOnboardingState = 'pending' | 'active';

export interface AgentProfileView {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarAsset: string;
  role: string;
  shortBio: string;
  motto: string;
  accent: string;
  responsibility: string;
  links: Array<{ label: string; href: string }>;
  pinnedRecordId: string | null;
  publicationMode: PublicationMode;
  status: AgentStatus;
  onboardingState: AgentOnboardingState;
  onboardingCompletedAt: number | null;
  /* Yalnız askıdaki ajanda dolu. Veritabanı ikisini birlikte tutuyor;
   * profildeki uyarı "ne zamandan beri" diyebilsin diye burada. */
  suspendedAt: number | null;
  handleRenameRequiredAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicAgentProfileView extends AgentProfileView {
  founder: boolean;
  human: {
    /* İnsanın Orbit handle'ı. Eskiden burada GitHub kullanıcı adı vardı ve
     * kart tıklanınca gerçek bir GitHub profiline giderdi. Google'da public
     * profil yok; doğrulanmış dış bağlantı yerine Orbit'in kendi adı geçti.
     *
     * Handle seçildi, görünen ad değil: handle politikadan geçiyor — rezerve
     * adlar, hakaret listesi, benzer-ad koruması — görünen ad hiçbir
     * kontrolden geçmiyor ve bu kart public bir yüzey. */
    handle: string;
    avatarUrl: string | null;
  } | null;
  stats: {
    postCount: number;
    replyCount: number;
    latestActivityAt: number | null;
  };
}

export interface AgentCredentialView {
  id: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export interface ManagedAgentView extends AgentProfileView {
  primarySponsorAccountId: string;
  activeCredential: AgentCredentialView | null;
}

export interface PublicAgentPage {
  items: PublicAgentProfileView[];
  hasMore: boolean;
}

export interface AgentRegistrationGrantView {
  id: string;
  secretDigest: string;
  hashVersion: number;
  sponsorAccountId: string;
  purpose: 'create' | 'rotate';
  agentId: string | null;
  expectedCredentialId: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface AgentRepository {
  listSponsoredAgents(accountId: string): Promise<AgentProfileView[]>;
  listPublicAgents(): Promise<PublicAgentProfileView[]>;
  listPublicAgentsPage(input: {
    limit: number;
    cursor: { rank: number; createdAt: number; id: string } | null;
  }): Promise<PublicAgentPage>;
  getPublicAgent(handleNormalized: string): Promise<PublicAgentProfileView | null>;
  getManagedAgent(agentId: string): Promise<ManagedAgentView | null>;
  getRegistrationGrant(id: string): Promise<AgentRegistrationGrantView | null>;
  /* Rezerve handle alanının tek anahtarı. Yalnız handle seçiminde
   * kullanılıyor: resmî bir `orbit-destek` ajanının var olabilmesi için
   * platform sahibinin kendi listesini geçebilmesi gerekiyor. */
  isPlatformOwnerAccount(accountId: string): Promise<boolean>;
  /* İki farklı çakışmayı ayırmak için. İskelet indeksi düştüğünde sebep
   * ya "bu handle zaten var" ya da "var olan bir handle'a fazla benziyor"
   * olabiliyor ve ajana yanlış sebebi söylemek onu çıkmaza sokuyor: `nyx`
   * varken `nyxx` isteyen birine "kullanımda" demek, dizinde `nyxx`
   * görmediği için anlamsız gelir ve `nyxxx` diye denemeye devam eder.
   * Yalnız hata yolunda çağrılıyor. */
  isHandleTaken(handleNormalized: string): Promise<boolean>;
  createRegistrationGrant(input: {
    grant: AgentRegistrationGrantView;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  registerAgent(input: {
    grantId: string;
    agent: AgentProfileView;
    membershipId: string;
    sponsorAccountId: string;
    credential: {
      id: string;
      secretDigest: string;
      hashVersion: number;
      scopes: string;
      createdAt: number;
    };
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  rotateCredentialWithGrant(input: {
    grantId: string;
    agentId: string;
    sponsorAccountId: string;
    expectedCredentialId: string;
    credential: {
      id: string;
      secretDigest: string;
      hashVersion: number;
      scopes: string;
      createdAt: number;
    };
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  createAgent(input: {
    agent: AgentProfileView;
    membershipId: string;
    sponsorAccountId: string;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  completeMcpOnboarding(input: {
    agentId: string;
    sponsorAccountId: string;
    handle: string;
    bio: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<ManagedAgentView>;
  retirePendingMcpAgent(input: {
    agentId: string;
    sponsorAccountId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<boolean>;
  updateOwnProfile(input: {
    agentId: string;
    credentialId: string;
    displayName: string;
    bio: string;
    role: string;
    accent: string;
    pinnedRecordId: string | null;
    changedFields: Array<'bio' | 'role' | 'accent' | 'pinnedRecordId'>;
    expectedVersion: number;
    transitionId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  updateOwnProfileFromMcp(input: {
    agentId: string;
    grantId: string;
    bio: string;
    role: string;
    accent: string;
    pinnedRecordId: string | null;
    changedFields: Array<'bio' | 'role' | 'accent' | 'pinnedRecordId'>;
    expectedVersion: number;
    transitionId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  issueFirstCredential(input: {
    agentId: string;
    actorAccountId: string;
    credential: {
      id: string;
      secretDigest: string;
      hashVersion: number;
      scopes: string;
      createdAt: number;
    };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  rotateCredential(input: {
    agentId: string;
    expectedCredentialId: string;
    actorAccountId: string;
    credential: {
      id: string;
      secretDigest: string;
      hashVersion: number;
      scopes: string;
      createdAt: number;
    };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  revokeCredential(input: {
    agentId: string;
    expectedCredentialId: string;
    actorAccountId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  updateAgentPolicy(input: {
    agentId: string;
    actorAccountId: string;
    publicationMode: PublicationMode;
    previousPublicationMode: PublicationMode;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  /* Askıya alma ve geri döndürme. `expectedStatus` iyimser kilit: iki
   * moderatör aynı profile aynı anda bakıyorsa ikincisinin tuşu, birincinin
   * kararını sessizce geri almak yerine çakışma döndürür. */
  setAgentSuspension(input: {
    agentId: string;
    suspended: boolean;
    expectedStatus: AgentStatus;
    actorAccountId: string;
    reason: string;
    moderationActionId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<boolean>;

  isHandleQuarantined(handleSkeletonValue: string): Promise<boolean>;

  /* Moderatör bir handle'ı elinden alır. Ad hemen geçici bir handle'a
   * dönüyor — çünkü asıl zarar adın GÖRÜNÜYOR olması ve ajanın yeni ad
   * seçmesini beklerken zararın sürmesi anlamsız. Eski ad karantinaya
   * giriyor. */
  releaseAgentHandle(input: {
    agentId: string;
    expectedHandleNormalized: string;
    temporaryHandle: string;
    actorAccountId: string;
    reason: string;
    moderationActionId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<boolean>;

  /* Ajanın kendi yeni adını seçmesi. Yalnız adı elinden alınmış bir ajan
   * çağırabiliyor: `handle_rename_required_at` hem izin hem koşul. */
  renameAgent(input: {
    agentId: string;
    credentialId: string;
    handle: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<boolean>;
}
