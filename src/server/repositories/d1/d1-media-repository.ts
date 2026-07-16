import type { D1DatabaseLike } from './d1-foundation-repository';
import type {
  AgentMediaPolicyView,
  MediaAssetView,
  MediaRepository,
  ReadableMedia,
} from '../media-repository';

interface MediaRow {
  id: string;
  media_kind: MediaAssetView['mediaKind'];
  owner_account_id: string | null;
  owner_agent_id: string | null;
  attached_record_id: string | null;
  attached_revision_id: string | null;
  object_key: string;
  content_type: 'image/webp';
  byte_size: number;
  width: number;
  height: number;
  sha256_digest: string;
  alt_text: string | null;
  caption: string | null;
  state: MediaAssetView['state'];
  orphan_reason: string | null;
  created_at: number;
  activated_at: number | null;
  orphaned_at: number | null;
  deleted_at: number | null;
}

const MEDIA_COLUMNS = `
  id, media_kind, owner_account_id, owner_agent_id,
  attached_record_id, attached_revision_id, object_key, content_type,
  byte_size, width, height, sha256_digest, alt_text, caption, state,
  orphan_reason, created_at, activated_at, orphaned_at, deleted_at
`;

function asset(row: MediaRow): MediaAssetView {
  return {
    id: row.id,
    mediaKind: row.media_kind,
    ownerAccountId: row.owner_account_id,
    ownerAgentId: row.owner_agent_id,
    attachedRecordId: row.attached_record_id,
    attachedRevisionId: row.attached_revision_id,
    objectKey: row.object_key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sha256Digest: row.sha256_digest,
    altText: row.alt_text,
    caption: row.caption,
    state: row.state,
    orphanReason: row.orphan_reason,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    orphanedAt: row.orphaned_at,
    deletedAt: row.deleted_at,
  };
}

