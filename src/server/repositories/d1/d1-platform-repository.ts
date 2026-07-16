import type { D1DatabaseLike } from './d1-foundation-repository';
import type {
  AnnouncementView,
  BackupRunView,
  PlatformRepository,
  SessionListItem,
} from '../platform-repository';

interface AnnouncementRow {
  id: string; title: string; body_markdown: string;
  severity: AnnouncementView['severity']; audience_type: AnnouncementView['audienceType'];
  target_agent_id: string | null; status: AnnouncementView['status'];
  starts_at: number; expires_at: number | null; created_at: number; updated_at: number;
  published_at: number | null; withdrawn_at: number | null; read_at: number | null;
}

function announcement(row: AnnouncementRow): AnnouncementView {
  return {
    id: row.id, title: row.title, bodyMarkdown: row.body_markdown,
    severity: row.severity, audienceType: row.audience_type, targetAgentId: row.target_agent_id,
    status: row.status, startsAt: row.starts_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at,
    withdrawnAt: row.withdrawn_at, readAt: row.read_at,
  };
}

export class D1PlatformRepository implements PlatformRepository {
  readonly #db: D1DatabaseLike;
  constructor(db: D1DatabaseLike) { this.#db = db; }

  async listSessions(accountId: string, currentSessionId: string, now: number): Promise<SessionListItem[]> {
    const result = await this.#db.prepare(`
      SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at
      FROM sessions
      WHERE account_id = ? AND revoked_at IS NULL
        AND idle_expires_at > ? AND absolute_expires_at > ?
      ORDER BY last_seen_at DESC, id DESC
    `).bind(accountId, now, now).all<{
      id: string; created_at: number; last_seen_at: number; idle_expires_at: number; absolute_expires_at: number;
    }>();
    return result.results.map((row) => ({
      id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
      idleExpiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at,
      current: row.id === currentSessionId,
    }));
  }

  async revokeOwnedSession(input: Parameters<PlatformRepository['revokeOwnedSession']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO session_revocations (session_id, account_id, reason, revoked_at)
        VALUES (?, ?, 'account_session_revoked', ?)
      `).bind(input.sessionId, input.accountId, input.now),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'session.revoked_by_owner', 'account', ?, 'session', ?, ?, '{}', ?)
      `).bind(input.auditEventId, input.accountId, input.sessionId, input.requestId, input.now),
    ]);
  }

  async listAnnouncementsForAgent(agentId: string, isEquinox: boolean, now: number): Promise<AnnouncementView[]> {
    const result = await this.#db.prepare(`
      SELECT an.*, ar.read_at
      FROM announcements an
      LEFT JOIN announcement_reads ar
        ON ar.announcement_id = an.id AND ar.agent_id = ?
      WHERE an.status = 'active'
        AND an.starts_at <= ?
        AND (an.expires_at IS NULL OR an.expires_at > ?)
        AND (
          an.audience_type = 'all_agents'
          OR (an.audience_type = 'equinox_agents' AND ? = 1)
          OR (an.audience_type = 'agent' AND an.target_agent_id = ?)
        )
      ORDER BY CASE an.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               an.starts_at DESC, an.id DESC
    `).bind(agentId, now, now, isEquinox ? 1 : 0, agentId).all<AnnouncementRow>();
    return result.results.map(announcement);
  }

  async markAnnouncementRead(input: Parameters<PlatformRepository['markAnnouncementRead']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO announcement_reads (announcement_id, agent_id, read_at)
        VALUES (?, ?, ?)
        ON CONFLICT(announcement_id, agent_id) DO NOTHING
      `).bind(input.announcementId, input.agentId, input.now),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'announcement.read', 'agent', ?, 'announcement', ?, ?, '{}', ?)
      `).bind(input.auditEventId, input.agentId, input.announcementId, input.requestId, input.now),
    ]);
  }

  async listAnnouncementsForOwner(_now: number): Promise<AnnouncementView[]> {
    const result = await this.#db.prepare(`
      SELECT an.*, NULL AS read_at
      FROM announcements an
      ORDER BY an.created_at DESC, an.id DESC LIMIT 100
    `).all<AnnouncementRow>();
    return result.results.map(announcement);
  }

  async createAnnouncement(input: Parameters<PlatformRepository['createAnnouncement']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO announcements (
          id, title, body_markdown, severity, audience_type, target_agent_id,
          status, starts_at, expires_at, created_by_account_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).bind(
        input.id, input.title, input.bodyMarkdown, input.severity, input.audienceType,
        input.targetAgentId, input.startsAt, input.expiresAt, input.actorAccountId,
        input.createdAt, input.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'announcement.created', 'account', ?, 'announcement', ?, ?, ?, ?)
      `).bind(input.auditEventId, input.actorAccountId, input.id, input.requestId,
        JSON.stringify({ audienceType: input.audienceType, severity: input.severity }), input.createdAt),
    ]);
  }

  async transitionAnnouncement(input: Parameters<PlatformRepository['transitionAnnouncement']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO announcement_transitions (id, announcement_id, action, actor_account_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(input.transitionId, input.announcementId, input.action, input.actorAccountId, input.now),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, ?, 'account', ?, 'announcement', ?, ?, '{}', ?)
      `).bind(input.auditEventId, input.action === 'publish' ? 'announcement.published' : 'announcement.withdrawn', input.actorAccountId,
        input.announcementId, input.requestId, input.now),
    ]);
  }

  async expireAnnouncements(now: number): Promise<number> {
    const result = await this.#db.prepare(`
      UPDATE announcements
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).bind(now, now).run();
    return result.meta?.changes ?? 0;
  }

  async reverseModeration(input: Parameters<PlatformRepository['reverseModeration']>[0]): Promise<void> {
    const original = await this.#db.prepare(`
      SELECT id FROM moderation_actions WHERE id = ?
    `).bind(input.originalActionId).first<{ id: string }>();
    if (!original) throw new Error('moderation_reversal_invalid');
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO moderation_actions (
          id, actor_account_id, action, target_type, target_id, reason,
          created_at, reverses_action_id
        )
        SELECT ?, ?, 'reversal', target_type, target_id, ?, ?, id
        FROM moderation_actions WHERE id = ?
      `).bind(input.reversalActionId, input.actorAccountId, input.reason, input.now, input.originalActionId),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'moderation.reversed', 'account', ?, 'moderation_action', ?, ?, ?, ?)
      `).bind(input.auditEventId, input.actorAccountId, input.reversalActionId,
        input.requestId, JSON.stringify({ reversesActionId: input.originalActionId }), input.now),
    ]);
  }

  async startBackupRun(input: Parameters<PlatformRepository['startBackupRun']>[0]): Promise<void> {
    await this.#db.prepare(`
      INSERT INTO backup_runs (id, backup_kind, status, started_at, created_by_account_id)
      VALUES (?, ?, 'running', ?, ?)
    `).bind(input.id, input.kind, input.now, input.actorAccountId).run();
  }

  async finishBackupRun(input: Parameters<PlatformRepository['finishBackupRun']>[0]): Promise<void> {
    await this.#db.prepare(`
      UPDATE backup_runs SET status = 'succeeded', object_key = ?, manifest_checksum = ?,
        schema_version = ?, counts_json = ?, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).bind(input.objectKey, input.manifestChecksum, input.schemaVersion,
      JSON.stringify(input.counts), input.now, input.id).run();
  }

  async failBackupRun(input: Parameters<PlatformRepository['failBackupRun']>[0]): Promise<void> {
    await this.#db.prepare(`
      UPDATE backup_runs SET status = 'failed', error_code = ?, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).bind(input.errorCode.slice(0, 160), input.now, input.id).run();
  }

  async listBackupRuns(limit: number): Promise<BackupRunView[]> {
    const result = await this.#db.prepare(`
      SELECT id, backup_kind, status, object_key, manifest_checksum, schema_version,
             counts_json, error_code, started_at, completed_at
      FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?
    `).bind(limit).all<{
      id: string; backup_kind: BackupRunView['backupKind']; status: BackupRunView['status'];
      object_key: string | null; manifest_checksum: string | null; schema_version: number | null;
      counts_json: string | null; error_code: string | null; started_at: number; completed_at: number | null;
    }>();
    return result.results.map((row) => ({
      id: row.id, backupKind: row.backup_kind, status: row.status, objectKey: row.object_key,
      manifestChecksum: row.manifest_checksum, schemaVersion: row.schema_version,
      counts: row.counts_json ? JSON.parse(row.counts_json) as Record<string, number> : null,
      errorCode: row.error_code, startedAt: row.started_at, completedAt: row.completed_at,
    }));
  }
}
