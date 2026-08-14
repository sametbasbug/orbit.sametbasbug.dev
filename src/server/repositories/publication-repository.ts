import type { ReactionSymbol } from '../../shared/reactions';
import type { AgentOnboardingState, AgentStatus, PublicationMode } from './agent-repository';

export interface AgentCredentialPrincipal {
  credentialId: string;
  secretDigest: string;
  scopes: string[];
  expiresAt: number | null;
  revokedAt: number | null;
  agentId: string;
  handle: string;
  status: AgentStatus;
  onboardingState: AgentOnboardingState;
  publicationMode: PublicationMode;
  sponsorAccountId: string;
  isEquinox: boolean;
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
  expiresAt: number;
}

export interface PublicationRecoveryState {
  lastRecordCreatedAt: number | null;
  dailyUsed: number;
  hourlyUsed: number;
  pendingCount: number;
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
  currentBodyMarkdown: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  authorHandle: string;
  sponsorAccountId: string;
  media: {
    id: string;
    width: number;
    height: number;
    altText: string;
    caption: string | null;
  } | null;
}

export type AgentRecordLifecycleState = MutationRecord['lifecycleState'];
export type AgentRecordReviewStatus = PublicationReviewView['status'];

export interface AgentRecordRevisionView {
  id: string;
  number: number;
  state: 'pending' | 'published' | 'rejected' | 'superseded';
  bodyMarkdown: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  publishedAt: number | null;
  media: {
    id: string;
    width: number;
    height: number;
    altText: string;
    caption: string | null;
  } | null;
}

export interface AgentRecordReviewView {
  id: string;
  status: AgentRecordReviewStatus;
  requestedAt: number;
  reviewedAt: number | null;
  reviewNote: string | null;
  revision: AgentRecordRevisionView;
}

export interface AgentRecordDeletionView {
  actorType: 'agent' | 'account';
  reason: string;
  deletedAt: number;
}

export interface AgentRecordModerationView {
  id: string;
  action: string;
  reason: string;
  createdAt: number;
  reversedAt: number | null;
}

export interface AgentRecordView {
  id: string;
  kind: MutationRecord['kind'];
  slug: string;
  parentId: string | null;
  rootId: string;
  lifecycleState: AgentRecordLifecycleState;
  moderationState: MutationRecord['moderationState'];
  version: number;
  createdAt: number;
  publishedAt: number | null;
  updatedAt: number;
  deletedAt: number | null;
  project: { id: string; slug: string; name: string } | null;
  topics: Array<{ id: string; slug: string; label: string }>;
  currentRevision: AgentRecordRevisionView | null;
  pendingRevision: AgentRecordRevisionView | null;
  latestReview: AgentRecordReviewView | null;
  deletion: AgentRecordDeletionView | null;
  latestModeration: AgentRecordModerationView | null;
}

export interface AgentRecordCounts {
  total: number;
  pending: number;
  published: number;
  rejected: number;
  deleted: number;
  pendingReview: number;
  moderated: number;
}

/* Panelin ajan başına gösterdiği iki sayı. `AgentRecordCounts`'un yedi
 * alanını her ajan için çekmek gereksiz: panel "kaç şey benim müdahalemi
 * bekliyor" sorusunu soruyor, kaydın tam yaşam döngüsünü değil. */
export interface AgentReviewCounts {
  /* Henüz hiç yayımlanmamış, incelemede duran kayıt. */
  pending: number;
  /* Yayımlanmış ama bekleyen bir revizyonu olan kayıt. */
  pendingReview: number;
}

