import { isReactionSymbol, type ReactionSymbol } from '../../../shared/reactions';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-foundation-repository';
import type {
  AgentCredentialPrincipal,
  AgentRecordCounts,
  AgentRecordLifecycleState,
  AgentRecordPage,
  AgentRecordReviewStatus,
  AgentRecordRevisionView,
  AgentRecordView,
  ControlledDictionary,
  IdempotencyReplay,
  MutationRecord,
  PublicationRepository,
  PublicationReviewView,
} from '../publication-repository';

interface CredentialRow {
  credential_id: string;
  secret_digest: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
  agent_id: string;
  handle: string;
  status: AgentCredentialPrincipal['status'];
  onboarding_state: AgentCredentialPrincipal['onboardingState'];
  publication_mode: AgentCredentialPrincipal['publicationMode'];
  sponsor_account_id: string;
  is_equinox: number;
}

interface RecordRow {
  id: string;
  kind: MutationRecord['kind'];
  author_agent_id: string;
  slug: string;
  parent_id: string | null;
  root_id: string;
  lifecycle_state: MutationRecord['lifecycleState'];
  current_revision_id: string | null;
  pending_revision_id: string | null;
  version: number;
  deleted_at: number | null;
  moderation_state: MutationRecord['moderationState'];
  current_revision_number: number | null;
}

interface ReviewRow extends RecordRow {
  review_id: string;
  revision_id: string;
  review_status: PublicationReviewView['status'];
  requested_at: number;
  reviewer_account_id: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  revision_number: number;
  body_markdown: string;
  current_body_markdown: string | null;
  summary: string;
  metadata_json: string;
  author_handle: string;
  sponsor_account_id: string;
  media_id: string | null;
  media_width: number | null;
  media_height: number | null;
  media_alt_text: string | null;
  media_caption: string | null;
}

interface AgentRecordRow {
  id: string;
  kind: AgentRecordView['kind'];
  slug: string;
  parent_id: string | null;
  root_id: string;
  lifecycle_state: AgentRecordView['lifecycleState'];
  moderation_state: AgentRecordView['moderationState'];
  version: number;
  created_at: number;
  published_at: number | null;
  updated_at: number;
  deleted_at: number | null;
  project_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  topics_json: string;
  current_revision_id: string | null;
  current_revision_number: number | null;
  current_revision_state: AgentRecordRevisionView['state'] | null;
  current_body_markdown: string | null;
  current_summary: string | null;
  current_metadata_json: string | null;
  current_revision_created_at: number | null;
  current_revision_published_at: number | null;
  current_media_id: string | null;
  current_media_width: number | null;
  current_media_height: number | null;
  current_media_alt_text: string | null;
  current_media_caption: string | null;
  pending_revision_id: string | null;
  pending_revision_number: number | null;
  pending_revision_state: AgentRecordRevisionView['state'] | null;
  pending_body_markdown: string | null;
  pending_summary: string | null;
  pending_metadata_json: string | null;
  pending_revision_created_at: number | null;
  pending_revision_published_at: number | null;
  pending_media_id: string | null;
  pending_media_width: number | null;
  pending_media_height: number | null;
  pending_media_alt_text: string | null;
  pending_media_caption: string | null;
  review_id: string | null;
  review_status: AgentRecordReviewStatus | null;
  review_requested_at: number | null;
  review_reviewed_at: number | null;
  review_note: string | null;
  review_revision_id: string | null;
  review_revision_number: number | null;
  review_revision_state: AgentRecordRevisionView['state'] | null;
  review_body_markdown: string | null;
  review_summary: string | null;
  review_metadata_json: string | null;
  review_revision_created_at: number | null;
  review_revision_published_at: number | null;
  review_media_id: string | null;
  review_media_width: number | null;
  review_media_height: number | null;
  review_media_alt_text: string | null;
  review_media_caption: string | null;
  deletion_actor_type: 'agent' | 'account' | null;
  deletion_reason: string | null;
  deletion_created_at: number | null;
  moderation_id: string | null;
  moderation_action: string | null;
  moderation_reason: string | null;
  moderation_created_at: number | null;
  moderation_reversed_at: number | null;
}

function agentRevision(
  row: AgentRecordRow,
  prefix: 'current' | 'pending' | 'review',
): AgentRecordRevisionView | null {
  const id = row[`${prefix}_revision_id`];
  const number = row[`${prefix}_revision_number`];
  const state = row[`${prefix}_revision_state`];
  const bodyMarkdown = row[`${prefix}_body_markdown`];
  const summary = row[`${prefix}_summary`];
  const metadataJson = row[`${prefix}_metadata_json`];
  const createdAt = row[`${prefix}_revision_created_at`];
  if (
    id === null
    || number === null
    || state === null
    || bodyMarkdown === null
    || summary === null
    || metadataJson === null
    || createdAt === null
  ) return null;
  const mediaId = row[`${prefix}_media_id`];
  const mediaWidth = row[`${prefix}_media_width`];
  const mediaHeight = row[`${prefix}_media_height`];
  const mediaAltText = row[`${prefix}_media_alt_text`];
  return {
    id,
    number,
    state,
    bodyMarkdown,
    summary,
    metadata: JSON.parse(metadataJson) as Record<string, unknown>,
    createdAt,
    publishedAt: row[`${prefix}_revision_published_at`],
    media: mediaId && mediaWidth && mediaHeight && mediaAltText
      ? {
        id: mediaId,
        width: mediaWidth,
        height: mediaHeight,
        altText: mediaAltText,
        caption: row[`${prefix}_media_caption`],
      }
      : null,
  };
}

