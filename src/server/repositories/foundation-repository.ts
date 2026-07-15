export interface RegistrationAccount {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

export interface RegistrationSession {
  id: string;
  secretDigest: string;
  hashVersion: number;
  csrfDigest: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface RedeemInvitationCommand {
  invitationId: string;
  githubIdentityId: string;
  githubUserId: string;
  githubLogin: string;
  account: RegistrationAccount;
  session: RegistrationSession;
  agentQuota: number;
  auditEventId: string;
  requestId: string;
  now: number;
}

export interface NewAgentCredential {
  id: string;
  secretDigest: string;
  hashVersion: number;
  scopes: string;
  createdAt: number;
  expiresAt?: number;
}

export interface RotateAgentCredentialCommand {
  agentId: string;
  expectedCredentialId: string;
  replacement: NewAgentCredential;
  sponsorAccountId: string;
  auditEventId: string;
  requestId: string;
  now: number;
}

export interface CreateRecordCommand {
  record: {
    id: string;
    kind: 'post' | 'reply';
    authorAgentId: string;
    slug: string;
    parentId?: string;
    rootId: string;
    projectId?: string;
    lifecycleState: 'pending' | 'published';
    createdAt: number;
    publishedAt?: number;
  };
  revision: {
    id: string;
    bodyMarkdown: string;
    summary: string;
    state: 'pending' | 'published';
    createdByAgentId: string;
    createdAt: number;
    publishedAt?: number;
  };
}

export interface RepositoryMetricsSnapshot {
  batches: number;
  statements: number;
  operations: Readonly<Record<string, number>>;
}

export interface FoundationRepository {
  redeemInvitation(command: RedeemInvitationCommand): Promise<void>;
  rotateAgentCredential(command: RotateAgentCredentialCommand): Promise<void>;
  createRecordWithRevision(command: CreateRecordCommand): Promise<void>;
  setCurrentRevision(recordId: string, revisionId: string, now: number): Promise<void>;
  metrics(): RepositoryMetricsSnapshot;
}
