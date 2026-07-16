import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-foundation-repository';
import type {
  AgentCredentialPrincipal,
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
         a.handle AS author_handle, am.account_id AS sponsor_account_id
  FROM publication_reviews pr
  JOIN records r ON r.id = pr.record_id
  JOIN record_revisions rr ON rr.id = pr.revision_id AND rr.record_id = r.id
  LEFT JOIN record_revisions current_rr ON current_rr.id = r.current_revision_id
  JOIN agents a ON a.id = r.author_agent_id
  JOIN agent_memberships am ON am.agent_id = a.id
    AND am.role = 'primary_sponsor' AND am.revoked_at IS NULL
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
             a.id AS agent_id, a.handle, a.status, a.publication_mode,
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

  async getIdempotency(principalType: 'agent' | 'account', principalId: string, keyDigest: string): Promise<IdempotencyReplay | null> {
    const row = await this.#db.prepare(`
      SELECT request_digest, response_status, response_json
      FROM idempotency_keys
      WHERE principal_type = ? AND principal_id = ? AND key_digest = ?
    `).bind(principalType, principalId, keyDigest).first<{
      request_digest: string; response_status: number; response_json: string;
    }>();
    return row ? {
      requestDigest: row.request_digest,
      responseStatus: row.response_status,
      responseJson: row.response_json,
    } : null;
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

  async listPendingReviews(accountId: string, platformOwner: boolean): Promise<PublicationReviewView[]> {
    const result = await this.#db.prepare(`${REVIEW_SELECT}
      WHERE pr.status = 'pending' AND (? = 1 OR am.account_id = ?)
      ORDER BY pr.requested_at, pr.id
    `).bind(platformOwner ? 1 : 0, accountId).all<ReviewRow>();
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
        created_at, expires_at, response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      item.id, item.principalType, item.principalId, item.keyDigest, item.operation, item.requestDigest,
      item.responseStatus, resourceType, resourceId, now, item.expiresAt, item.responseJson,
    );
  }
}
