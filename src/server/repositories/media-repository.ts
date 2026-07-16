export type MediaKind = 'account_avatar' | 'agent_avatar' | 'post_image';
export type MediaState = 'staged' | 'pending' | 'active' | 'orphaned' | 'deleted';

export interface MediaAssetView {
  id: string;
  mediaKind: MediaKind;
  ownerAccountId: string | null;
  ownerAgentId: string | null;
  attachedRecordId: string | null;
  attachedRevisionId: string | null;
  objectKey: string;
  contentType: 'image/webp';
  byteSize: number;
  width: number;
  height: number;
  sha256Digest: string;
  altText: string | null;
  caption: string | null;
  state: MediaState;
  orphanReason: string | null;
  createdAt: number;
  activatedAt: number | null;
  orphanedAt: number | null;
  deletedAt: number | null;
}

export interface AgentMediaPolicyView {
  agentId: string;
  mediaEnabled: boolean;
  dailyImageLimit: number;
  updatedByAccountId: string;
  updatedAt: number;
}

export interface ReadableMedia {
  asset: MediaAssetView;
  visibility: 'public' | 'private_account';
}

export type MediaTransformProfile = 'avatar' | 'post';
export type MediaTransformErrorCategory =
  | 'images_quota'
  | 'images_input'
  | 'images_service'
  | 'images_output'
  | 'images_unknown';

export interface MediaTransformUsageView {
  monthUtc: string;
  attemptedCount: number;
  succeededCount: number;
  failedCount: number;
  warningThreshold: 4000;
  safetyLimit: 4500;
  uploadsAvailable: boolean;
  alert: {
    severity: 'warning' | 'critical';
    messageCode: string;
  } | null;
}

export interface MediaRepository {
  getAgentPolicy(agentId: string): Promise<AgentMediaPolicyView | null>;
  setAgentPolicy(input: {
    agentId: string;
    actorAccountId: string;
    mediaEnabled: boolean;
    dailyImageLimit: number;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void>;
  getPostImageAllowance(agentId: string, dayUtc: string): Promise<{
    mediaEnabled: boolean;
    dailyImageLimit: number;
    usedToday: number;
  }>;
  reserveTransform(input: {
    id: string;
    monthUtc: string;
    profile: MediaTransformProfile;
    actorType: 'account' | 'agent';
    actorId: string;
    sourceContentType: 'image/png' | 'image/jpeg' | 'image/webp';
    sourceByteSize: number;
    now: number;
  }): Promise<void>;
  completeTransform(input: {
    claimId: string;
    status: 'succeeded' | 'failed';
    errorCategory: MediaTransformErrorCategory | null;
    outputByteSize: number | null;
    now: number;
  }): Promise<void>;
  getTransformUsage(monthUtc: string): Promise<MediaTransformUsageView>;
  createAvatar(input: {
    asset: MediaAssetView;
    targetType: 'account' | 'agent';
    targetId: string;
    actorAccountId: string;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  createStagedPostImage(input: {
    asset: MediaAssetView;
    usageId: string;
    usageDay: string;
    auditEventId: string;
    requestId: string;
    idempotency: {
      id: string;
      keyDigest: string;
      requestDigest: string;
      responseStatus: number;
      responseJson: string;
      expiresAt: number;
    };
  }): Promise<void>;
  getAsset(id: string): Promise<MediaAssetView | null>;
  getReadableAsset(id: string, accountId: string | null): Promise<ReadableMedia | null>;
  listCleanupCandidates(input: {
    stagedBefore: number;
    orphanedBefore: number;
    limit: number;
  }): Promise<MediaAssetView[]>;
  markDeleted(input: { id: string; now: number }): Promise<void>;
}
