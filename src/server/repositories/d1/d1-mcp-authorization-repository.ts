import { handleSkeleton } from '../../identity/handle-skeleton';
import { normalizeMcpAuthorizationScopes } from '../../identity/mcp-authorization-scopes';
import type {
  McpAvatarUploadSessionView,
  McpAuthorizationGrantView,
  McpAuthorizationRepository,
  McpAuthorizationScope,
  McpDelegationCodeView,
} from '../mcp-authorization-repository';
import type {
  D1DatabaseLike,
  D1RunResultLike,
} from './d1-foundation-repository';

interface GrantSqlRow {
  id: string;
  account_id: string;
  agent_id: string;
  handle: string;
  scopes: string;
  oauth_client_id: string;
  oauth_client_label: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

interface DelegationCodeSqlRow {
  id: string;
  secret_digest: string;
  hash_version: number;
  grant_id: string;
  authorization_request_id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface AvatarUploadSessionSqlRow {
  id: string;
  grant_id: string;
  account_id: string;
  agent_id: string;
  key_digest: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

const GRANT_SELECT = `
  SELECT grant_row.id, grant_row.account_id, grant_row.agent_id,
         agent.handle, grant_row.scopes, grant_row.oauth_client_id,
         grant_row.oauth_client_label, grant_row.created_at,
         grant_row.last_used_at, grant_row.expires_at,
         grant_row.revoked_at, grant_row.revoked_reason
  FROM mcp_authorization_grants grant_row
  JOIN agents agent ON agent.id = grant_row.agent_id
`;

function serializeScopes(scopes: McpAuthorizationScope[]): string {
  return normalizeMcpAuthorizationScopes(scopes).join(' ');
}

function parseScopes(value: string): McpAuthorizationScope[] {
  const normalized = normalizeMcpAuthorizationScopes(value.split(' ').filter(Boolean));
  if (normalized.join(' ') !== value) throw new Error('mcp_authorization_scope_invalid');
  return normalized;
}

function grantFromSql(row: GrantSqlRow): McpAuthorizationGrantView {
  return {
    id: row.id,
    accountId: row.account_id,
    agentId: row.agent_id,
    handle: row.handle,
    scopes: parseScopes(row.scopes),
    oauthClientId: row.oauth_client_id,
    oauthClientLabel: row.oauth_client_label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function delegationCodeFromSql(row: DelegationCodeSqlRow): McpDelegationCodeView {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    hashVersion: row.hash_version,
    grantId: row.grant_id,
    authorizationRequestId: row.authorization_request_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function avatarUploadSessionFromSql(row: AvatarUploadSessionSqlRow): McpAvatarUploadSessionView {
  return {
    id: row.id,
    grantId: row.grant_id,
    accountId: row.account_id,
    agentId: row.agent_id,
    keyDigest: row.key_digest,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

function auditMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export class D1McpAuthorizationRepository implements McpAuthorizationRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async createGrantWithCode(
    input: Parameters<McpAuthorizationRepository['createGrantWithCode']>[0],
  ): Promise<void> {
    if (input.code.grantId !== input.grant.id) {
      throw new Error('mcp_delegation_code_grant_mismatch');
    }

    const scopes = serializeScopes(input.grant.scopes);
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO mcp_authorization_grants (
          id, account_id, agent_id, scopes, oauth_client_id,
          oauth_client_label, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.grant.id,
        input.grant.accountId,
        input.grant.agentId,
        scopes,
        input.grant.oauthClientId.trim(),
        input.grant.oauthClientLabel.trim(),
        input.grant.createdAt,
        input.grant.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO mcp_delegation_codes (
          id, secret_digest, hash_version, grant_id,
          authorization_request_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.code.id,
        input.code.secretDigest,
        input.code.hashVersion,
        input.code.grantId,
        input.code.authorizationRequestId,
        input.code.createdAt,
        input.code.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'mcp.authorization_created', 'account', ?,
          'mcp_authorization_grant', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.grant.accountId,
        input.grant.id,
        input.requestId,
        auditMetadata({
          agentId: input.grant.agentId,
          scopes: input.grant.scopes,
          oauthClientId: input.grant.oauthClientId,
          oauthClientLabel: input.grant.oauthClientLabel,
          authorizationRequestId: input.code.authorizationRequestId,
        }),
        input.grant.createdAt,
      ),
    ]);
  }

  async createPendingAgentGrantWithCode(
    input: Parameters<McpAuthorizationRepository['createPendingAgentGrantWithCode']>[0],
  ): Promise<void> {
    if (input.code.grantId !== input.grant.id || input.pendingAgent.id !== input.grant.agentId) {
      throw new Error('mcp_pending_agent_grant_mismatch');
    }
    const scopes = serializeScopes(input.grant.scopes);
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agents (
          id, handle, handle_normalized, handle_skeleton, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, '', '', 'approval_required', 'active', 'pending', NULL, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(
        input.pendingAgent.id,
        input.pendingAgent.handle,
        input.pendingAgent.handle,
        handleSkeleton(input.pendingAgent.handle),
        input.pendingAgent.handle,
        input.pendingAgent.createdAt,
        input.pendingAgent.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(
        input.membershipId,
        input.pendingAgent.id,
        input.grant.accountId,
        input.grant.accountId,
        input.pendingAgent.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO mcp_authorization_grants (
          id, account_id, agent_id, scopes, oauth_client_id,
          oauth_client_label, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.grant.id,
        input.grant.accountId,
        input.grant.agentId,
        scopes,
        input.grant.oauthClientId.trim(),
        input.grant.oauthClientLabel.trim(),
        input.grant.createdAt,
        input.grant.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO mcp_delegation_codes (
          id, secret_digest, hash_version, grant_id,
          authorization_request_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.code.id,
        input.code.secretDigest,
        input.code.hashVersion,
        input.code.grantId,
        input.code.authorizationRequestId,
        input.code.createdAt,
        input.code.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.mcp_onboarding_started', 'account', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.agentAuditEventId,
        input.grant.accountId,
        input.pendingAgent.id,
        input.requestId,
        auditMetadata({ oauthClientId: input.grant.oauthClientId }),
        input.pendingAgent.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'mcp.authorization_created', 'account', ?,
          'mcp_authorization_grant', ?, ?, ?, ?)
      `).bind(
        input.authorizationAuditEventId,
        input.grant.accountId,
        input.grant.id,
        input.requestId,
        auditMetadata({
          agentId: input.grant.agentId,
          onboardingState: 'pending',
          scopes: input.grant.scopes,
          oauthClientId: input.grant.oauthClientId,
          oauthClientLabel: input.grant.oauthClientLabel,
          authorizationRequestId: input.code.authorizationRequestId,
        }),
        input.grant.createdAt,
      ),
    ]);
  }

  async listAbandonedPendingGrants(
    input: Parameters<McpAuthorizationRepository['listAbandonedPendingGrants']>[0],
  ): Promise<Array<{ grantId: string; agentId: string }>> {
    const result = await this.#db.prepare(`
      SELECT grant_row.id AS grant_id, agent.id AS agent_id
      FROM mcp_authorization_grants grant_row
      JOIN agents agent ON agent.id = grant_row.agent_id
      JOIN agent_memberships membership ON membership.agent_id = agent.id
      WHERE grant_row.account_id = ?
        AND membership.account_id = ?
        AND membership.role = 'primary_sponsor'
        AND membership.revoked_at IS NULL
        AND agent.status = 'active'
        AND agent.onboarding_state = 'pending'
        AND agent.handle_normalized LIKE 'mcp-pending-%'
        AND agent.created_at <= ?
        AND grant_row.revoked_at IS NULL
      ORDER BY agent.created_at ASC, agent.id ASC
    `).bind(input.accountId, input.accountId, input.createdBefore).all<{
      grant_id: string;
      agent_id: string;
    }>();
    return result.results.map((row) => ({ grantId: row.grant_id, agentId: row.agent_id }));
  }

  async getGrant(grantId: string): Promise<McpAuthorizationGrantView | null> {
    const row = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.id = ?
    `).bind(grantId).first<GrantSqlRow>();
    return row ? grantFromSql(row) : null;
  }

  async listAccountGrants(accountId: string): Promise<McpAuthorizationGrantView[]> {
    const result = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.account_id = ?
      ORDER BY grant_row.created_at DESC, grant_row.id DESC
    `).bind(accountId).all<GrantSqlRow>();
    return result.results.map(grantFromSql);
  }

  async getDelegationCode(codeId: string): Promise<McpDelegationCodeView | null> {
    const row = await this.#db.prepare(`
      SELECT id, secret_digest, hash_version, grant_id,
             authorization_request_id, created_at, expires_at, consumed_at
      FROM mcp_delegation_codes
      WHERE id = ?
    `).bind(codeId).first<DelegationCodeSqlRow>();
    return row ? delegationCodeFromSql(row) : null;
  }

  async redeemDelegationCode(
    input: Parameters<McpAuthorizationRepository['redeemDelegationCode']>[0],
  ): Promise<McpAuthorizationGrantView> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO mcp_delegation_redemptions (
          code_id, grant_id, authorization_request_id, redeemed_at
        ) VALUES (?, ?, ?, ?)
      `).bind(
        input.codeId,
        input.grantId,
        input.authorizationRequestId,
        input.redeemedAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'mcp.delegation_code_redeemed', 'system', NULL,
          'mcp_authorization_grant', ?, ?, ?, ?)
      `).bind(
        input.redemptionAuditEventId,
        input.grantId,
        input.requestId,
        auditMetadata({
          codeId: input.codeId,
          authorizationRequestId: input.authorizationRequestId,
        }),
        input.redeemedAt,
      ),
    ]);

    const grant = await this.getGrant(input.grantId);
    if (!grant) throw new Error('mcp_authorization_grant_missing_after_redemption');
    return grant;
  }

  async touchGrant(
    input: Parameters<McpAuthorizationRepository['touchGrant']>[0],
  ): Promise<boolean> {
    const result = await this.#db.prepare(`
      UPDATE mcp_authorization_grants
      SET last_used_at = ?
      WHERE id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND created_at <= ?
        AND (last_used_at IS NULL OR last_used_at < ?)
        AND EXISTS (
          SELECT 1
          FROM accounts account
          WHERE account.id = mcp_authorization_grants.account_id
            AND account.status = 'active'
        )
        AND (
          EXISTS (
            SELECT 1
            FROM agent_memberships membership
            WHERE membership.agent_id = mcp_authorization_grants.agent_id
              AND membership.account_id = mcp_authorization_grants.account_id
              AND membership.role = 'primary_sponsor'
              AND membership.revoked_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM account_roles role
            WHERE role.account_id = mcp_authorization_grants.account_id
              AND role.role = 'platform_owner'
              AND role.revoked_at IS NULL
          )
        )
    `).bind(
      input.usedAt,
      input.grantId,
      input.usedAt,
      input.usedAt,
      input.usedAt,
    ).run<D1RunResultLike>();
    return (result.meta?.changes ?? 0) === 1;
  }

  async revokeGrant(
    input: Parameters<McpAuthorizationRepository['revokeGrant']>[0],
  ): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO mcp_authorization_revocations (
          grant_id, actor_account_id, reason, revoked_at
        ) VALUES (?, ?, ?, ?)
      `).bind(
        input.grantId,
        input.actorAccountId,
        input.reason.trim(),
        input.revokedAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'mcp.authorization_revoked', 'account', ?,
          'mcp_authorization_grant', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.actorAccountId,
        input.grantId,
        input.requestId,
        auditMetadata({ reason: input.reason.trim() }),
        input.revokedAt,
      ),
    ]);
  }

  async getAvatarUploadSession(sessionId: string): Promise<McpAvatarUploadSessionView | null> {
    const row = await this.#db.prepare(`
      SELECT id, grant_id, account_id, agent_id, key_digest,
             created_at, expires_at, completed_at
      FROM mcp_avatar_upload_sessions
      WHERE id = ?
    `).bind(sessionId).first<AvatarUploadSessionSqlRow>();
    return row ? avatarUploadSessionFromSql(row) : null;
  }

  async getAvatarUploadSessionByIdempotency(
    input: Parameters<McpAuthorizationRepository['getAvatarUploadSessionByIdempotency']>[0],
  ): Promise<McpAvatarUploadSessionView | null> {
    const row = await this.#db.prepare(`
      SELECT id, grant_id, account_id, agent_id, key_digest,
             created_at, expires_at, completed_at
      FROM mcp_avatar_upload_sessions
      WHERE grant_id = ? AND key_digest = ?
    `).bind(input.grantId, input.keyDigest).first<AvatarUploadSessionSqlRow>();
    return row ? avatarUploadSessionFromSql(row) : null;
  }

  async createAvatarUploadSession(
    input: Parameters<McpAuthorizationRepository['createAvatarUploadSession']>[0],
  ): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO mcp_avatar_upload_sessions (
          id, grant_id, account_id, agent_id, key_digest,
          created_at, expires_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.session.id,
        input.session.grantId,
        input.session.accountId,
        input.session.agentId,
        input.session.keyDigest,
        input.session.createdAt,
        input.session.expiresAt,
        input.session.completedAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'mcp.avatar_upload_session_created', 'agent', ?,
          'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.session.agentId,
        input.session.agentId,
        input.requestId,
        auditMetadata({ expiresAt: input.session.expiresAt }),
        input.session.createdAt,
      ),
    ]);
  }

  async completeAvatarUploadSession(
    input: Parameters<McpAuthorizationRepository['completeAvatarUploadSession']>[0],
  ): Promise<void> {
    await this.#db.prepare(`
      UPDATE mcp_avatar_upload_sessions
      SET completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
    `).bind(input.completedAt, input.sessionId).run<D1RunResultLike>();
  }

  async deleteExpiredAvatarUploadSessions(
    input: Parameters<McpAuthorizationRepository['deleteExpiredAvatarUploadSessions']>[0],
  ): Promise<number> {
    const result = await this.#db.prepare(`
      DELETE FROM mcp_avatar_upload_sessions
      WHERE expires_at < ?
    `).bind(input.deleteBefore).run<D1RunResultLike>();
    return result.meta?.changes ?? 0;
  }
}