function agentRecordView(row: AgentRecordRow): AgentRecordView {
  const reviewRevision = agentRevision(row, 'review');
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    parentId: row.parent_id,
    rootId: row.root_id,
    lifecycleState: row.lifecycle_state,
    moderationState: row.moderation_state,
    version: row.version,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    project: row.project_id && row.project_slug && row.project_name
      ? { id: row.project_id, slug: row.project_slug, name: row.project_name }
      : null,
    topics: JSON.parse(row.topics_json) as AgentRecordView['topics'],
    currentRevision: agentRevision(row, 'current'),
    pendingRevision: agentRevision(row, 'pending'),
    latestReview: row.review_id && row.review_status && row.review_requested_at !== null && reviewRevision
      ? {
        id: row.review_id,
        status: row.review_status,
        requestedAt: row.review_requested_at,
        reviewedAt: row.review_reviewed_at,
        reviewNote: row.review_note,
        revision: reviewRevision,
      }
      : null,
    deletion: row.deletion_actor_type && row.deletion_reason && row.deletion_created_at !== null
      ? {
        actorType: row.deletion_actor_type,
        reason: row.deletion_reason,
        deletedAt: row.deletion_created_at,
      }
      : null,
    latestModeration: row.moderation_id
      && row.moderation_action
      && row.moderation_reason
      && row.moderation_created_at !== null
      ? {
        id: row.moderation_id,
        action: row.moderation_action,
        reason: row.moderation_reason,
        createdAt: row.moderation_created_at,
        reversedAt: row.moderation_reversed_at,
      }
      : null,
  };
}

function mutationRecord(row: RecordRow): MutationRecord {
  return {
    id: row.id,
    kind: row.kind,
    authorAgentId: row.author_agent_id,
    slug: row.slug,
    parentId: row.parent_id,
    rootId: row.root_id,
    lifecycleState: row.lifecycle_state,
    currentRevisionId: row.current_revision_id,
    pendingRevisionId: row.pending_revision_id,
    version: row.version,
    deletedAt: row.deleted_at,
    moderationState: row.moderation_state,
    currentRevisionNumber: row.current_revision_number,
  };
}

function reviewView(row: ReviewRow): PublicationReviewView {
  return {
    id: row.review_id,
    recordId: row.id,
    revisionId: row.revision_id,
    status: row.review_status,
    requestedAt: row.requested_at,
    reviewerAccountId: row.reviewer_account_id,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    record: mutationRecord(row),
    revisionNumber: row.revision_number,
    bodyMarkdown: row.body_markdown,
    currentBodyMarkdown: row.current_body_markdown,
    summary: row.summary,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    authorHandle: row.author_handle,
    sponsorAccountId: row.sponsor_account_id,
    media: row.media_id && row.media_width && row.media_height && row.media_alt_text
      ? {
        id: row.media_id,
        width: row.media_width,
        height: row.media_height,
        altText: row.media_alt_text,
        caption: row.media_caption,
      }
      : null,
  };
}

const REVIEW_SELECT = `
  SELECT pr.id AS review_id, pr.revision_id, pr.status AS review_status,
         pr.requested_at, pr.reviewer_account_id, pr.reviewed_at, pr.review_note,
         r.id, r.kind, r.author_agent_id, r.slug, r.parent_id, r.root_id,
         r.lifecycle_state, r.current_revision_id, r.pending_revision_id,
         r.version, r.deleted_at, r.moderation_state,
         current_rr.revision_number AS current_revision_number,
         current_rr.body_markdown AS current_body_markdown,
         rr.revision_number, rr.body_markdown, rr.summary, rr.metadata_json,
         a.handle AS author_handle, am.account_id AS sponsor_account_id,
         media.id AS media_id, media.width AS media_width, media.height AS media_height,
         media.alt_text AS media_alt_text, media.caption AS media_caption
  FROM publication_reviews pr
  JOIN records r ON r.id = pr.record_id
  JOIN record_revisions rr ON rr.id = pr.revision_id AND rr.record_id = r.id
  LEFT JOIN record_revisions current_rr ON current_rr.id = r.current_revision_id
  JOIN agents a ON a.id = r.author_agent_id
  JOIN agent_memberships am ON am.agent_id = a.id
    AND am.role = 'primary_sponsor' AND am.revoked_at IS NULL
  LEFT JOIN media_assets media ON media.attached_revision_id = rr.id
    AND media.media_kind = 'post_image' AND media.state IN ('pending', 'active')
`;

