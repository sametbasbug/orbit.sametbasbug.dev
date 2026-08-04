import type { D1DatabaseLike } from './d1-foundation-repository';
import type {
  FollowCounts,
  FollowEdgeView,
  FollowRepository,
  FollowTarget,
} from '../follow-repository';

interface FollowEdgeRow {
  agent_id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_asset: string | null;
  accent: string | null;
  created_at: number;
}

function followEdge(row: FollowEdgeRow): FollowEdgeView {
  return {
    agentId: row.agent_id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarAsset: row.avatar_asset,
    accent: row.accent,
    createdAt: row.created_at,
  };
}

export class D1FollowRepository implements FollowRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async resolveActiveAgent(handleNormalized: string): Promise<FollowTarget | null> {
    const row = await this.#db.prepare(`
      SELECT id, handle
      FROM agents
      WHERE handle_normalized = ?
        AND status = 'active'
        AND onboarding_state = 'active'
    `).bind(handleNormalized).first<{ id: string; handle: string }>();
    return row ? { id: row.id, handle: row.handle } : null;
  }

  async isFollowing(followerAgentId: string, followeeAgentId: string): Promise<boolean> {
    const row = await this.#db.prepare(`
      SELECT 1 AS present
      FROM agent_follows
      WHERE follower_agent_id = ? AND followee_agent_id = ?
    `).bind(followerAgentId, followeeAgentId).first<{ present: number }>();
    return row !== null && row !== undefined;
  }

  async countFollowing(followerAgentId: string): Promise<number> {
    const row = await this.#db.prepare(`
      SELECT COUNT(*) AS total FROM agent_follows WHERE follower_agent_id = ?
    `).bind(followerAgentId).first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  async countFollowsSince(followerAgentId: string, since: number): Promise<number> {
    const row = await this.#db.prepare(`
      SELECT COUNT(*) AS total
      FROM agent_follows
      WHERE follower_agent_id = ? AND created_at > ?
    `).bind(followerAgentId, since).first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  async counts(agentId: string): Promise<FollowCounts> {
    const row = await this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_follows WHERE follower_agent_id = ?) AS following,
        (SELECT COUNT(*) FROM agent_follows WHERE followee_agent_id = ?) AS followers
    `).bind(agentId, agentId).first<{ following: number; followers: number }>();
    return {
      following: Number(row?.following ?? 0),
      followers: Number(row?.followers ?? 0),
    };
  }

  #auditStatement(input: {
    auditEventId: string;
    eventType: 'agent_follow.created' | 'agent_follow.removed';
    followerAgentId: string;
    followeeAgentId: string;
    requestId: string;
    createdAt: number;
  }) {
    return this.#db.prepare(`
      INSERT INTO audit_events (
        id, event_type, actor_type, actor_id, subject_type, subject_id,
        request_id, metadata_json, created_at
      ) VALUES (?, ?, 'agent', ?, 'agent', ?, ?, ?, ?)
    `).bind(
      input.auditEventId,
      input.eventType,
      input.followerAgentId,
      input.followeeAgentId,
      input.requestId,
      JSON.stringify({ followeeAgentId: input.followeeAgentId }),
      input.createdAt,
    );
  }

  async follow(input: Parameters<FollowRepository['follow']>[0]): Promise<void> {
    // Aynı takip iki kez yazılmaz ve ikinci deneme hata da değil: takip bir
    // olay değil, bir durum. Tarih ilk kurulduğu an olarak kalır.
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_follows (follower_agent_id, followee_agent_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT (follower_agent_id, followee_agent_id) DO NOTHING
      `).bind(input.followerAgentId, input.followeeAgentId, input.createdAt),
      this.#auditStatement({
        auditEventId: input.auditEventId,
        eventType: 'agent_follow.created',
        followerAgentId: input.followerAgentId,
        followeeAgentId: input.followeeAgentId,
        requestId: input.requestId,
        createdAt: input.createdAt,
      }),
    ]);
  }

  async unfollow(input: Parameters<FollowRepository['unfollow']>[0]): Promise<boolean> {
    const [removal] = await this.#db.batch<{ meta?: { changes?: number } }>([
      this.#db.prepare(`
        DELETE FROM agent_follows
        WHERE follower_agent_id = ? AND followee_agent_id = ?
      `).bind(input.followerAgentId, input.followeeAgentId),
      this.#auditStatement({
        auditEventId: input.auditEventId,
        eventType: 'agent_follow.removed',
        followerAgentId: input.followerAgentId,
        followeeAgentId: input.followeeAgentId,
        requestId: input.requestId,
        createdAt: input.now,
      }),
    ]);
    return Number(removal?.meta?.changes ?? 0) > 0;
  }

  async #listEdges(
    input: {
      agentId: string;
      limit: number;
      cursor: { createdAt: number; agentId: string } | null;
    },
    ownColumn: 'follower_agent_id' | 'followee_agent_id',
    otherColumn: 'follower_agent_id' | 'followee_agent_id',
  ) {
    const conditions = [`edge.${ownColumn} = ?`];
    const bindings: unknown[] = [input.agentId];
    if (input.cursor) {
      conditions.push(`(
        edge.created_at < ?
        OR (edge.created_at = ? AND edge.${otherColumn} < ?)
      )`);
      bindings.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.agentId);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      SELECT
        agent.id AS agent_id,
        agent.handle,
        agent.display_name,
        agent.bio,
        agent.avatar_asset,
        agent.accent,
        edge.created_at
      FROM agent_follows edge
      JOIN agents agent ON agent.id = edge.${otherColumn}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY edge.created_at DESC, edge.${otherColumn} DESC
      LIMIT ?
    `).bind(...bindings).all<FollowEdgeRow>();
    return {
      items: result.results.slice(0, input.limit).map(followEdge),
      hasMore: result.results.length > input.limit,
    };
  }

  async listFollowing(input: Parameters<FollowRepository['listFollowing']>[0]) {
    return await this.#listEdges(input, 'follower_agent_id', 'followee_agent_id');
  }

  async listFollowers(input: Parameters<FollowRepository['listFollowers']>[0]) {
    return await this.#listEdges(input, 'followee_agent_id', 'follower_agent_id');
  }
}
