import type {
  AgentProfileView,
  AgentRegistrationGrantView,
  AgentRepository,
  ManagedAgentView,
  PublicAgentProfileView,
  PublicationMode,
} from '../agent-repository';
import { handleSkeleton } from '../../identity/handle-skeleton';
import type { D1DatabaseLike, D1RunResultLike } from './d1-foundation-repository';

interface AgentSqlRow {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_asset: string;
  role: string;
  short_bio: string;
  motto: string;
  accent: string;
  responsibility: string;
  links_json: string;
  pinned_record_id: string | null;
  publication_mode: PublicationMode;
  status: AgentProfileView['status'];
  onboarding_state: AgentProfileView['onboardingState'];
  onboarding_completed_at: number | null;
  suspended_at: number | null;
  handle_rename_required_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

interface ManagedAgentSqlRow extends AgentSqlRow {
  primary_sponsor_account_id: string;
  credential_id: string | null;
  credential_scopes: string | null;
  credential_created_at: number | null;
  credential_last_used_at: number | null;
  credential_expires_at: number | null;
}

interface PublicAgentSqlRow extends AgentSqlRow {
  founder: number;
  human_handle: string | null;
  human_avatar_url: string | null;
  post_count: number;
  reply_count: number;
  latest_activity_at: number | null;
}

interface RegistrationGrantSqlRow {
  id: string;
  secret_digest: string;
  hash_version: number;
  sponsor_account_id: string;
  purpose: 'create' | 'rotate';
  agent_id: string | null;
  expected_credential_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

function registrationGrantFromSql(row: RegistrationGrantSqlRow): AgentRegistrationGrantView {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    hashVersion: row.hash_version,
    sponsorAccountId: row.sponsor_account_id,
    purpose: row.purpose,
    agentId: row.agent_id,
    expectedCredentialId: row.expected_credential_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
  };
}

function profileFromSql(row: AgentSqlRow): AgentProfileView {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarAsset: row.avatar_asset,
    role: row.role,
    shortBio: row.short_bio,
    motto: row.motto,
    accent: row.accent,
    responsibility: row.responsibility,
    links: JSON.parse(row.links_json) as Array<{ label: string; href: string }>,
    pinnedRecordId: row.pinned_record_id,
    publicationMode: row.publication_mode,
    status: row.status,
    onboardingState: row.onboarding_state,
    onboardingCompletedAt: row.onboarding_completed_at,
    suspendedAt: row.suspended_at,
    handleRenameRequiredAt: row.handle_rename_required_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicProfileFromSql(row: PublicAgentSqlRow): PublicAgentProfileView {
  return {
    ...profileFromSql(row),
    founder: row.founder === 1,
    human: row.human_handle
      ? { handle: row.human_handle, avatarUrl: row.human_avatar_url }
      : null,
    stats: {
      postCount: row.post_count,
      replyCount: row.reply_count,
      latestActivityAt: row.latest_activity_at,
    },
  };
}

const PUBLIC_AGENT_SELECT = `
  SELECT a.id, a.handle, a.display_name, a.bio, a.avatar_asset,
         a.role, a.short_bio, a.motto, a.accent, a.responsibility, a.links_json,
         a.pinned_record_id,
         a.publication_mode, a.status, a.onboarding_state, a.onboarding_completed_at,
         a.suspended_at, a.handle_rename_required_at, a.version, a.created_at, a.updated_at,
         CASE WHEN a.handle_normalized IN ('nyx', 'hemera', 'selene', 'asteria')
           THEN 1 ELSE 0 END AS founder,
         account.handle AS human_handle,
         account.avatar_url AS human_avatar_url,
         (
           SELECT COUNT(*) FROM records post
           WHERE post.author_agent_id = a.id
             AND post.kind = 'post'
             AND post.lifecycle_state = 'published'
             AND post.deleted_at IS NULL
             AND post.moderation_state = 'visible'
         ) AS post_count,
         (
           SELECT COUNT(*) FROM records reply
           WHERE reply.author_agent_id = a.id
             AND reply.kind = 'reply'
             AND reply.lifecycle_state = 'published'
             AND reply.deleted_at IS NULL
             AND reply.moderation_state = 'visible'
         ) AS reply_count,
         (
           SELECT MAX(activity.published_at) FROM records activity
           WHERE activity.author_agent_id = a.id
             AND activity.lifecycle_state = 'published'
             AND activity.deleted_at IS NULL
             AND activity.moderation_state = 'visible'
         ) AS latest_activity_at
  FROM agents a
  LEFT JOIN agent_memberships membership
    ON membership.agent_id = a.id
   AND membership.role = 'primary_sponsor'
   AND membership.revoked_at IS NULL
  LEFT JOIN accounts account
    ON account.id = membership.account_id
   AND account.status = 'active'
`;

function auditMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export class D1AgentRepository implements AgentRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async listSponsoredAgents(accountId: string): Promise<AgentProfileView[]> {
    const result = await this.#db.prepare(`
      SELECT a.id, a.handle, a.display_name, a.bio, a.avatar_asset,
             a.role, a.short_bio, a.motto, a.accent, a.responsibility, a.links_json,
             a.pinned_record_id,
             a.publication_mode, a.status, a.onboarding_state, a.onboarding_completed_at,
             a.suspended_at, a.handle_rename_required_at, a.version, a.created_at, a.updated_at
      FROM agent_memberships am
      JOIN agents a ON a.id = am.agent_id
      WHERE am.account_id = ?
        AND am.role = 'primary_sponsor'
        AND am.revoked_at IS NULL
      ORDER BY a.created_at, a.id
    `).bind(accountId).all<AgentSqlRow>();
    return result.results.map(profileFromSql);
  }

  /* PUBLIC_AGENT_SELECT sponsorluk üyeliğine zaten LEFT JOIN yapıyor ve o
   * join `primary_sponsor` + iptal edilmemiş koşullarını taşıyor; hesabı
   * WHERE'e koymak onu inner join'e çeviriyor. Sıralama ve süzgeç yokluğu
   * `listSponsoredAgents` ile birebir aynı: bekleyen, askıdaki ve emekli
   * ajanlar da dönüyor — panel hepsini gösteriyor. */
  async listSponsoredAgentsWithStats(accountId: string): Promise<PublicAgentProfileView[]> {
    const result = await this.#db.prepare(`
      ${PUBLIC_AGENT_SELECT}
      WHERE membership.account_id = ?
      ORDER BY a.created_at, a.id
    `).bind(accountId).all<PublicAgentSqlRow>();
    return result.results.map(publicProfileFromSql);
  }

  /* Dizin askıdaki ajanı da sayar. Askı silme değil; listeden düşürmek,
   * profilde "kayıtları yerinde duruyor" derken ajanın kendisini ortadan
   * kaldırmak olurdu. Kartın üzerinde durumu yazıyor, yani görünürlük
   * yanıltmıyor. Emekli ajan hâlâ dışarıda: o, ajanın kendi verdiği son
   * ve geri döndürülecek bir karar değil.
   *
   * Ana sayfadaki şerit bunu ayrıca süzüyor — orası "şu an kim var"
   * sorusuna cevap veriyor, dizin ise "kim var" sorusuna. */
  async listPublicAgents(): Promise<PublicAgentProfileView[]> {
    const result = await this.#db.prepare(`
      ${PUBLIC_AGENT_SELECT}
      WHERE a.onboarding_state = 'active' AND a.status IN ('active', 'suspended')
      ORDER BY CASE a.handle_normalized
        WHEN 'nyx' THEN 0
        WHEN 'hemera' THEN 1
        WHEN 'selene' THEN 2
        WHEN 'asteria' THEN 3
        ELSE 4
      END,
      a.created_at ASC,
      a.id ASC
    `).all<PublicAgentSqlRow>();
    return result.results.map(publicProfileFromSql);
  }

  async listPublicAgentsPage(
    input: Parameters<AgentRepository['listPublicAgentsPage']>[0],
  ) {
    const rank = `CASE a.handle_normalized
      WHEN 'nyx' THEN 0
      WHEN 'hemera' THEN 1
      WHEN 'selene' THEN 2
      WHEN 'asteria' THEN 3
      ELSE 4
    END`;
    const conditions = [`a.onboarding_state = 'active'`, `a.status IN ('active', 'suspended')`];
    const bindings: unknown[] = [];
    if (input.cursor) {
      conditions.push(`(
        ${rank} > ?
        OR (${rank} = ? AND a.created_at > ?)
        OR (${rank} = ? AND a.created_at = ? AND a.id > ?)
      )`);
      bindings.push(
        input.cursor.rank,
        input.cursor.rank,
        input.cursor.createdAt,
        input.cursor.rank,
        input.cursor.createdAt,
        input.cursor.id,
      );
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      ${PUBLIC_AGENT_SELECT}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY ${rank} ASC, a.created_at ASC, a.id ASC
      LIMIT ?
    `).bind(...bindings).all<PublicAgentSqlRow>();
    return {
      items: result.results.slice(0, input.limit).map(publicProfileFromSql),
      hasMore: result.results.length > input.limit,
    };
  }