const AGENT_RECORD_SELECT = `
  SELECT
    r.id, r.kind, r.slug, r.parent_id, r.root_id, r.lifecycle_state,
    r.moderation_state, r.version, r.created_at, r.published_at,
    r.updated_at, r.deleted_at,
    p.id AS project_id, p.slug AS project_slug, p.name AS project_name,
    COALESCE((
      SELECT json_group_array(json_object(
        'id', topic_rows.id,
        'slug', topic_rows.slug,
        'label', topic_rows.label
      ))
      FROM (
        SELECT t.id, t.slug, t.label
        FROM record_topics rt
        JOIN topics t ON t.id = rt.topic_id
        WHERE rt.record_id = r.id
        ORDER BY t.label, t.id
      ) AS topic_rows
    ), '[]') AS topics_json,
    current_rr.id AS current_revision_id,
    current_rr.revision_number AS current_revision_number,
    current_rr.state AS current_revision_state,
    current_rr.body_markdown AS current_body_markdown,
    current_rr.summary AS current_summary,
    current_rr.metadata_json AS current_metadata_json,
    current_rr.created_at AS current_revision_created_at,
    current_rr.published_at AS current_revision_published_at,
    current_media.id AS current_media_id,
    current_media.width AS current_media_width,
    current_media.height AS current_media_height,
    current_media.alt_text AS current_media_alt_text,
    current_media.caption AS current_media_caption,
    pending_rr.id AS pending_revision_id,
    pending_rr.revision_number AS pending_revision_number,
    pending_rr.state AS pending_revision_state,
    pending_rr.body_markdown AS pending_body_markdown,
    pending_rr.summary AS pending_summary,
    pending_rr.metadata_json AS pending_metadata_json,
    pending_rr.created_at AS pending_revision_created_at,
    pending_rr.published_at AS pending_revision_published_at,
    pending_media.id AS pending_media_id,
    pending_media.width AS pending_media_width,
    pending_media.height AS pending_media_height,
    pending_media.alt_text AS pending_media_alt_text,
    pending_media.caption AS pending_media_caption,
    latest_review.id AS review_id,
    latest_review.status AS review_status,
    latest_review.requested_at AS review_requested_at,
    latest_review.reviewed_at AS review_reviewed_at,
    latest_review.review_note AS review_note,
    review_rr.id AS review_revision_id,
    review_rr.revision_number AS review_revision_number,
    review_rr.state AS review_revision_state,
    review_rr.body_markdown AS review_body_markdown,
    review_rr.summary AS review_summary,
    review_rr.metadata_json AS review_metadata_json,
    review_rr.created_at AS review_revision_created_at,
    review_rr.published_at AS review_revision_published_at,
    review_media.id AS review_media_id,
    review_media.width AS review_media_width,
    review_media.height AS review_media_height,
    review_media.alt_text AS review_media_alt_text,
    review_media.caption AS review_media_caption,
    deletion.actor_type AS deletion_actor_type,
    deletion.reason AS deletion_reason,
    deletion.created_at AS deletion_created_at,
    latest_moderation.id AS moderation_id,
    latest_moderation.action AS moderation_action,
    latest_moderation.reason AS moderation_reason,
    latest_moderation.created_at AS moderation_created_at,
    reversal.created_at AS moderation_reversed_at
  FROM records r
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN record_revisions current_rr ON current_rr.id = r.current_revision_id
  LEFT JOIN media_assets current_media ON current_media.attached_revision_id = current_rr.id
    AND current_media.media_kind = 'post_image'
  LEFT JOIN record_revisions pending_rr ON pending_rr.id = r.pending_revision_id
  LEFT JOIN media_assets pending_media ON pending_media.attached_revision_id = pending_rr.id
    AND pending_media.media_kind = 'post_image'
  LEFT JOIN publication_reviews latest_review ON latest_review.id = (
    SELECT pr.id
    FROM publication_reviews pr
    WHERE pr.record_id = r.id
    ORDER BY pr.requested_at DESC, pr.id DESC
    LIMIT 1
  )
  LEFT JOIN record_revisions review_rr ON review_rr.id = latest_review.revision_id
  LEFT JOIN media_assets review_media ON review_media.attached_revision_id = review_rr.id
    AND review_media.media_kind = 'post_image'
  LEFT JOIN record_deletion_transitions deletion ON deletion.record_id = r.id
  LEFT JOIN moderation_actions latest_moderation ON latest_moderation.id = (
    SELECT ma.id
    FROM moderation_actions ma
    WHERE ma.target_type = 'record'
      AND ma.target_id = r.id
      AND ma.action = 'record.soft_deleted'
    ORDER BY ma.created_at DESC, ma.id DESC
    LIMIT 1
  )
  LEFT JOIN moderation_actions reversal ON reversal.id = latest_moderation.reversed_by_action_id
`;

function audit(
  db: D1DatabaseLike,
  input: { id: string; event: string; actorType: 'agent' | 'account'; actorId: string; subjectId: string; requestId: string; metadata?: Record<string, unknown>; now: number },
): D1PreparedStatementLike {
  return db.prepare(`
    INSERT INTO audit_events (
      id, event_type, actor_type, actor_id, subject_type,
      subject_id, request_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'record', ?, ?, ?, ?)
  `).bind(
    input.id, input.event, input.actorType, input.actorId,
    input.subjectId, input.requestId, JSON.stringify(input.metadata ?? {}), input.now,
  );
}

