import type {
  CreateRecordCommand,
  FoundationRepository,
  RedeemInvitationCommand,
  RepositoryMetricsSnapshot,
  RotateAgentCredentialCommand,
} from '../foundation-repository';
import { QueryMeter } from './query-meter';

export interface D1RunResultLike {
  success: boolean;
  meta?: {
    changes?: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run<T = D1RunResultLike>(): Promise<T>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
}

export class D1FoundationRepository implements FoundationRepository {
  readonly #db: D1DatabaseLike;
  readonly #meter: QueryMeter;

  constructor(db: D1DatabaseLike, meter = new QueryMeter()) {
    this.#db = db;
    this.#meter = meter;
  }

  async redeemInvitation(command: RedeemInvitationCommand): Promise<void> {
    const statements = [
      this.#db.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, display_name, avatar_url,
          status, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(
        command.account.id,
        command.account.handle,
        command.account.handle.toLowerCase(),
        command.account.displayName,
        command.account.avatarUrl ?? null,
        command.now,
        command.now,
        command.now,
      ),
      this.#db.prepare(`
        INSERT INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'github', ?, ?, ?, ?)
      `).bind(
        command.githubIdentityId,
        command.account.id,
        command.githubUserId,
        command.githubLogin,
        command.now,
        command.now,
      ),
      this.#db.prepare(`
        INSERT INTO account_roles (
          id, account_id, role, granted_by_account_id, granted_at
        ) VALUES (?, ?, 'member', NULL, ?)
      `).bind(`${command.account.id}:member`, command.account.id, command.now),
      this.#db.prepare(`
        INSERT INTO account_quotas (
          account_id, quota_key, limit_value, updated_by_account_id, updated_at
        ) VALUES (?, 'agents.max_active', ?, NULL, ?)
      `).bind(command.account.id, command.agentQuota, command.now),
      this.#db.prepare(`
        INSERT INTO sessions (
          id, account_id, secret_digest, hash_version, csrf_digest,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        command.session.id,
        command.account.id,
        command.session.secretDigest,
        command.session.hashVersion,
        command.session.csrfDigest,
        command.now,
        command.now,
        command.session.idleExpiresAt,
        command.session.absoluteExpiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'invitation.redeemed', 'account', ?, 'invitation', ?, ?, '{}', ?)
      `).bind(
        command.auditEventId,
        command.account.id,
        command.invitationId,
        command.requestId,
        command.now,
      ),
      this.#db.prepare(`
        INSERT INTO invitation_redemptions (
          invitation_id, account_id, github_user_id, redeemed_at
        ) VALUES (?, ?, ?, ?)
      `).bind(
        command.invitationId,
        command.account.id,
        command.githubUserId,
        command.now,
      ),
    ];

    this.#meter.recordBatch('invitation.redeem', statements.length);
    await this.#db.batch(statements);
  }

  async rotateAgentCredential(command: RotateAgentCredentialCommand): Promise<void> {
    const statements = [
      this.#db.prepare(`
        UPDATE agent_credentials
        SET revoked_at = ?, revoked_reason = 'rotated'
        WHERE id = ? AND agent_id = ? AND revoked_at IS NULL
      `).bind(command.now, command.expectedCredentialId, command.agentId),
      this.#db.prepare(`
        INSERT INTO agent_credentials (
          id, agent_id, secret_digest, hash_version, scopes,
          created_by_account_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        command.replacement.id,
        command.agentId,
        command.replacement.secretDigest,
        command.replacement.hashVersion,
        command.replacement.scopes,
        command.sponsorAccountId,
        command.replacement.createdAt,
        command.replacement.expiresAt ?? null,
      ),
      this.#db.prepare(`
        UPDATE agent_credentials
        SET replaced_by_credential_id = ?
        WHERE id = ? AND agent_id = ? AND revoked_at = ?
      `).bind(
        command.replacement.id,
        command.expectedCredentialId,
        command.agentId,
        command.now,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.credential_rotated', 'account', ?, 'agent', ?, ?, '{}', ?)
      `).bind(
        command.auditEventId,
        command.sponsorAccountId,
        command.agentId,
        command.requestId,
        command.now,
      ),
    ];

    this.#meter.recordBatch('agent_credential.rotate', statements.length);
    await this.#db.batch(statements);
  }

  async createRecordWithRevision(command: CreateRecordCommand): Promise<void> {
    const currentRevisionId = command.record.lifecycleState === 'published'
      ? command.revision.id
      : null;
    const pendingRevisionId = command.record.lifecycleState === 'pending'
      ? command.revision.id
      : null;

    const statements = [
      this.#db.prepare(`
        INSERT INTO records (
          id, kind, author_agent_id, slug, parent_id, root_id, project_id,
          lifecycle_state, current_revision_id, pending_revision_id,
          version, created_at, published_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)
      `).bind(
        command.record.id,
        command.record.kind,
        command.record.authorAgentId,
        command.record.slug,
        command.record.parentId ?? null,
        command.record.rootId,
        command.record.projectId ?? null,
        command.record.lifecycleState,
        command.record.createdAt,
        command.record.publishedAt ?? null,
        command.record.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO record_revisions (
          id, record_id, revision_number, body_markdown, summary, state,
          created_by_agent_id, created_at, published_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).bind(
        command.revision.id,
        command.record.id,
        command.revision.bodyMarkdown,
        command.revision.summary,
        command.revision.state,
        command.revision.createdByAgentId,
        command.revision.createdAt,
        command.revision.publishedAt ?? null,
      ),
      this.#db.prepare(`
        UPDATE records
        SET current_revision_id = ?, pending_revision_id = ?
        WHERE id = ?
      `).bind(currentRevisionId, pendingRevisionId, command.record.id),
    ];

    this.#meter.recordBatch('record.create_with_revision', statements.length);
    await this.#db.batch(statements);
  }

  async setCurrentRevision(recordId: string, revisionId: string, now: number): Promise<void> {
    this.#meter.recordStatement('record.set_current_revision');
    await this.#db.prepare(`
      UPDATE records
      SET current_revision_id = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).bind(revisionId, now, recordId).run();
  }

  metrics(): RepositoryMetricsSnapshot {
    return this.#meter.snapshot();
  }
}
