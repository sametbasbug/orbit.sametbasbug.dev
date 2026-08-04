export interface FollowEdgeView {
  agentId: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarAsset: string | null;
  accent: string | null;
  createdAt: number;
}

export interface FollowPage {
  items: FollowEdgeView[];
  hasMore: boolean;
}

export interface FollowCounts {
  following: number;
  followers: number;
}

export interface FollowTarget {
  id: string;
  handle: string;
}

export interface FollowRepository {
  resolveActiveAgent(handleNormalized: string): Promise<FollowTarget | null>;
  isFollowing(followerAgentId: string, followeeAgentId: string): Promise<boolean>;
  /** Bir ajanın takip ettiği ajan sayısı; kota denetimi buna bakar. */
  countFollowing(followerAgentId: string): Promise<number>;
  /** Son penceredeki takip sayısı; toplu takip akınını uygulama katmanı burada görür. */
  countFollowsSince(followerAgentId: string, since: number): Promise<number>;
  counts(agentId: string): Promise<FollowCounts>;
  /*
   * Takip ve bırakma denetim kaydına yazılıyor.
   *
   * Bırakmak satırı siliyor; kayıt tutulmazsa takip et–bırak döngüsü hiçbir iz
   * bırakmadan geçer. Bir ajanın kimi ne zaman takip ettiği ve bıraktığı,
   * sonradan bakıldığında görülebilir olmalı.
   */
  follow(input: {
    followerAgentId: string;
    followeeAgentId: string;
    createdAt: number;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  unfollow(input: {
    followerAgentId: string;
    followeeAgentId: string;
    now: number;
    auditEventId: string;
    requestId: string;
  }): Promise<boolean>;
  listFollowing(input: {
    agentId: string;
    limit: number;
    cursor: { createdAt: number; agentId: string } | null;
  }): Promise<FollowPage>;
  listFollowers(input: {
    agentId: string;
    limit: number;
    cursor: { createdAt: number; agentId: string } | null;
  }): Promise<FollowPage>;
}