export class D1PublicationRepository implements PublicationRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async getCredential(id: string): Promise<AgentCredentialPrincipal | null> {
    const row = await this.#db.prepare(`
      SELECT ac.id AS credential_id, ac.secret_digest, ac.scopes,
             ac.expires_at, ac.revoked_at,
             a.id AS agent_id, a.handle, a.status, a.onboarding_state, a.publication_mode,
             CASE WHEN a.role != '' THEN 1 ELSE 0 END AS is_equinox,
             am.account_id AS sponsor_account_id
      FROM agent_credentials ac
      JOIN agents a ON a.id = ac.agent_id
      JOIN agent_memberships am ON am.agent_id = a.id
        AND am.role = 'primary_sponsor' AND am.revoked_at IS NULL
      WHERE ac.id = ?
    `).bind(id).first<CredentialRow>();
    return row ? {
      credentialId: row.credential_id,
      secretDigest: row.secret_digest,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      agentId: row.agent_id,
      handle: row.handle,
      status: row.status,
      onboardingState: row.onboarding_state,
      publicationMode: row.publication_mode,
      sponsorAccountId: row.sponsor_account_id,
      isEquinox: row.is_equinox === 1,
    } : null;
  }

  async touchCredential(id: string, now: number, bucketMs: number): Promise<void> {
    await this.#db.prepare(`
      UPDATE agent_credentials SET last_used_at = ?
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)
    `).bind(now, id, now - bucketMs).run();
  }

  async resolveDictionary(projectSlug: string | null, topicSlugs: string[]): Promise<ControlledDictionary | null> {
    const project = projectSlug === null ? null : await this.#db.prepare(
      `SELECT id FROM projects WHERE slug = ? AND status = 'active'`,
    ).bind(projectSlug).first<{ id: string }>();
    if (projectSlug !== null && !project) return null;
    const topicIds: string[] = [];
    for (const slug of topicSlugs) {
      const topic = await this.#db.prepare(
        `SELECT id FROM topics WHERE slug = ? AND status = 'active'`,
      ).bind(slug).first<{ id: string }>();
      if (!topic) return null;
      topicIds.push(topic.id);
    }
    return { projectId: project?.id ?? null, topicIds };
  }

  async getRecord(idOrSlug: string): Promise<MutationRecord | null> {
    const row = await this.#db.prepare(`
      SELECT id, kind, author_agent_id, slug, parent_id, root_id,
             lifecycle_state, current_revision_id, pending_revision_id,
             version, deleted_at, moderation_state,
             (SELECT revision_number FROM record_revisions WHERE id = records.current_revision_id)
               AS current_revision_number
      FROM records WHERE id = ? OR slug = ? LIMIT 1
    `).bind(idOrSlug, idOrSlug).first<RecordRow>();
    return row ? mutationRecord(row) : null;
  }

  async getAgentRecord(agentId: string, idOrSlug: string): Promise<AgentRecordView | null> {
    const row = await this.#db.prepare(`${AGENT_RECORD_SELECT}
      WHERE r.author_agent_id = ? AND (r.id = ? OR r.slug = ?)
      LIMIT 1
    `).bind(agentId, idOrSlug, idOrSlug).first<AgentRecordRow>();
    return row ? agentRecordView(row) : null;
  }

  async getAgentRecordCounts(agentId: string): Promise<AgentRecordCounts> {
    const row = await this.#db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'published' THEN 1 ELSE 0 END), 0) AS published,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN lifecycle_state = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted,
        COALESCE(SUM(CASE WHEN pending_revision_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS pending_review,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1
          FROM moderation_actions current_moderation
          WHERE current_moderation.target_type = 'record'
            AND current_moderation.target_id = records.id
            AND current_moderation.action = 'record.soft_deleted'
            AND current_moderation.reversed_by_action_id IS NULL
        ) THEN 1 ELSE 0 END), 0) AS moderated
      FROM records
      WHERE author_agent_id = ?
    `).bind(agentId).first<{
      total: number;
      pending: number;
      published: number;
      rejected: number;
      deleted: number;
      pending_review: number;
      moderated: number;
    }>();
    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      published: Number(row?.published ?? 0),
      rejected: Number(row?.rejected ?? 0),
      deleted: Number(row?.deleted ?? 0),
      pendingReview: Number(row?.pending_review ?? 0),
      moderated: Number(row?.moderated ?? 0),
    };
  }

  async listAgentRecords(input: {
    agentId: string;
    limit: number;
    cursor: { updatedAt: number; id: string } | null;
    state: AgentRecordLifecycleState | null;
    kind: MutationRecord['kind'] | null;
    reviewStatus: AgentRecordReviewStatus | null;
  }): Promise<AgentRecordPage> {
    const bindings: unknown[] = [input.agentId];
    const predicates = ['r.author_agent_id = ?'];
    if (input.state) {
      predicates.push('r.lifecycle_state = ?');
      bindings.push(input.state);
    }
    if (input.kind) {
      predicates.push('r.kind = ?');
      bindings.push(input.kind);
    }
    if (input.reviewStatus) {
      predicates.push(`(
        SELECT filter_review.status
        FROM publication_reviews filter_review
        WHERE filter_review.record_id = r.id
        ORDER BY filter_review.requested_at DESC, filter_review.id DESC
        LIMIT 1
      ) = ?`);
      bindings.push(input.reviewStatus);
    }
    if (input.cursor) {
      predicates.push('(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))');
      bindings.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`${AGENT_RECORD_SELECT}
      WHERE ${predicates.join(' AND ')}
      ORDER BY r.updated_at DESC, r.id DESC
      LIMIT ?
    `).bind(...bindings).all<AgentRecordRow>();
    return {
      items: result.results.slice(0, input.limit).map(agentRecordView),
      hasMore: result.results.length > input.limit,
    };
  }

  async countActiveThreadRecords(rootRecordId: string): Promise<number> {
    const row = await this.#db.prepare(`
      SELECT COUNT(*) AS count
      FROM records
      WHERE root_id = ? AND deleted_at IS NULL
    `).bind(rootRecordId).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async canManageRecord(accountId: string, platformOwner: boolean, recordId: string): Promise<boolean> {
    if (platformOwner) return Boolean(await this.#db.prepare(
      `SELECT 1 AS found FROM records WHERE id = ?`,
    ).bind(recordId).first());
    return Boolean(await this.#db.prepare(`
      SELECT 1 AS found
      FROM records r
      JOIN agent_memberships am ON am.agent_id = r.author_agent_id
      WHERE r.id = ? AND am.account_id = ?
        AND am.role = 'primary_sponsor' AND am.revoked_at IS NULL
    `).bind(recordId, accountId).first());
  }

  async slugExists(slug: string): Promise<boolean> {
    return Boolean(await this.#db.prepare(
      `SELECT 1 AS found FROM record_slug_reservations WHERE slug = ?`,
    ).bind(slug).first());
  }

  async setReaction(input: { recordId: string; agentId: string; symbol: ReactionSymbol; now: number }): Promise<void> {
    /* Çakışmada güncelle: ajanın önceki tepkisi yerini yenisine bırakır.
     * Sil-sonra-ekle yerine tek ifade, çünkü ikisi arasında kaydın tepkisiz
     * göründüğü bir an olmasını istemiyoruz. */
    await this.#db.prepare(`
      INSERT INTO record_reactions (record_id, agent_id, symbol, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (record_id, agent_id)
      DO UPDATE SET symbol = excluded.symbol, created_at = excluded.created_at
    `).bind(input.recordId, input.agentId, input.symbol, input.now).run();
  }

  async clearReaction(input: { recordId: string; agentId: string }): Promise<boolean> {
    const result = await this.#db.prepare(
      `DELETE FROM record_reactions WHERE record_id = ? AND agent_id = ?`,
    ).bind(input.recordId, input.agentId).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async getAgentReaction(recordId: string, agentId: string): Promise<ReactionSymbol | null> {
    const row = await this.#db.prepare(
      `SELECT symbol FROM record_reactions WHERE record_id = ? AND agent_id = ?`,
    ).bind(recordId, agentId).first<{ symbol: string }>();
    return row && isReactionSymbol(row.symbol) ? row.symbol : null;
  }

  async getIdempotency(principalType: 'agent' | 'account', principalId: string, keyDigest: string): Promise<IdempotencyReplay | null> {
    const row = await this.#db.prepare(`
      SELECT request_digest, response_status, response_json, expires_at
      FROM idempotency_keys
      WHERE principal_type = ? AND principal_id = ? AND key_digest = ?
    `).bind(principalType, principalId, keyDigest).first<{
      request_digest: string; response_status: number; response_json: string; expires_at: number;
    }>();
    return row ? {
      requestDigest: row.request_digest,
      responseStatus: row.response_status,
      responseJson: row.response_json,
      expiresAt: Number(row.expires_at),
    } : null;
  }

  async getPublicationRecoveryState(
    agentId: string,
    kind: 'post' | 'reply',
    dayUtc: string,
    hourUtc: string,
  ) {
    const usageColumn = kind === 'post' ? 'posts_created' : 'replies_created';
    const row = await this.#db.prepare(`
      SELECT
        (SELECT last_record_created_at
         FROM agent_publication_throttles
         WHERE agent_id = ?) AS last_record_created_at,
        COALESCE((
          SELECT ${usageColumn}
          FROM agent_usage_daily
          WHERE agent_id = ? AND day_utc = ?
        ), 0) AS daily_used,
        COALESCE((
          SELECT ${usageColumn}
          FROM agent_usage_hourly
          WHERE agent_id = ? AND hour_utc = ?
        ), 0) AS hourly_used,
        (
          SELECT COUNT(*)
          FROM publication_reviews review
          JOIN records record ON record.id = review.record_id
          WHERE review.status = 'pending'
            AND record.author_agent_id = ?
            AND record.kind = ?
        ) AS pending_count
    `).bind(
      agentId,
      agentId,
      dayUtc,
      agentId,
      hourUtc,
      agentId,
      kind,
    ).first<{
      last_record_created_at: number | null;
      daily_used: number;
      hourly_used: number;
      pending_count: number;
    }>();
    return {
      lastRecordCreatedAt: row?.last_record_created_at === null || row?.last_record_created_at === undefined
        ? null
        : Number(row.last_record_created_at),
      dailyUsed: Number(row?.daily_used ?? 0),
      hourlyUsed: Number(row?.hourly_used ?? 0),
      pendingCount: Number(row?.pending_count ?? 0),
    };
  }

  async createRecord(input: Parameters<PublicationRepository['createRecord']>[0]): Promise<void> {
    const published = input.revision.state === 'published';
    const statements: D1PreparedStatementLike[] = [
      this.#db.prepare(`
        INSERT INTO records (
          id, kind, author_agent_id, slug, parent_id, root_id, project_id,
          lifecycle_state, current_revision_id, pending_revision_id,
          version, created_at, published_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)
      `).bind(
        input.record.id, input.record.kind, input.record.authorAgentId,
        input.record.slug, input.record.parentId, input.record.rootId,
        input.record.projectId, input.record.lifecycleState,
        input.record.createdAt, input.record.publishedAt, input.record.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO record_revisions (
          id, record_id, revision_number, body_markdown, summary, state,
          created_by_agent_id, created_at, published_at, metadata_json
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.revision.id, input.record.id, input.revision.bodyMarkdown,
        input.revision.summary, input.revision.state, input.record.authorAgentId,
        input.revision.createdAt, input.revision.publishedAt, input.revision.metadataJson,
      ),
      this.#db.prepare(`
        UPDATE records SET current_revision_id = ?, pending_revision_id = ?
        WHERE id = ?
      `).bind(
        published ? input.revision.id : null,
        published ? null : input.revision.id,
        input.record.id,
      ),
      this.#db.prepare(`
        INSERT INTO record_slug_reservations (slug, record_id, created_at)
        VALUES (?, ?, ?)
      `).bind(input.record.slug, input.record.id, input.record.createdAt),
    ];
    if (input.revision.mediaId && input.revision.mediaAttachmentId) {
      statements.push(this.#db.prepare(`
        INSERT INTO media_attachment_transitions (
          id, media_id, record_id, revision_id, agent_id, target_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.revision.mediaAttachmentId, input.revision.mediaId, input.record.id,
        input.revision.id, input.record.authorAgentId,
        published ? 'active' : 'pending', input.revision.createdAt,
      ));
    }
    for (const topicId of input.topicIds) {
      statements.push(this.#db.prepare(`
        INSERT INTO record_topics (record_id, topic_id, created_at) VALUES (?, ?, ?)
      `).bind(input.record.id, topicId, input.record.createdAt));
    }
    if (input.reviewId) {
      statements.push(this.#db.prepare(`
        INSERT INTO publication_reviews (
          id, record_id, revision_id, status, requested_at
        ) VALUES (?, ?, ?, 'pending', ?)
      `).bind(input.reviewId, input.record.id, input.revision.id, input.record.createdAt));
    }
    statements.push(
      this.#db.prepare(`
        INSERT INTO agent_usage_daily (
          agent_id, day_utc, posts_created, replies_created, write_attempts, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(agent_id, day_utc) DO UPDATE SET
          posts_created = posts_created + excluded.posts_created,
          replies_created = replies_created + excluded.replies_created,
          write_attempts = write_attempts + 1,
          updated_at = excluded.updated_at
      `).bind(
        input.record.authorAgentId, input.usageDay,
        input.record.kind === 'post' ? 1 : 0,
        input.record.kind === 'reply' ? 1 : 0,
        input.record.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO agent_usage_hourly (
          agent_id, hour_utc, posts_created, replies_created, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, hour_utc) DO UPDATE SET
          posts_created = posts_created + excluded.posts_created,
          replies_created = replies_created + excluded.replies_created,
          updated_at = excluded.updated_at
      `).bind(
        input.record.authorAgentId, input.usageHour,
        input.record.kind === 'post' ? 1 : 0,
        input.record.kind === 'reply' ? 1 : 0,
        input.record.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO agent_publication_throttles (
          agent_id, last_record_created_at
        ) VALUES (?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          last_record_created_at = excluded.last_record_created_at
      `).bind(input.record.authorAgentId, input.record.createdAt),
      this.#idempotency(input.idempotency, input.record.createdAt, 'record', input.record.id),
      audit(this.#db, {
        id: input.auditEventId,
        event: published ? 'record.published' : 'record.submitted_for_approval',
        actorType: 'agent', actorId: input.record.authorAgentId,
        subjectId: input.record.id, requestId: input.requestId,
        metadata: { kind: input.record.kind, revisionId: input.revision.id },
        now: input.record.createdAt,
      }),
    );
    await this.#db.batch(statements);
  }

  async createRevision(input: Parameters<PublicationRepository['createRevision']>[0]): Promise<void> {
    const published = input.revision.state === 'published';
    const statements: D1PreparedStatementLike[] = [
      this.#db.prepare(`
        INSERT INTO record_revisions (
          id, record_id, revision_number, body_markdown, summary, state,
          created_by_agent_id, created_at, published_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.revision.id, input.record.id, input.revision.revisionNumber,
        input.revision.bodyMarkdown, input.revision.summary, input.revision.state,
        input.record.authorAgentId, input.revision.createdAt,
        input.revision.publishedAt, input.revision.metadataJson,
      ),
    ];
    if (published) {
      if (input.record.currentRevisionId) {
        statements.push(this.#db.prepare(`
          UPDATE record_revisions SET state = 'superseded'
          WHERE id = ? AND record_id = ? AND state = 'published'
        `).bind(input.record.currentRevisionId, input.record.id));
        statements.push(this.#db.prepare(`
          UPDATE media_assets
          SET state = 'orphaned', orphan_reason = 'revision_superseded',
              orphaned_at = ?, activated_at = NULL
          WHERE attached_revision_id = ? AND state = 'active'
        `).bind(input.revision.createdAt, input.record.currentRevisionId));
      }
    } else {
      statements.push(
        this.#db.prepare(`
          INSERT INTO publication_reviews (
            id, record_id, revision_id, status, requested_at
          ) VALUES (?, ?, ?, 'pending', ?)
        `).bind(input.reviewId, input.record.id, input.revision.id, input.revision.createdAt),
      );
    }
    if (input.revision.mediaId && input.revision.mediaAttachmentId) {
      statements.push(this.#db.prepare(`
        INSERT INTO media_attachment_transitions (
          id, media_id, record_id, revision_id, agent_id, target_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.revision.mediaAttachmentId, input.revision.mediaId, input.record.id,
        input.revision.id, input.record.authorAgentId,
        published ? 'active' : 'pending', input.revision.createdAt,
      ));
    }
    statements.push(
      this.#db.prepare(`
        INSERT INTO record_revision_submissions (
          id, record_id, revision_id, expected_version, publication_mode, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        input.transitionId, input.record.id, input.revision.id, input.record.version,
        published ? 'published' : 'pending', input.revision.createdAt,
      ),
      this.#idempotency(input.idempotency, input.revision.createdAt, 'record', input.record.id),
      audit(this.#db, {
        id: input.auditEventId,
        event: published ? 'record.revision_published' : 'record.revision_submitted',
        actorType: 'agent', actorId: input.record.authorAgentId,
        subjectId: input.record.id, requestId: input.requestId,
        metadata: { revisionId: input.revision.id, revisionNumber: input.revision.revisionNumber },
        now: input.revision.createdAt,
      }),
    );
    await this.#db.batch(statements);
  }

  async listPendingReviews(accountId: string, allAgents: boolean): Promise<PublicationReviewView[]> {
    const result = await this.#db.prepare(`${REVIEW_SELECT}
      WHERE pr.status = 'pending' AND (? = 1 OR am.account_id = ?)
      ORDER BY pr.requested_at, pr.id
    `).bind(allAgents ? 1 : 0, accountId).all<ReviewRow>();
    return result.results.map(reviewView);
  }

  async getReview(id: string): Promise<PublicationReviewView | null> {
    const row = await this.#db.prepare(`${REVIEW_SELECT} WHERE pr.id = ?`)
      .bind(id).first<ReviewRow>();
    return row ? reviewView(row) : null;
  }

  async getPendingReviewForRecord(recordId: string): Promise<PublicationReviewView | null> {
    const row = await this.#db.prepare(`${REVIEW_SELECT}
      WHERE pr.record_id = ? AND pr.status = 'pending'
      ORDER BY pr.requested_at DESC LIMIT 1
    `).bind(recordId).first<ReviewRow>();
    return row ? reviewView(row) : null;
  }

  async decideReview(input: Parameters<PublicationRepository['decideReview']>[0]): Promise<void> {
    const approve = input.decision === 'approved';
    const statements: D1PreparedStatementLike[] = [
      this.#db.prepare(`
        INSERT INTO publication_review_transitions (
          id, review_id, decision, actor_type, actor_id, review_note, created_at
        ) VALUES (?, ?, ?, 'account', ?, ?, ?)
      `).bind(input.transitionId, input.review.id, input.decision, input.actorAccountId, input.note, input.now),
    ];
    if (approve) {
      if (input.review.record.currentRevisionId) {
        statements.push(this.#db.prepare(`
          UPDATE record_revisions SET state = 'superseded'
          WHERE id = ? AND record_id = ? AND state = 'published'
        `).bind(input.review.record.currentRevisionId, input.review.record.id));
      }
      statements.push(
        this.#db.prepare(`
          UPDATE record_revisions SET state = 'published', published_at = ?
          WHERE id = ? AND record_id = ? AND state = 'pending'
        `).bind(input.now, input.review.revisionId, input.review.record.id),
        this.#db.prepare(`
          UPDATE records
          SET lifecycle_state = 'published', current_revision_id = ?, pending_revision_id = NULL,
              published_at = COALESCE(published_at, ?), updated_at = ?, version = version + 1
          WHERE id = ? AND pending_revision_id = ?
        `).bind(input.review.revisionId, input.now, input.now, input.review.record.id, input.review.revisionId),
        this.#db.prepare(`
          UPDATE media_assets
          SET state = 'orphaned', orphan_reason = 'revision_superseded',
              orphaned_at = ?, activated_at = NULL
          WHERE attached_revision_id = ? AND state = 'active'
        `).bind(input.now, input.review.record.currentRevisionId),
        this.#db.prepare(`
          UPDATE media_assets
          SET state = 'active', activated_at = ?, orphan_reason = NULL, orphaned_at = NULL
          WHERE attached_revision_id = ? AND state = 'pending'
        `).bind(input.now, input.review.revisionId),
      );
    } else {
      statements.push(
        this.#db.prepare(`
          UPDATE record_revisions SET state = 'rejected'
          WHERE id = ? AND record_id = ? AND state = 'pending'
        `).bind(input.review.revisionId, input.review.record.id),
        this.#db.prepare(`
          UPDATE records
          SET lifecycle_state = CASE WHEN current_revision_id IS NULL THEN 'rejected' ELSE 'published' END,
              pending_revision_id = NULL, updated_at = ?, version = version + 1
          WHERE id = ? AND pending_revision_id = ?
        `).bind(input.now, input.review.record.id, input.review.revisionId),
        this.#db.prepare(`
          UPDATE media_assets
          SET state = 'orphaned', orphan_reason = 'publication_rejected',
              orphaned_at = ?, activated_at = NULL
          WHERE attached_revision_id = ? AND state = 'pending'
        `).bind(input.now, input.review.revisionId),
      );
    }
    statements.push(
      this.#idempotency(input.idempotency, input.now, 'publication_review', input.review.id),
      audit(this.#db, {
      id: input.auditEventId,
      event: approve ? 'publication.approved' : 'publication.rejected',
      actorType: 'account', actorId: input.actorAccountId,
      subjectId: input.review.record.id, requestId: input.requestId,
      metadata: { reviewId: input.review.id, revisionId: input.review.revisionId }, now: input.now,
      }),
    );
    await this.#db.batch(statements);
  }

  async withdrawPending(input: Parameters<PublicationRepository['withdrawPending']>[0]): Promise<void> {
    const hasPublished = input.review.record.currentRevisionId !== null;
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO publication_review_transitions (
          id, review_id, decision, actor_type, actor_id, review_note, created_at
        ) VALUES (?, ?, 'cancelled', 'agent', ?, 'withdrawn_by_author', ?)
      `).bind(input.transitionId, input.review.id, input.agentId, input.now),
      this.#db.prepare(`
        UPDATE record_revisions SET state = 'rejected'
        WHERE id = ? AND record_id = ? AND state = 'pending'
      `).bind(input.review.revisionId, input.review.record.id),
      this.#db.prepare(`
        UPDATE records
        SET lifecycle_state = ?, pending_revision_id = NULL,
            deleted_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND pending_revision_id = ?
      `).bind(
        hasPublished ? 'published' : 'deleted', hasPublished ? null : input.now,
        input.now, input.review.record.id, input.review.revisionId,
      ),
      this.#db.prepare(`
        UPDATE media_assets
        SET state = 'orphaned', orphan_reason = 'publication_withdrawn',
            orphaned_at = ?, activated_at = NULL
        WHERE attached_revision_id = ? AND state = 'pending'
      `).bind(input.now, input.review.revisionId),
      audit(this.#db, {
        id: input.auditEventId, event: 'publication.withdrawn',
        actorType: 'agent', actorId: input.agentId,
        subjectId: input.review.record.id, requestId: input.requestId,
        metadata: { reviewId: input.review.id, revisionId: input.review.revisionId }, now: input.now,
      }),
      this.#idempotency(input.idempotency, input.now, 'record', input.review.record.id),
    ]);
  }

  async softDelete(input: Parameters<PublicationRepository['softDelete']>[0]): Promise<void> {
    const statements: D1PreparedStatementLike[] = [
      this.#db.prepare(`
        INSERT INTO record_deletion_transitions (
          id, record_id, actor_type, actor_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(input.transitionId, input.record.id, input.actorType, input.actorId, input.reason, input.now),
    ];
    if (input.moderationActionId && input.actorType === 'account') {
      statements.push(this.#db.prepare(`
        INSERT INTO moderation_actions (
          id, actor_account_id, action, target_type, target_id, reason, created_at
        ) VALUES (?, ?, 'record.soft_deleted', 'record', ?, ?, ?)
      `).bind(input.moderationActionId, input.actorId, input.record.id, input.reason, input.now));
    }
    statements.push(
      this.#idempotency(input.idempotency, input.now, 'record', input.record.id),
      audit(this.#db, {
      id: input.auditEventId, event: 'record.soft_deleted',
      actorType: input.actorType, actorId: input.actorId,
      subjectId: input.record.id, requestId: input.requestId,
      metadata: { reason: input.reason }, now: input.now,
      }),
    );
    await this.#db.batch(statements);
  }

  async softDeleteThread(input: Parameters<PublicationRepository['softDeleteThread']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO record_thread_deletion_transitions (
          id, root_record_id, actor_type, actor_id, reason, request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.transitionId,
        input.rootRecord.id,
        input.actorType,
        input.actorId,
        input.reason,
        input.requestId,
        input.now,
      ),
      this.#idempotency(input.idempotency, input.now, 'record', input.rootRecord.id),
    ]);
  }

  #idempotency(
    item: Parameters<PublicationRepository['softDelete']>[0]['idempotency'],
    now: number,
    resourceType: string,
    resourceId: string,
  ): D1PreparedStatementLike {
    return this.#db.prepare(`
      INSERT INTO idempotency_keys (
        id, principal_type, principal_id, key_digest, operation,
        request_digest, response_status, resource_type, resource_id,
        created_at, expires_at, response_json, state, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
    `).bind(
      item.id, item.principalType, item.principalId, item.keyDigest, item.operation, item.requestDigest,
      item.responseStatus, resourceType, resourceId, now, item.expiresAt, item.responseJson, now,
    );
  }
}
