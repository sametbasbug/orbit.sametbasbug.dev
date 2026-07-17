import type {
  AccountView,
  GithubIdentityRow,
  IdentityRepository,
  InvitationRow,
  OAuthCallbackContext,
  OAuthFlowRow,
  SessionView,
} from '../identity-repository';
import type {
  D1DatabaseLike,
  D1RunResultLike,
} from './d1-foundation-repository';

interface InvitationSqlRow {
  id: string;
  secret_digest: string;
  hash_version: number;
  expected_github_user_id: string | null;
  expected_github_login_snapshot: string | null;
  agent_quota: number;
  created_by_account_id: string;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
}

interface OAuthFlowSqlRow {
  id: string;
  state_digest: string;
  pkce_verifier_digest: string;
  redirect_uri: string;
  invitation_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function invitationFromSql(row: InvitationSqlRow): InvitationRow {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    hashVersion: row.hash_version,
    expectedGithubUserId: row.expected_github_user_id,
    expectedGithubLoginSnapshot: row.expected_github_login_snapshot,
    agentQuota: row.agent_quota,
    createdByAccountId: row.created_by_account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    revokedAt: row.revoked_at,
  };
}

function oauthFlowFromSql(row: OAuthFlowSqlRow): OAuthFlowRow {
  return {
    id: row.id,
    stateDigest: row.state_digest,
    pkceVerifierDigest: row.pkce_verifier_digest,
    redirectUri: row.redirect_uri,
    invitationId: row.invitation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export class D1IdentityRepository implements IdentityRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async getInvitation(selector: string): Promise<InvitationRow | null> {
    const row = await this.#db.prepare(`
      SELECT id, secret_digest, hash_version, expected_github_user_id,
             expected_github_login_snapshot, agent_quota,
             created_by_account_id, created_at, expires_at, redeemed_at, revoked_at
      FROM invitations
      WHERE id = ?
    `).bind(selector).first<InvitationSqlRow>();
    return row ? invitationFromSql(row) : null;
  }

  async createInvitation(input: InvitationRow & {
    auditEventId: string;
    requestId: string;
  }): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO invitations (
          id, secret_digest, hash_version, expected_github_user_id,
          expected_github_login_snapshot, agent_quota,
          created_by_account_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.id,
        input.secretDigest,
        input.hashVersion,
        input.expectedGithubUserId,
        input.expectedGithubLoginSnapshot,
        input.agentQuota,
        input.createdByAccountId,
        input.createdAt,
        input.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'invitation.created', 'account', ?, 'invitation', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.createdByAccountId,
        input.id,
        input.requestId,
        JSON.stringify({
          expectedGithubUserId: input.expectedGithubUserId,
          agentQuota: input.agentQuota,
          expiresAt: input.expiresAt,
        }),
        input.createdAt,
      ),
    ]);
  }

  async listInvitations(now: number, limit: number): Promise<InvitationRow[]> {
    const result = await this.#db.prepare(`
      SELECT id, secret_digest, hash_version, expected_github_user_id,
             expected_github_login_snapshot, agent_quota,
             created_by_account_id, created_at, expires_at, redeemed_at, revoked_at
      FROM invitations
      WHERE created_at <= ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(now, limit).all<InvitationSqlRow>();
    return result.results.map(invitationFromSql);
  }

  async revokeInvitation(input: {
    invitationId: string;
    accountId: string;
    auditEventId: string;
    requestId: string;
    now: number;
  }): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO invitation_revocations (invitation_id, account_id, revoked_at)
        VALUES (?, ?, ?)
      `).bind(input.invitationId, input.accountId, input.now),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'invitation.revoked', 'account', ?, 'invitation', ?, ?, '{}', ?)
      `).bind(
        input.auditEventId,
        input.accountId,
        input.invitationId,
        input.requestId,
        input.now,
      ),
    ]);
  }

  async createOAuthFlow(flow: OAuthFlowRow): Promise<void> {
    await this.#db.prepare(`
      INSERT INTO oauth_flows (
        id, state_digest, invitation_id, created_at, expires_at,
        pkce_verifier_digest, redirect_uri
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      flow.id,
      flow.stateDigest,
      flow.invitationId,
      flow.createdAt,
      flow.expiresAt,
      flow.pkceVerifierDigest,
      flow.redirectUri,
    ).run();
  }

  async getOAuthFlow(selector: string): Promise<OAuthFlowRow | null> {
    const row = await this.#db.prepare(`
      SELECT id, state_digest, pkce_verifier_digest, redirect_uri,
             invitation_id, created_at, expires_at, consumed_at
      FROM oauth_flows
      WHERE id = ?
    `).bind(selector).first<OAuthFlowSqlRow>();
    return row ? oauthFlowFromSql(row) : null;
  }

  async findGithubIdentity(providerUserId: string): Promise<GithubIdentityRow | null> {
    const row = await this.#db.prepare(`
      SELECT ai.id AS identity_id, ai.account_id, ai.provider_user_id,
             a.status AS account_status
      FROM auth_identities ai
      JOIN accounts a ON a.id = ai.account_id
      WHERE ai.provider = 'github' AND ai.provider_user_id = ?
    `).bind(providerUserId).first<{
      identity_id: string;
      account_id: string;
      provider_user_id: string;
      account_status: GithubIdentityRow['accountStatus'];
    }>();
    return row ? {
      identityId: row.identity_id,
      accountId: row.account_id,
      providerUserId: row.provider_user_id,
      accountStatus: row.account_status,
    } : null;
  }

  async getOAuthCallbackContext(
    providerUserId: string,
    invitationId: string | null,
  ): Promise<OAuthCallbackContext> {
    const row = await this.#db.prepare(`
      WITH callback_input(provider_user_id, invitation_id) AS (VALUES (?, ?))
      SELECT
        ai.id AS identity_id,
        ai.account_id AS identity_account_id,
        ai.provider_user_id,
        a.status AS account_status,
        i.id AS invitation_id,
        i.secret_digest AS invitation_secret_digest,
        i.hash_version AS invitation_hash_version,
        i.expected_github_user_id,
        i.expected_github_login_snapshot,
        i.agent_quota,
        i.created_by_account_id,
        i.created_at AS invitation_created_at,
        i.expires_at AS invitation_expires_at,
        i.redeemed_at,
        i.revoked_at
      FROM callback_input input
      LEFT JOIN auth_identities ai
        ON ai.provider = 'github' AND ai.provider_user_id = input.provider_user_id
      LEFT JOIN accounts a ON a.id = ai.account_id
      LEFT JOIN invitations i ON i.id = input.invitation_id
    `).bind(providerUserId, invitationId).first<{
      identity_id: string | null;
      identity_account_id: string | null;
      provider_user_id: string | null;
      account_status: GithubIdentityRow['accountStatus'] | null;
      invitation_id: string | null;
      invitation_secret_digest: string | null;
      invitation_hash_version: number | null;
      expected_github_user_id: string | null;
      expected_github_login_snapshot: string | null;
      agent_quota: number | null;
      created_by_account_id: string | null;
      invitation_created_at: number | null;
      invitation_expires_at: number | null;
      redeemed_at: number | null;
      revoked_at: number | null;
    }>();

    const identity = row?.identity_id
      && row.identity_account_id
      && row.provider_user_id
      && row.account_status
      ? {
        identityId: row.identity_id,
        accountId: row.identity_account_id,
        providerUserId: row.provider_user_id,
        accountStatus: row.account_status,
      }
      : null;
    const invitation = row?.invitation_id
      && row.invitation_secret_digest
      && row.invitation_hash_version
      && row.agent_quota !== null
      && row.created_by_account_id
      && row.invitation_created_at !== null
      && row.invitation_expires_at !== null
      ? {
        id: row.invitation_id,
        secretDigest: row.invitation_secret_digest,
        hashVersion: row.invitation_hash_version,
        expectedGithubUserId: row.expected_github_user_id,
        expectedGithubLoginSnapshot: row.expected_github_login_snapshot,
        agentQuota: row.agent_quota,
        createdByAccountId: row.created_by_account_id,
        createdAt: row.invitation_created_at,
        expiresAt: row.invitation_expires_at,
        redeemedAt: row.redeemed_at,
        revokedAt: row.revoked_at,
      }
      : null;
    return { identity, invitation };
  }

  async loginExistingIdentity(input: Parameters<IdentityRepository['loginExistingIdentity']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        UPDATE auth_identities
        SET provider_login_snapshot = ?, last_seen_at = ?
        WHERE id = ? AND account_id = ?
      `).bind(input.profile.login, input.now, input.identity.identityId, input.identity.accountId),
      this.#db.prepare(`
        UPDATE accounts
        SET display_name = ?,
            avatar_url = CASE WHEN avatar_media_id IS NULL THEN ? ELSE avatar_url END,
            updated_at = ?, last_login_at = ?
        WHERE id = ? AND status = 'active'
      `).bind(
        input.profile.displayName,
        input.profile.avatarUrl,
        input.now,
        input.now,
        input.identity.accountId,
      ),
      this.#sessionInsert(input.identity.accountId, input.session),
      this.#auditInsert(
        input.auditEventId,
        'auth.github.login',
        input.identity.accountId,
        'session',
        input.session.id,
        input.requestId,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO oauth_flow_consumptions (flow_id, account_id, consumed_at)
        VALUES (?, ?, ?)
      `).bind(input.flowId, input.identity.accountId, input.now),
    ]);
  }

  async registerGithubIdentity(input: Parameters<IdentityRepository['registerGithubIdentity']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, display_name, avatar_url,
          status, created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(
        input.accountId,
        input.handle,
        input.handle.toLowerCase(),
        input.profile.displayName,
        input.profile.avatarUrl,
        input.now,
        input.now,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'github', ?, ?, ?, ?)
      `).bind(
        input.identityId,
        input.accountId,
        input.profile.userId,
        input.profile.login,
        input.now,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO account_roles (
          id, account_id, role, granted_by_account_id, granted_at
        ) VALUES (?, ?, 'member', NULL, ?)
      `).bind(input.roleId, input.accountId, input.now),
      this.#db.prepare(`
        INSERT INTO account_quotas (
          account_id, quota_key, limit_value, updated_by_account_id, updated_at
        ) VALUES (?, 'agents.max_active', ?, NULL, ?)
      `).bind(input.accountId, input.agentQuota, input.now),
      this.#sessionInsert(input.accountId, input.session),
      this.#auditInsert(
        input.invitationAuditEventId,
        'invitation.redeemed',
        input.accountId,
        'invitation',
        input.invitationId,
        input.requestId,
        input.now,
      ),
      this.#auditInsert(
        input.loginAuditEventId,
        'auth.github.registered',
        input.accountId,
        'session',
        input.session.id,
        input.requestId,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO invitation_redemptions (
          invitation_id, account_id, github_user_id, redeemed_at
        ) VALUES (?, ?, ?, ?)
      `).bind(input.invitationId, input.accountId, input.profile.userId, input.now),
      this.#db.prepare(`
        INSERT INTO oauth_flow_consumptions (flow_id, account_id, consumed_at)
        VALUES (?, ?, ?)
      `).bind(input.flowId, input.accountId, input.now),
    ]);
  }

  async getSession(selector: string): Promise<SessionView | null> {
    const row = await this.#db.prepare(`
      SELECT s.id AS session_id, s.account_id, s.secret_digest, s.hash_version,
             s.csrf_digest, s.created_at, s.last_seen_at, s.idle_expires_at,
             s.absolute_expires_at, s.revoked_at, a.status AS account_status
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ?
    `).bind(selector).first<{
      session_id: string;
      account_id: string;
      secret_digest: string;
      hash_version: number;
      csrf_digest: string;
      created_at: number;
      last_seen_at: number;
      idle_expires_at: number;
      absolute_expires_at: number;
      revoked_at: number | null;
      account_status: SessionView['accountStatus'];
    }>();
    return row ? {
      sessionId: row.session_id,
      accountId: row.account_id,
      secretDigest: row.secret_digest,
      hashVersion: row.hash_version,
      csrfDigest: row.csrf_digest,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      revokedAt: row.revoked_at,
      accountStatus: row.account_status,
    } : null;
  }

  async touchSession(sessionId: string, now: number, idleExpiresAt: number): Promise<void> {
    await this.#db.prepare(`
      UPDATE sessions
      SET last_seen_at = ?, idle_expires_at = ?
      WHERE id = ? AND revoked_at IS NULL AND absolute_expires_at > ?
    `).bind(now, idleExpiresAt, sessionId, now).run();
  }

  async getAccount(accountId: string): Promise<AccountView | null> {
    const row = await this.#db.prepare(`
      SELECT a.id, a.handle, a.display_name, a.avatar_url,
             COALESCE(GROUP_CONCAT(DISTINCT ar.role), '') AS roles,
             COALESCE(MAX(aq.limit_value), 0) AS agent_quota
      FROM accounts a
      LEFT JOIN account_roles ar
        ON ar.account_id = a.id AND ar.revoked_at IS NULL
      LEFT JOIN account_quotas aq
        ON aq.account_id = a.id AND aq.quota_key = 'agents.max_active'
      WHERE a.id = ? AND a.status = 'active'
      GROUP BY a.id, a.handle, a.display_name, a.avatar_url
    `).bind(accountId).first<{
      id: string;
      handle: string;
      display_name: string;
      avatar_url: string | null;
      roles: string;
      agent_quota: number;
    }>();
    return row ? {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      roles: row.roles ? row.roles.split(',').sort() : [],
      agentQuota: row.agent_quota,
    } : null;
  }

  async revokeSession(input: Parameters<IdentityRepository['revokeSession']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO session_revocations (session_id, account_id, reason, revoked_at)
        VALUES (?, ?, ?, ?)
      `).bind(input.sessionId, input.accountId, input.reason, input.now),
      this.#auditInsert(
        input.auditEventId,
        'auth.session.revoked',
        input.accountId,
        'session',
        input.sessionId,
        input.requestId,
        input.now,
      ),
    ]);
  }

  async cleanup(now: number, oauthCutoff: number, sessionCutoff: number): Promise<{
    oauthFlows: number;
    sessions: number;
    idempotencyKeys: number;
  }> {
    const results = await this.#db.batch<D1RunResultLike>([
      this.#db.prepare(`
        DELETE FROM oauth_flow_consumptions
        WHERE flow_id IN (
          SELECT id FROM oauth_flows
          WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
             OR (expires_at <= ?)
        )
      `).bind(oauthCutoff, oauthCutoff),
      this.#db.prepare(`
        DELETE FROM oauth_flows
        WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
           OR (expires_at <= ?)
      `).bind(oauthCutoff, oauthCutoff),
      this.#db.prepare(`
        DELETE FROM session_revocations
        WHERE session_id IN (
          SELECT id FROM sessions
          WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
             OR (MIN(idle_expires_at, absolute_expires_at) <= ?)
        )
      `).bind(sessionCutoff, sessionCutoff),
      this.#db.prepare(`
        DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
           OR (MIN(idle_expires_at, absolute_expires_at) <= ?)
      `).bind(sessionCutoff, sessionCutoff),
      this.#db.prepare(`
        DELETE FROM idempotency_keys WHERE expires_at <= ?
      `).bind(now),
    ]);
    return {
      oauthFlows: results[1]?.meta?.changes ?? 0,
      sessions: results[3]?.meta?.changes ?? 0,
      idempotencyKeys: results[4]?.meta?.changes ?? 0,
    };
  }

  #sessionInsert(accountId: string, session: Parameters<IdentityRepository['loginExistingIdentity']>[0]['session']) {
    return this.#db.prepare(`
      INSERT INTO sessions (
        id, account_id, secret_digest, hash_version, csrf_digest,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      session.id,
      accountId,
      session.secretDigest,
      session.hashVersion,
      session.csrfDigest,
      session.createdAt,
      session.lastSeenAt,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
    );
  }

  #auditInsert(
    id: string,
    eventType: string,
    actorAccountId: string,
    subjectType: string,
    subjectId: string,
    requestId: string,
    createdAt: number,
  ) {
    return this.#db.prepare(`
      INSERT INTO audit_events (
        id, event_type, actor_type, actor_id, subject_type,
        subject_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, 'account', ?, ?, ?, ?, '{}', ?)
    `).bind(
      id,
      eventType,
      actorAccountId,
      subjectType,
      subjectId,
      requestId,
      createdAt,
    );
  }
}
