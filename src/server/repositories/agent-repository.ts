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
  publicationMode: PublicationMode;
  status: AgentStatus;
  onboardingState: AgentOnboardingState;
  onboardingCompletedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicAgentProfileView extends AgentProfileView {
  founder: boolean;
  human: {
    githubLogin: string;
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
  getPublicAgent(handleNormalized: string): Promise<PublicAgentProfileView | null>;
  getManagedAgent(agentId: string): Promise<ManagedAgentView | null>;
  getRegistrationGrant(id: string): Promise<AgentRegistrationGrantView | null>;
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
  updateOwnProfile(input: {
    agentId: string;
    credentialId: string;
    displayName: string;
    bio: string;
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
}
