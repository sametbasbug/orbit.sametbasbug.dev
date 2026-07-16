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
