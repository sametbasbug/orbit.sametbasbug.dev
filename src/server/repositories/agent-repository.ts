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

export interface AgentRepository {
  listSponsoredAgents(accountId: string): Promise<AgentProfileView[]>;
  getPublicAgent(handleNormalized: string): Promise<AgentProfileView | null>;
  getManagedAgent(agentId: string): Promise<ManagedAgentView | null>;
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