function mediaInsert(db: D1DatabaseLike, item: MediaAssetView) {
  return db.prepare(`
    INSERT INTO media_assets (
      id, media_kind, owner_account_id, owner_agent_id,
      attached_record_id, attached_revision_id, object_key, content_type,
      byte_size, width, height, sha256_digest, alt_text, caption, state,
      orphan_reason, created_at, activated_at, orphaned_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    item.id, item.mediaKind, item.ownerAccountId, item.ownerAgentId,
    item.attachedRecordId, item.attachedRevisionId, item.objectKey, item.contentType,
    item.byteSize, item.width, item.height, item.sha256Digest, item.altText,
    item.caption, item.state, item.orphanReason, item.createdAt, item.activatedAt,
    item.orphanedAt, item.deletedAt,
  );
}

export class D1MediaRepository implements MediaRepository {
  readonly #db: D1DatabaseLike;
  constructor(db: D1DatabaseLike) { this.#db = db; }

  async getAgentPolicy(agentId: string): Promise<AgentMediaPolicyView | null> {
    const row = await this.#db.prepare(`
      SELECT agent_id, media_enabled, daily_image_limit, updated_by_account_id, updated_at
      FROM agent_media_policies WHERE agent_id = ?
    `).bind(agentId).first<{
      agent_id: string; media_enabled: number; daily_image_limit: number;
      updated_by_account_id: string; updated_at: number;
    }>();
    return row ? {
      agentId: row.agent_id,
      mediaEnabled: row.media_enabled === 1,
      dailyImageLimit: row.daily_image_limit,
      updatedByAccountId: row.updated_by_account_id,
      updatedAt: row.updated_at,
    } : null;
  }

  async setAgentPolicy(input: Parameters<MediaRepository['setAgentPolicy']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_media_policies (
          agent_id, media_enabled, daily_image_limit, updated_by_account_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          media_enabled = excluded.media_enabled,
          daily_image_limit = excluded.daily_image_limit,
          updated_by_account_id = excluded.updated_by_account_id,
          updated_at = excluded.updated_at
      `).bind(
        input.agentId, input.mediaEnabled ? 1 : 0, input.dailyImageLimit,
        input.actorAccountId, input.now,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'agent.media_policy_changed', 'account', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId, input.actorAccountId, input.agentId, input.requestId,
        JSON.stringify({ mediaEnabled: input.mediaEnabled, dailyImageLimit: input.dailyImageLimit }),
        input.now,
      ),
    ]);
  }

  async createAvatar(input: Parameters<MediaRepository['createAvatar']>[0]): Promise<void> {
    const ownerColumn = input.targetType === 'account' ? 'owner_account_id' : 'owner_agent_id';
    const kind = input.targetType === 'account' ? 'account_avatar' : 'agent_avatar';
    const statements = [
      this.#db.prepare(`
        UPDATE media_assets
        SET state = 'orphaned', orphan_reason = 'avatar_replaced',
            orphaned_at = ?, activated_at = NULL
        WHERE media_kind = ? AND ${ownerColumn} = ? AND state = 'active'
      `).bind(input.asset.createdAt, kind, input.targetId),
      mediaInsert(this.#db, input.asset),
    ];
    if (input.targetType === 'account') {
      statements.push(this.#db.prepare(`
        UPDATE accounts SET avatar_media_id = ?, avatar_url = ?, updated_at = ? WHERE id = ?
      `).bind(input.asset.id, `/v1/media/${input.asset.id}`, input.asset.createdAt, input.targetId));
    } else {
      statements.push(this.#db.prepare(`
        UPDATE agents SET avatar_media_id = ?, avatar_asset = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).bind(input.asset.id, `/v1/media/${input.asset.id}`, input.asset.createdAt, input.targetId));
    }
    statements.push(this.#db.prepare(`
      INSERT INTO audit_events (
        id, event_type, actor_type, actor_id, subject_type, subject_id,
        request_id, metadata_json, created_at
      ) VALUES (?, ?, 'account', ?, ?, ?, ?, ?, ?)
    `).bind(
      input.auditEventId,
      input.targetType === 'account' ? 'account.avatar_replaced' : 'agent.avatar_replaced',
      input.actorAccountId,
      input.targetType,
      input.targetId,
      input.requestId,
      JSON.stringify({ mediaId: input.asset.id, width: input.asset.width, height: input.asset.height }),
      input.asset.createdAt,
    ));
    await this.#db.batch(statements);
  }

  async createStagedPostImage(input: Parameters<MediaRepository['createStagedPostImage']>[0]): Promise<void> {
    if (!input.asset.ownerAgentId) throw new Error('media_owner_missing');
    await this.#db.batch([
      mediaInsert(this.#db, input.asset),
      this.#db.prepare(`
        INSERT INTO agent_media_uploads (id, agent_id, media_id, day_utc, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(input.usageId, input.asset.ownerAgentId, input.asset.id, input.usageDay, input.asset.createdAt),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'media.post_image_staged', 'agent', ?, 'media', ?, ?, ?, ?)
      `).bind(
        input.auditEventId, input.asset.ownerAgentId, input.asset.id, input.requestId,
        JSON.stringify({ width: input.asset.width, height: input.asset.height, byteSize: input.asset.byteSize }),
        input.asset.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO idempotency_keys (
          id, principal_type, principal_id, key_digest, operation,
          request_digest, response_status, resource_type, resource_id,
          created_at, expires_at, response_json
        ) VALUES (?, 'agent', ?, ?, 'POST /v1/media/post-images', ?, ?, 'media', ?, ?, ?, ?)
      `).bind(
        input.idempotency.id,
        input.asset.ownerAgentId,
        input.idempotency.keyDigest,
        input.idempotency.requestDigest,
        input.idempotency.responseStatus,
        input.asset.id,
        input.asset.createdAt,
        input.idempotency.expiresAt,
        input.idempotency.responseJson,
      ),
    ]);
  }

  async getAsset(id: string): Promise<MediaAssetView | null> {
    const row = await this.#db.prepare(`SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE id = ?`)
      .bind(id).first<MediaRow>();
    return row ? asset(row) : null;
  }

  async getReadableAsset(id: string, accountId: string | null): Promise<ReadableMedia | null> {
    const row = await this.#db.prepare(`
      SELECT ${MEDIA_COLUMNS},
        CASE
          WHEN media_kind = 'account_avatar' OR media.state = 'pending' THEN 'private_account'
          ELSE 'public'
        END AS visibility
      FROM media_assets media
      WHERE media.id = ? AND media.deleted_at IS NULL
        AND (
          (media.media_kind = 'account_avatar' AND media.state = 'active' AND media.owner_account_id = ?)
          OR (media.media_kind = 'agent_avatar' AND media.state = 'active')
          OR (
            media.media_kind = 'post_image'
            AND media.state = 'active'
            AND EXISTS (
              SELECT 1 FROM records record
              WHERE record.id = media.attached_record_id
                AND record.current_revision_id = media.attached_revision_id
                AND record.lifecycle_state = 'published'
                AND record.deleted_at IS NULL
                AND record.moderation_state = 'visible'
              )
          )
          OR (
            media.media_kind = 'post_image'
            AND media.state = 'pending'
            AND EXISTS (
              SELECT 1 FROM agent_memberships membership
              WHERE membership.agent_id = media.owner_agent_id
                AND membership.account_id = ?
                AND membership.role = 'primary_sponsor'
                AND membership.revoked_at IS NULL
            )
            OR (
              media.media_kind = 'post_image'
              AND media.state = 'pending'
              AND EXISTS (
                SELECT 1 FROM account_roles role
                WHERE role.account_id = ? AND role.role = 'platform_owner' AND role.revoked_at IS NULL
              )
            )
          )
        )
      LIMIT 1
    `).bind(id, accountId, accountId, accountId).first<MediaRow & { visibility: ReadableMedia['visibility'] }>();
    return row ? { asset: asset(row), visibility: row.visibility } : null;
  }

  async listCleanupCandidates(input: Parameters<MediaRepository['listCleanupCandidates']>[0]): Promise<MediaAssetView[]> {
    const result = await this.#db.prepare(`
      SELECT ${MEDIA_COLUMNS}
      FROM media_assets
      WHERE deleted_at IS NULL AND (
        (state = 'staged' AND created_at <= ?)
        OR (state = 'orphaned' AND orphaned_at IS NOT NULL AND orphaned_at <= ?)
      )
      ORDER BY COALESCE(orphaned_at, created_at), id
      LIMIT ?
    `).bind(input.stagedBefore, input.orphanedBefore, input.limit).all<MediaRow>();
    return result.results.map(asset);
  }

  async markDeleted(input: Parameters<MediaRepository['markDeleted']>[0]): Promise<void> {
    await this.#db.prepare(`
      UPDATE media_assets
      SET state = 'deleted', deleted_at = ?, activated_at = NULL
      WHERE id = ? AND state IN ('staged', 'orphaned') AND deleted_at IS NULL
    `).bind(input.now, input.id).run();
  }
}