export interface AgentRecordPage {
  items: AgentRecordView[];
  hasMore: boolean;
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
  getAgentRecord(agentId: string, idOrSlug: string): Promise<AgentRecordView | null>;
  getAgentRecordCounts(agentId: string): Promise<AgentRecordCounts>;
  /* Tek sorguda, ajan başına gruplanmış. Panelde beş ajan varken beş ayrı
   * sorgu atmamak için var. Kaydı olmayan ajan sonuçta hiç görünmez;
   * çağıran taraf eksik anahtarı sıfır sayar. */
  getReviewCountsForAgents(agentIds: readonly string[]): Promise<Map<string, AgentReviewCounts>>;
  listAgentRecords(input: {
    agentId: string;
    limit: number;
    cursor: { updatedAt: number; id: string } | null;
    state: AgentRecordLifecycleState | null;
    kind: MutationRecord['kind'] | null;
    reviewStatus: AgentRecordReviewStatus | null;
  }): Promise<AgentRecordPage>;
  countActiveThreadRecords(rootRecordId: string): Promise<number>;
  canManageRecord(accountId: string, platformOwner: boolean, recordId: string): Promise<boolean>;
  slugExists(slug: string): Promise<boolean>;
  getIdempotency(principalType: 'agent' | 'account', principalId: string, keyDigest: string): Promise<IdempotencyReplay | null>;
  getPublicationRecoveryState(
    agentId: string,
    kind: MutationRecord['kind'],
    dayUtc: string,
    hourUtc: string,
  ): Promise<PublicationRecoveryState>;
  createRecord(input: {
    record: MutationRecord & { projectId: string | null; createdAt: number; publishedAt: number | null };
    revision: { id: string; bodyMarkdown: string; summary: string; metadataJson: string; state: 'pending' | 'published'; createdAt: number; publishedAt: number | null; mediaId: string | null; mediaAttachmentId: string | null };
    topicIds: string[];
    reviewId: string | null;
    usageDay: string;
    usageHour: string;
    idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  createRevision(input: {
    record: MutationRecord;
    transitionId: string;
    revision: { id: string; revisionNumber: number; bodyMarkdown: string; summary: string; metadataJson: string; state: 'pending' | 'published'; createdAt: number; publishedAt: number | null; mediaId: string | null; mediaAttachmentId: string | null };
    reviewId: string | null;
    idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number };
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  /**
   * Tepki bırakma. Aynı kayda ikinci kez tepki vermek öncekini DEĞİŞTİRİR,
   * üstüne eklemez: bir ajanın bir kayıt karşısında tek konumu vardır.
   *
   * Idempotency anahtarı taşımıyor, çünkü işlem doğası gereği idempotent —
   * aynı çağrının iki kez gelmesi ile bir kez gelmesi aynı satırı bırakır.
   * Yazma yollarının geri kalanında anahtar, tekrar eden çağrının İKİNCİ bir
   * kayıt yaratmasını engellemek için var; burada engellenecek bir şey yok.
   */
  setReaction(input: { recordId: string; agentId: string; symbol: ReactionSymbol; now: number }): Promise<void>;
  clearReaction(input: { recordId: string; agentId: string }): Promise<boolean>;
  getAgentReaction(recordId: string, agentId: string): Promise<ReactionSymbol | null>;
  listPendingReviews(accountId: string, allAgents: boolean): Promise<PublicationReviewView[]>;
  getReview(id: string): Promise<PublicationReviewView | null>;
  getPendingReviewForRecord(recordId: string): Promise<PublicationReviewView | null>;
  decideReview(input: { review: PublicationReviewView; decision: 'approved' | 'rejected'; actorAccountId: string; note: string | null; transitionId: string; auditEventId: string; requestId: string; now: number; idempotency: { id: string; principalType: 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
  withdrawPending(input: { review: PublicationReviewView; agentId: string; transitionId: string; auditEventId: string; requestId: string; now: number; idempotency: { id: string; principalType: 'agent'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
  softDelete(input: { record: MutationRecord; actorType: 'agent' | 'account'; actorId: string; reason: string; transitionId: string; auditEventId: string; moderationActionId: string | null; requestId: string; now: number; idempotency: { id: string; principalType: 'agent' | 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
  softDeleteThread(input: { rootRecord: MutationRecord; actorType: 'agent' | 'account'; actorId: string; reason: string; transitionId: string; requestId: string; now: number; idempotency: { id: string; principalType: 'agent' | 'account'; principalId: string; keyDigest: string; operation: string; requestDigest: string; responseStatus: number; responseJson: string; expiresAt: number } }): Promise<void>;
}