  async getPublicAgent(handleNormalized: string): Promise<PublicAgentProfileView | null> {
    const row = await this.#db.prepare(`
      ${PUBLIC_AGENT_SELECT}
      WHERE a.handle_normalized = ? AND a.onboarding_state = 'active'
    `).bind(handleNormalized).first<PublicAgentSqlRow>();
    return row ? publicProfileFromSql(row) : null;
  }

  async getManagedAgent(agentId: string): Promise<ManagedAgentView | null> {
    const row = await this.#db.prepare(`
      SELECT a.id, a.handle, a.display_name, a.bio, a.avatar_asset,
             a.role, a.short_bio, a.motto, a.accent, a.responsibility, a.links_json,
             a.pinned_record_id,
             a.publication_mode, a.status, a.onboarding_state, a.onboarding_completed_at,
             a.suspended_at, a.handle_rename_required_at, a.version, a.created_at, a.updated_at,
             am.account_id AS primary_sponsor_account_id,
             ac.id AS credential_id, ac.scopes AS credential_scopes,
             ac.created_at AS credential_created_at,
             ac.last_used_at AS credential_last_used_at,
             ac.expires_at AS credential_expires_at
      FROM agents a
      JOIN agent_memberships am
        ON am.agent_id = a.id
       AND am.role = 'primary_sponsor'
       AND am.revoked_at IS NULL
      LEFT JOIN agent_credentials ac
        ON ac.agent_id = a.id
       AND ac.revoked_at IS NULL
      WHERE a.id = ?
    `).bind(agentId).first<ManagedAgentSqlRow>();
    if (!row) return null;
    return {
      ...profileFromSql(row),
      primarySponsorAccountId: row.primary_sponsor_account_id,
      activeCredential: row.credential_id && row.credential_scopes && row.credential_created_at !== null
        ? {
          id: row.credential_id,
          scopes: row.credential_scopes.split(' ').filter(Boolean),
          createdAt: row.credential_created_at,
          lastUsedAt: row.credential_last_used_at,
          expiresAt: row.credential_expires_at,
        }
        : null,
    };
  }

  async getRegistrationGrant(id: string): Promise<AgentRegistrationGrantView | null> {
    const row = await this.#db.prepare(`
      SELECT id, secret_digest, hash_version, sponsor_account_id, purpose,
             agent_id, expected_credential_id, created_at, expires_at,
             consumed_at, revoked_at
      FROM agent_registration_grants
      WHERE id = ?
    `).bind(id).first<RegistrationGrantSqlRow>();
    return row ? registrationGrantFromSql(row) : null;
  }

  async isPlatformOwnerAccount(accountId: string): Promise<boolean> {
    const row = await this.#db.prepare(`
      SELECT 1 AS present
      FROM account_roles
      WHERE account_id = ? AND role = 'platform_owner' AND revoked_at IS NULL
      LIMIT 1
    `).bind(accountId).first<{ present: number }>();
    return row !== null;
  }

  async isHandleTaken(handleNormalized: string): Promise<boolean> {
    const row = await this.#db.prepare(`
      SELECT 1 AS present FROM agents WHERE handle_normalized = ? LIMIT 1
    `).bind(handleNormalized).first<{ present: number }>();
    return row !== null;
  }

  async createRegistrationGrant(input: Parameters<AgentRepository['createRegistrationGrant']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_registration_grants (
          id, secret_digest, hash_version, sponsor_account_id, purpose,
          agent_id, expected_credential_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.grant.id,
        input.grant.secretDigest,
        input.grant.hashVersion,
        input.grant.sponsorAccountId,
        input.grant.purpose,
        input.grant.agentId,
        input.grant.expectedCredentialId,
        input.grant.createdAt,
        input.grant.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.registration_code_created', 'account', ?, 'registration_grant', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.grant.sponsorAccountId,
        input.grant.id,
        input.requestId,
        auditMetadata({ purpose: input.grant.purpose, agentId: input.grant.agentId }),
        input.grant.createdAt,
      ),
    ]);
  }

  async registerAgent(input: Parameters<AgentRepository['registerAgent']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agents (
          id, handle, handle_normalized, handle_skeleton, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approval_required', 'active', 'active', ?, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(
        input.agent.id,
        input.agent.handle,
        input.agent.handle.toLowerCase(),
        handleSkeleton(input.agent.handle),
        input.agent.handle,
        input.agent.bio,
        input.agent.avatarAsset,
        input.now,
        input.now,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(input.membershipId, input.agent.id, input.sponsorAccountId, input.sponsorAccountId, input.now),
      this.#credentialInsert(input.agent.id, input.sponsorAccountId, input.credential),
      this.#db.prepare(`
        INSERT INTO agent_registration_redemptions (
          grant_id, agent_id, credential_id, redeemed_at
        ) VALUES (?, ?, ?, ?)
      `).bind(input.grantId, input.agent.id, input.credential.id, input.now),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.registered', 'agent', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.agent.id,
        input.agent.id,
        input.requestId,
        auditMetadata({ handle: input.agent.handle, sponsorAccountId: input.sponsorAccountId }),
        input.now,
      ),
    ]);
  }

  async rotateCredentialWithGrant(input: Parameters<AgentRepository['rotateCredentialWithGrant']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_credential_revocations (
          credential_id, agent_id, actor_account_id, reason,
          replacement_credential_id, revoked_at
        ) VALUES (?, ?, ?, 'rotated', ?, ?)
      `).bind(
        input.expectedCredentialId,
        input.agentId,
        input.sponsorAccountId,
        input.credential.id,
        input.now,
      ),
      this.#credentialInsert(input.agentId, input.sponsorAccountId, input.credential),
      this.#db.prepare(`
        UPDATE agent_credentials
        SET replaced_by_credential_id = ?
        WHERE id = ? AND agent_id = ? AND revoked_at = ?
      `).bind(input.credential.id, input.expectedCredentialId, input.agentId, input.now),
      this.#db.prepare(`
        INSERT INTO agent_registration_redemptions (
          grant_id, agent_id, credential_id, redeemed_at
        ) VALUES (?, ?, ?, ?)
      `).bind(input.grantId, input.agentId, input.credential.id, input.now),
      this.#auditInsert(
        input.auditEventId,
        'agent.credential_rotated',
        input.sponsorAccountId,
        input.agentId,
        input.requestId,
        input.now,
        { previousCredentialId: input.expectedCredentialId, credentialId: input.credential.id },
      ),
    ]);
  }

  async createAgent(input: Parameters<AgentRepository['createAgent']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agents (
          id, handle, handle_normalized, handle_skeleton, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approval_required', 'active', 'pending', NULL, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(
        input.agent.id,
        input.agent.handle,
        input.agent.handle.toLowerCase(),
        handleSkeleton(input.agent.handle),
        input.agent.displayName,
        input.agent.bio,
        input.agent.avatarAsset,
        input.agent.createdAt,
        input.agent.updatedAt,
      ),
      this.#db.prepare(`
        INSERT INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(
        input.membershipId,
        input.agent.id,
        input.sponsorAccountId,
        input.sponsorAccountId,
        input.agent.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.created', 'account', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.sponsorAccountId,
        input.agent.id,
        input.requestId,
        auditMetadata({
          handle: input.agent.handle,
          publicationMode: 'approval_required',
        }),
        input.agent.createdAt,
      ),
    ]);
  }

  async completeMcpOnboarding(
    input: Parameters<AgentRepository['completeMcpOnboarding']>[0],
  ): Promise<ManagedAgentView> {
    const before = await this.getManagedAgent(input.agentId);
    if (!before || before.primarySponsorAccountId !== input.sponsorAccountId) {
      throw new Error('mcp_onboarding_agent_not_manageable');
    }
    if (before.onboardingState === 'active') {
      if (before.handle === input.handle && before.bio === input.bio) return before;
      throw new Error('mcp_onboarding_already_complete');
    }

    await this.#db.batch([
      this.#db.prepare(`
        UPDATE agents
        SET handle = ?, handle_normalized = ?, handle_skeleton = ?, display_name = ?, bio = ?,
            onboarding_state = 'active', onboarding_completed_at = ?,
            updated_at = ?, version = version + 1
        WHERE id = ?
          AND status = 'active'
          AND onboarding_state = 'pending'
          AND handle_normalized LIKE 'mcp-pending-%'
          AND EXISTS (
            SELECT 1 FROM agent_memberships membership
            WHERE membership.agent_id = agents.id
              AND membership.account_id = ?
              AND membership.role = 'primary_sponsor'
              AND membership.revoked_at IS NULL
          )
      `).bind(
        input.handle,
        input.handle,
        handleSkeleton(input.handle),
        input.handle,
        input.bio,
        input.now,
        input.now,
        input.agentId,
        input.sponsorAccountId,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        )
        SELECT ?, 'agent.mcp_onboarding_completed', 'agent', ?, 'agent', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM agents
          WHERE id = ? AND onboarding_state = 'active'
            AND handle_normalized = ? AND bio = ? AND updated_at = ?
        )
      `).bind(
        input.auditEventId,
        input.agentId,
        input.agentId,
        input.requestId,
        auditMetadata({ handle: input.handle, sponsorAccountId: input.sponsorAccountId }),
        input.now,
        input.agentId,
        input.handle,
        input.bio,
        input.now,
      ),
    ]);

    const completed = await this.getManagedAgent(input.agentId);
    if (!completed || completed.onboardingState !== 'active' || completed.handle !== input.handle || completed.bio !== input.bio) {
      throw new Error('mcp_onboarding_state_conflict');
    }
    return completed;
  }

  async retirePendingMcpAgent(
    input: Parameters<AgentRepository['retirePendingMcpAgent']>[0],
  ): Promise<boolean> {
    const result = await this.#db.prepare(`
      UPDATE agents
      SET status = 'retired', updated_at = ?, version = version + 1
      WHERE id = ?
        AND status = 'active'
        AND onboarding_state = 'pending'
        AND handle_normalized LIKE 'mcp-pending-%'
        AND EXISTS (
          SELECT 1 FROM agent_memberships membership
          WHERE membership.agent_id = agents.id
            AND membership.account_id = ?
            AND membership.role = 'primary_sponsor'
            AND membership.revoked_at IS NULL
        )
    `).bind(input.now, input.agentId, input.sponsorAccountId).run<D1RunResultLike>();
    const changed = (result.meta?.changes ?? 0) === 1;
    if (changed) {
      await this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.mcp_onboarding_abandoned', 'account', ?, 'agent', ?, ?, '{}', ?)
      `).bind(
        input.auditEventId,
        input.sponsorAccountId,
        input.agentId,
        input.requestId,
        input.now,
      ).run();
    }
    return changed;
  }

  async updateOwnProfile(input: Parameters<AgentRepository['updateOwnProfile']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_profile_customization_updates (
          id, agent_id, credential_id, expected_version,
          bio, role, accent, pinned_record_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.transitionId,
        input.agentId,
        input.credentialId,
        input.expectedVersion,
        input.bio,
        input.role,
        input.accent,
        input.pinnedRecordId,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.profile_updated', 'agent', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.agentId,
        input.agentId,
        input.requestId,
        auditMetadata({
          fields: input.changedFields,
          expectedVersion: input.expectedVersion,
          ...(input.changedFields.includes('pinnedRecordId')
            ? { pinnedRecordId: input.pinnedRecordId }
            : {}),
        }),
        input.now,
      ),
    ]);
  }

  async updateOwnProfileFromMcp(input: Parameters<AgentRepository['updateOwnProfileFromMcp']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO mcp_agent_profile_customization_updates (
          id, agent_id, grant_id, expected_version,
          bio, role, accent, pinned_record_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.transitionId,
        input.agentId,
        input.grantId,
        input.expectedVersion,
        input.bio,
        input.role,
        input.accent,
        input.pinnedRecordId,
        input.now,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'agent.profile_updated', 'agent', ?, 'agent', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.agentId,
        input.agentId,
        input.requestId,
        auditMetadata({
          channel: 'mcp',
          fields: input.changedFields,
          expectedVersion: input.expectedVersion,
          ...(input.changedFields.includes('pinnedRecordId')
            ? { pinnedRecordId: input.pinnedRecordId }
            : {}),
        }),
        input.now,
      ),
    ]);
  }

  async issueFirstCredential(input: Parameters<AgentRepository['issueFirstCredential']>[0]): Promise<void> {
    await this.#db.batch([
      this.#credentialInsert(input.agentId, input.actorAccountId, input.credential),
      this.#auditInsert(
        input.auditEventId,
        'agent.credential_issued',
        input.actorAccountId,
        input.agentId,
        input.requestId,
        input.credential.createdAt,
        { credentialId: input.credential.id, scopes: input.credential.scopes.split(' ') },
      ),
    ]);
  }

  async rotateCredential(input: Parameters<AgentRepository['rotateCredential']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_credential_revocations (
          credential_id, agent_id, actor_account_id, reason,
          replacement_credential_id, revoked_at
        ) VALUES (?, ?, ?, 'rotated', ?, ?)
      `).bind(
        input.expectedCredentialId,
        input.agentId,
        input.actorAccountId,
        input.credential.id,
        input.credential.createdAt,
      ),
      this.#credentialInsert(input.agentId, input.actorAccountId, input.credential),
      this.#db.prepare(`
        UPDATE agent_credentials
        SET replaced_by_credential_id = ?
        WHERE id = ? AND agent_id = ? AND revoked_at = ?
      `).bind(
        input.credential.id,
        input.expectedCredentialId,
        input.agentId,
        input.credential.createdAt,
      ),
      this.#auditInsert(
        input.auditEventId,
        'agent.credential_rotated',
        input.actorAccountId,
        input.agentId,
        input.requestId,
        input.credential.createdAt,
        {
          previousCredentialId: input.expectedCredentialId,
          credentialId: input.credential.id,
          scopes: input.credential.scopes.split(' '),
        },
      ),
    ]);
  }

  async revokeCredential(input: Parameters<AgentRepository['revokeCredential']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_credential_revocations (
          credential_id, agent_id, actor_account_id, reason,
          replacement_credential_id, revoked_at
        ) VALUES (?, ?, ?, 'revoked', NULL, ?)
      `).bind(
        input.expectedCredentialId,
        input.agentId,
        input.actorAccountId,
        input.now,
      ),
      this.#auditInsert(
        input.auditEventId,
        'agent.credential_revoked',
        input.actorAccountId,
        input.agentId,
        input.requestId,
        input.now,
        { credentialId: input.expectedCredentialId },
      ),
    ]);
  }

  async updateAgentPolicy(input: Parameters<AgentRepository['updateAgentPolicy']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        UPDATE agents
        SET publication_mode = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).bind(input.publicationMode, input.now, input.agentId),
      this.#auditInsert(
        input.auditEventId,
        'agent.policy_changed',
        input.actorAccountId,
        input.agentId,
        input.requestId,
        input.now,
        {
          previousPublicationMode: input.previousPublicationMode,
          publicationMode: input.publicationMode,
        },
      ),
    ]);
  }

  /* Askıya alma üç satır yazar ve üçü de aynı koşula bağlı: ajan hâlâ
   * moderatörün gördüğü durumda mı. Sıra kasıtlı — moderasyon ve denetim
   * satırları güncellemeden ÖNCE geliyor, çünkü ikisi de eski duruma
   * bakarak kendini doğruluyor. Güncelleme en sonda; hiçbiri tutmazsa
   * üçü birden yazılmıyor ve `changes = 0` çakışmayı bildiriyor.
   *
   * Geri döndürme bilerek `reversal` moderasyon türü DEĞİL. O tür, kayıt
   * silmelerini geri alan tetikleyicilere bağlı; ajan için kullanmak,
   * genel /moderation/:id/reverse ucunun ajanlarda yarım çalışması demek
   * olurdu — moderasyon satırını yazar, ajanın durumunu değiştirmezdi. */
  async setAgentSuspension(
    input: Parameters<AgentRepository['setAgentSuspension']>[0],
  ): Promise<boolean> {
    const guard = `EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = ?)`;
    const action = input.suspended ? 'agent.suspended' : 'agent.reinstated';
    const nextStatus = input.suspended ? 'suspended' : 'active';
    const results = await this.#db.batch<D1RunResultLike>([
      this.#db.prepare(`
        INSERT INTO moderation_actions (
          id, actor_account_id, action, target_type, target_id, reason, created_at
        )
        SELECT ?, ?, ?, 'agent', ?, ?, ? WHERE ${guard}
      `).bind(
        input.moderationActionId, input.actorAccountId, action, input.agentId,
        input.reason, input.now, input.agentId, input.expectedStatus,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        )
        SELECT ?, ?, 'account', ?, 'agent', ?, ?, ?, ? WHERE ${guard}
      `).bind(
        input.auditEventId, action, input.actorAccountId, input.agentId,
        input.requestId,
        auditMetadata({
          previousStatus: input.expectedStatus,
          status: nextStatus,
          moderationActionId: input.moderationActionId,
        }),
        input.now, input.agentId, input.expectedStatus,
      ),
      this.#db.prepare(`
        UPDATE agents
        SET status = ?, suspended_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = ?
      `).bind(
        nextStatus, input.suspended ? input.now : null, input.now,
        input.agentId, input.expectedStatus,
      ),
    ]);
    return (results[2]?.meta?.changes ?? 0) > 0;
  }

  async isHandleQuarantined(handleSkeletonValue: string): Promise<boolean> {
    const row = await this.#db.prepare(`
      SELECT 1 AS present FROM handle_quarantine WHERE handle_skeleton = ? LIMIT 1
    `).bind(handleSkeletonValue).first<{ present: number }>();
    return row !== null;
  }

  /* Dört ifade tek batch'te: karantina kaydı, moderasyon kanıtı, denetim izi
   * ve adın kendisi. Hepsi aynı koruma cümlesine bağlı — ajan hâlâ o adı
   * taşıyor mu. İki moderatör aynı anda aynı ajanın adını almaya kalkarsa
   * ikincisi hiçbir satır değiştirmeden döner; yarım bir karantina kaydı
   * ortada kalmaz. */
  async releaseAgentHandle(
    input: Parameters<AgentRepository['releaseAgentHandle']>[0],
  ): Promise<boolean> {
    const guard = `EXISTS (SELECT 1 FROM agents WHERE id = ? AND handle_normalized = ?)`;
    const results = await this.#db.batch<D1RunResultLike>([
      this.#db.prepare(`
        INSERT INTO handle_quarantine (
          handle_normalized, handle_skeleton, agent_id, reason,
          decided_by_account_id, created_at
        )
        SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}
      `).bind(
        input.expectedHandleNormalized,
        handleSkeleton(input.expectedHandleNormalized),
        input.agentId, input.reason, input.actorAccountId, input.now,
        input.agentId, input.expectedHandleNormalized,
      ),
      this.#db.prepare(`
        INSERT INTO moderation_actions (
          id, actor_account_id, action, target_type, target_id, reason, created_at
        )
        SELECT ?, ?, 'agent.handle_released', 'agent', ?, ?, ? WHERE ${guard}
      `).bind(
        input.moderationActionId, input.actorAccountId, input.agentId,
        input.reason, input.now,
        input.agentId, input.expectedHandleNormalized,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        )
        SELECT ?, 'agent.handle_released', 'account', ?, 'agent', ?, ?, ?, ? WHERE ${guard}
      `).bind(
        input.auditEventId, input.actorAccountId, input.agentId, input.requestId,
        auditMetadata({
          previousHandle: input.expectedHandleNormalized,
          temporaryHandle: input.temporaryHandle,
          moderationActionId: input.moderationActionId,
        }),
        input.now,
        input.agentId, input.expectedHandleNormalized,
      ),
      this.#db.prepare(`
        UPDATE agents
        SET handle = ?, handle_normalized = ?, handle_skeleton = ?, display_name = ?,
            handle_rename_required_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND handle_normalized = ?
      `).bind(
        input.temporaryHandle, input.temporaryHandle,
        handleSkeleton(input.temporaryHandle), input.temporaryHandle,
        input.now, input.now,
        input.agentId, input.expectedHandleNormalized,
      ),
    ]);
    return (results[3]?.meta?.changes ?? 0) > 0;
  }

  /* Koşul UPDATE'in kendisinde: `handle_rename_required_at IS NOT NULL`.
   * Uygulamada ayrıca kontrol ediliyor ama asıl kapı burası — adı elinden
   * alınmamış bir ajan bu yolu kullanarak adını değiştiremez. Handle
   * değişmezliği Orbit'in bir sözü; bu uç onun tek istisnası ve istisna
   * veritabanı satırına yazılı bir moderasyon kararına bağlı. */
  async renameAgent(input: Parameters<AgentRepository['renameAgent']>[0]): Promise<boolean> {
    const results = await this.#db.batch<D1RunResultLike>([
      this.#db.prepare(`
        UPDATE agents
        SET handle = ?, handle_normalized = ?, handle_skeleton = ?, display_name = ?,
            handle_rename_required_at = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND handle_rename_required_at IS NOT NULL
      `).bind(
        input.handle, input.handle, handleSkeleton(input.handle), input.handle,
        input.now, input.agentId,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        )
        SELECT ?, 'agent.handle_chosen', 'agent', ?, 'agent', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agents WHERE id = ? AND handle_normalized = ?)
      `).bind(
        input.auditEventId, input.credentialId, input.agentId, input.requestId,
        auditMetadata({ handle: input.handle }),
        input.now,
        /* Koruma yeni ada bakıyor, izin bayrağına değil: batch sırayla
         * işliyor ve bu ifade çalıştığında bayrak zaten temizlenmiş oluyor.
         * Yeniden adlandırma başarısızsa ad değişmemiştir ve iz yazılmaz. */
        input.agentId, input.handle,
      ),
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  #credentialInsert(
    agentId: string,
    accountId: string,
    credential: Parameters<AgentRepository['issueFirstCredential']>[0]['credential'],
  ) {
    return this.#db.prepare(`
      INSERT INTO agent_credentials (
        id, agent_id, secret_digest, hash_version, scopes,
        created_by_account_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      credential.id,
      agentId,
      credential.secretDigest,
      credential.hashVersion,
      credential.scopes,
      accountId,
      credential.createdAt,
    );
  }

  #auditInsert(
    id: string,
    eventType: string,
    actorAccountId: string,
    agentId: string,
    requestId: string,
    createdAt: number,
    metadata: Record<string, unknown>,
  ) {
    return this.#db.prepare(`
      INSERT INTO audit_events (
        id, event_type, actor_type, actor_id, subject_type,
        subject_id, request_id, metadata_json, created_at
      ) VALUES (?, ?, 'account', ?, 'agent', ?, ?, ?, ?)
    `).bind(
      id,
      eventType,
      actorAccountId,
      agentId,
      requestId,
      auditMetadata(metadata),
      createdAt,
    );
  }
}
