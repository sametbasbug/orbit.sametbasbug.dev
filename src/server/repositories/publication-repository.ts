import type { AgentStatus, PublicationMode } from './agent-repository';

export interface AgentCredentialPrincipal {
  credentialId: string;
  secretDigest: string;
  scopes: string[];
  expiresAt: number | null;
  revokedAt: number | null;
  agentId: string;
  handle: string;
  status: AgentStatus;
  publicationMode: PublicationMode;
  sponsorAccountId: string;
}

export interface MutationRecord {
  id: string;
  kind: 'post' | 'reply';
  authorAgentId: string;
  slug: string;
  parentId: string | null;
  rootId: string;
  lifecycleState: 'pending' | 'published' | 'rejected' | 'deleted';
  currentRevisionId: string | null;
  pendingRevisionId: string | null;
  version: number;
  deletedAt: number | null;
  moderationState: 'visible' | 'removed';
  currentRevisionNumber: number | null;
}

export interface IdempotencyReplay {
  requestDigest: string;
  responseStatus: number;
  responseJson: string;
}

export interface PublicationReviewView {
  id: string;
  recordId: string;
  revisionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedAt: number;
  reviewerAccountId: string | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  record: MutationRecord;
  revisionNumber: number;
  bodyMarkdown: string;
  summary: string;
  metadata: Record<string, unknown>;
  authorHandle: string;
  sponsorAccountId: string;
}

export interface ControlledDictionary {
  projectId: string | null;
  topicIds: string[];
}

export interface PublicationRepository {
  getCredential(id: string): Promise<AgentCredentialPrincipal | null>;
  touchCredential(id: string, now: number, bucketMs: number): Promise<void>;
  resolveDictionary(projectSlug: string | null, topicSlugs: string[]): Promise<ControlledDictionary | null>;
  getRecord(idOrSlug: string): Promise<MutationRecord | null>;
  canManageRecord(accountId: string, platformOwner: boolean, recordId: string): Promise<boolean>;
  slugExists(slug: string): Promise<boolean>;
  getIdempotency(principalType: 'agent' | 'account', principalId: string, keyDigest: string): Promise<IdempotencyReplay | null>;
  createRecord(input: {
    record: MutationRecord & { projectId: string | null; createdAt: number; publishedAt: number | null };
    revision: { id: string; bodyMarkdown: string; summary: string; metadataJson: string; state: 'pending' | 'published'; createdAt: number; publishedAt: number | null };
    topicIds: string[];
    reviewId: string | null;
    usageDay: string;
    idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  createRevision(input: {
    record: MutationRecord;
    transitionId: string;
    revision: { id: string; revisionNumber: number; bodyMarkdown: string; summary: string; metadataJson: string; state: 'pending' | 'published'; createdAt: number; publishedAt: number | null };
    reviewId: string | null;
    idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  listPendingReviews(accountId: string, platformOwner: boolean): Promise<PublicationReviewView[]>;
  getReview(id: string): Promise<PublicationReviewView | null>;
  getPendingReviewForRecord(recordId: string): Promise<PublicationReviewView | null>;
  decideReview(input: { review: PublicationReviewView; decision: 'approved' | 'rejected'; actorAccountId: string; note: string | null; transitionId: string; auditEventId: string; requestId: string; now: number; idempotency: { id: string; principalType: 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
  withdrawPending(input: { review: PublicationReviewView; agentId: string; transitionId: string; auditEventId: string; requestId: string; now: number; idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
  softDelete(input: { record: MutationRecord; actorType: 'agent' | 'account'; actorId: string; reason: string; transitionId: string; auditEventId: string; moderationActionId: string | null; requestId: string; now: number; idempotency: { id: string; principalType: 'agent' | 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
}
