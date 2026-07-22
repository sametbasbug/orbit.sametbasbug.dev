import type {
  AgentProfileView,
  AgentRegistrationGrantView,
  AgentRepository,
  ManagedAgentView,
  PublicationMode,
} from '../agent-repository';
import type { D1DatabaseLike } from './d1-foundation-repository';

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
  publication_mode: PublicationMode;
  status: AgentProfileView['status'];
  onboarding_state: AgentProfileView['onboardingState'];
  onboarding_completed_at: number | null;
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
    publicationMode: row.publication_mode,
    status: row.status,
    onboardingState: row.onboarding_state,
    onboardingCompletedAt: row.onboarding_completed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
             a.publication_mode, a.status, a.onboarding_state, a.onboarding_completed_at,
             a.version, a.created_at, a.updated_at
      FROM agent_memberships am
      JOIN agents a ON a.id = am.agent_id
      WHERE am.account_id = ?
        AND am.role = 'primary_sponsor'
        AND am.revoked_at IS NULL
      ORDER BY a.created_at, a.id
    `).bind(accountId).all<AgentSqlRow>();
    return result.results.map(profileFromSql);
  }

  async getPublicAgent(handleNormalized: string): Promise<AgentProfileView | null> {
    const row = await this.#db.prepare(`
      SELECT id, handle, display_name, bio, avatar_asset,
             role, short_bio, motto, accent, responsibility, links_json,
             publication_mode, status, onboarding_state, onboarding_completed_at,
             version, created_at, updated_at
      FROM agents
      WHERE handle_normalized = ? AND onboarding_state = 'active'
    `).bind(handleNormalized).first<AgentSqlRow>();
    return row ? profileFromSql(row) : null;
  }

  async getManagedAgent(agentId: string): Promise<ManagedAgentView | null> {
    const row = await this.#db.prepare(`
      SELECT a.id, a.handle, a.display_name, a.bio, a.avatar_asset,
             a.role, a.short_bio, a.motto, a.accent, a.responsibility, a.links_json,
             a.publication_mode, a.status, a.onboarding_state, a.onboarding_completed_at,
             a.version, a.created_at, a.updated_at,
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
          id, handle, handle_normalized, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'direct_publish', 'active', 'active', ?, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(
        input.agent.id,
        input.agent.handle,
        input.agent.handle.toLowerCase(),
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
          id, handle, handle_normalized, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'approval_required', 'active', 'pending', NULL, ?, ?, 1,
          '', '', '', '#6f63e8', '', '[]')
      `).bind(
        input.agent.id,
        input.agent.handle,
        input.agent.handle.toLowerCase(),
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

  async updateOwnProfile(input: Parameters<AgentRepository['updateOwnProfile']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO agent_self_profile_updates (
          id, agent_id, credential_id, expected_version,
          display_name, bio, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.transitionId,
        input.agentId,
        input.credentialId,
        input.expectedVersion,
        input.displayName,
        input.bio,
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
        auditMetadata({ fields: ['bio'], expectedVersion: input.expectedVersion }),
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
