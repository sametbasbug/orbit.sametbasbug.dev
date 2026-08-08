import type {
  AccountView,
  GithubIdentityRow,
  IdentityRepository,
  NewSignInEvent,
  OAuthFlowRow,
  SessionView,
} from '../identity-repository';
import type {
  D1DatabaseLike,
  D1RunResultLike,
} from './d1-foundation-repository';

interface OAuthFlowSqlRow {
  id: string;
  state_digest: string;
  pkce_verifier_digest: string;
  redirect_uri: string;
  terms_accepted_at: number | null;
  terms_version: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

function oauthFlowFromSql(row: OAuthFlowSqlRow): OAuthFlowRow {
  return {
    id: row.id,
    stateDigest: row.state_digest,
    pkceVerifierDigest: row.pkce_verifier_digest,
    redirectUri: row.redirect_uri,
    termsAcceptedAt: row.terms_accepted_at,
    termsVersion: row.terms_version,
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

  async createOAuthFlow(flow: OAuthFlowRow): Promise<void> {
    await this.#db.prepare(`
      INSERT INTO oauth_flows (
        id, state_digest, terms_accepted_at, terms_version, created_at, expires_at,
        pkce_verifier_digest, redirect_uri
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      flow.id,
      flow.stateDigest,
      flow.termsAcceptedAt,
      flow.termsVersion,
      flow.createdAt,
      flow.expiresAt,
      flow.pkceVerifierDigest,
      flow.redirectUri,
    ).run();
  }

  async getOAuthFlow(selector: string): Promise<OAuthFlowRow | null> {
    const row = await this.#db.prepare(`
      SELECT id, state_digest, pkce_verifier_digest, redirect_uri,
             terms_accepted_at, terms_version, created_at, expires_at, consumed_at
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

  /* Davet kalkınca bu çağrı bir birleşim sorgusu olmaktan çıktı: dönüşte
   * sorulan tek şey "bu GitHub hesabı bizde var mı". findGithubIdentity ile
   * aynı işi yapıyor ve ona devrediyor — iki ad, tek sorgu. */
  async getGithubIdentity(providerUserId: string): Promise<GithubIdentityRow | null> {
    return await this.findGithubIdentity(providerUserId);
  }

  async loginExistingIdentity(input: Parameters<IdentityRepository['loginExistingIdentity']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        UPDATE auth_identities
        SET provider_login_snapshot = ?,
            provider_email_snapshot = COALESCE(?, provider_email_snapshot),
            last_seen_at = ?
        WHERE id = ? AND account_id = ?
      `).bind(
        input.profile.login,
        /* COALESCE: adres bu girişte alınamadıysa (kullanıcı izni geri
         * çekti, GitHub doğrulanmış adres döndürmedi) elimizdeki adresi
         * silmiyoruz. Aksi hâlde tek bir izinsiz giriş, güvenlik bildirimi
         * gönderebileceğimiz tek kanalı sessizce yok ederdi. */
        input.profile.email,
        input.now,
        input.identity.identityId,
        input.identity.accountId,
      ),
      this.#db.prepare(`
        UPDATE accounts
        SET display_name = ?,
            avatar_url = ?,
            avatar_media_id = NULL,
            terms_accepted_at = ?,
            terms_version = ?,
            updated_at = ?, last_login_at = ?
        WHERE id = ? AND status = 'active'
      `).bind(
        input.profile.displayName,
        input.profile.avatarUrl,
        /* Onay her girişte tazeleniyor. Kutu her girişte işaretlendiği için
         * saklanan değer "en son ne zaman, hangi metni" oluyor; koşullar
         * değiştiğinde kimin yeni metni gördüğü de buradan okunuyor. */
        input.consent.acceptedAt,
        input.consent.version,
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
      this.#signInEventInsert(input.identity.accountId, input.signInEvent, input.now),
      this.#db.prepare(`
        INSERT INTO oauth_flow_consumptions (flow_id, account_id, consumed_at)
        VALUES (?, ?, ?)
      `).bind(input.flowId, input.identity.accountId, input.now),
    ]);
  }

  async countRecentRegistrations(
    input: Parameters<IdentityRepository['countRecentRegistrations']>[0],
  ): Promise<{ fromIp: number; total: number }> {
    /* Dış WHERE iki pencerenin ERKEN olanını alıyor; içerideki iki koşul
     * kendi penceresini kendi daraltıyor. Tek tarama, iki cevap.
     *
     * IP karşılaştırması metin eşitliği: aynı istemci Cloudflare'den her
     * seferinde aynı biçimde yazılmış adresle geliyor. IPv6'yı normalize
     * etmeye çalışmıyoruz — yanlış normalize edilmiş bir adres, farklı iki
     * aboneyi aynı sayaca koyabilirdi. */
    const row = await this.#db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ?) AS total,
        COUNT(*) FILTER (WHERE ip IS NOT NULL AND ip = ? AND created_at >= ?) AS from_ip
      FROM account_sign_in_events
      WHERE event_type = 'registration' AND created_at >= ?
    `).bind(
      input.globalSince,
      input.ip,
      input.ipSince,
      Math.min(input.globalSince, input.ipSince),
    ).first<{ total: number; from_ip: number }>();
    return { fromIp: row?.from_ip ?? 0, total: row?.total ?? 0 };
  }

  async registerGithubIdentity(input: Parameters<IdentityRepository['registerGithubIdentity']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, display_name, avatar_url,
          status, created_at, updated_at, last_login_at,
          terms_accepted_at, terms_version
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).bind(
        input.accountId,
        input.handle,
        input.handle.toLowerCase(),
        input.profile.displayName,
        input.profile.avatarUrl,
        input.now,
        input.now,
        input.now,
        /* Onay hesabın kendisiyle AYNI ifadede yazılıyor. Ayrı bir UPDATE
         * olsaydı, batch'in ortasında düşen bir çağrı onaysız bir hesap
         * bırakabilirdi — ve o hesap, hiç kabul etmemiş biri adına açılmış
         * bir hesap olurdu. */
        input.consent.acceptedAt,
        input.consent.version,
      ),
      this.#db.prepare(`
        INSERT INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, provider_email_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?)
      `).bind(
        input.identityId,
        input.accountId,
        input.profile.userId,
        input.profile.login,
        input.profile.email,
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
        input.loginAuditEventId,
        'auth.github.registered',
        input.accountId,
        'session',
        input.session.id,
        input.requestId,
        input.now,
      ),
      this.#signInEventInsert(input.accountId, input.signInEvent, input.now),
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
             identity.provider_login_snapshot AS github_login,
             COALESCE(GROUP_CONCAT(DISTINCT ar.role), '') AS roles,
             COALESCE(MAX(aq.limit_value), 0) AS agent_quota,
             a.announcement_emails_enabled
      FROM accounts a
      LEFT JOIN auth_identities identity
        ON identity.account_id = a.id AND identity.provider = 'github'
      LEFT JOIN account_roles ar
        ON ar.account_id = a.id AND ar.revoked_at IS NULL
      LEFT JOIN account_quotas aq
        ON aq.account_id = a.id AND aq.quota_key = 'agents.max_active'
      WHERE a.id = ? AND a.status = 'active'
      GROUP BY a.id, a.handle, a.display_name, a.avatar_url,
               identity.provider_login_snapshot, a.announcement_emails_enabled
    `).bind(accountId).first<{
      id: string;
      handle: string;
      github_login: string | null;
      display_name: string;
      avatar_url: string | null;
      roles: string;
      agent_quota: number;
      announcement_emails_enabled: number;
    }>();
    return row ? {
      id: row.id,
      handle: row.handle,
      githubLogin: row.github_login,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      roles: row.roles ? row.roles.split(',').sort() : [],
      agentQuota: row.agent_quota,
      announcementEmails: row.announcement_emails_enabled === 1,
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

  async cleanup(
    now: number,
    oauthCutoff: number,
    sessionCutoff: number,
    signInEventCutoff: number,
  ): Promise<{
    oauthFlows: number;
    sessions: number;
    idempotencyKeys: number;
    signInEvents: number;
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
        DELETE FROM idempotency_keys
        WHERE expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM media_transform_claims claim
            WHERE claim.idempotency_id = idempotency_keys.id
          )
      `).bind(now),
      /* Giriş izinin saklama süresi burada gerçekten işliyor. Bir yıl
       * demek, bir yıl sonra satırın gitmesi demek; gizlilik metnindeki
       * süre bu satırın çalışmasına dayanıyor. */
      this.#db.prepare(`
        DELETE FROM account_sign_in_events WHERE created_at <= ?
      `).bind(signInEventCutoff),
    ]);
    return {
      oauthFlows: results[1]?.meta?.changes ?? 0,
      sessions: results[3]?.meta?.changes ?? 0,
      idempotencyKeys: results[4]?.meta?.changes ?? 0,
      signInEvents: results[5]?.meta?.changes ?? 0,
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

  #signInEventInsert(accountId: string, event: NewSignInEvent, createdAt: number) {
    return this.#db.prepare(`
      INSERT INTO account_sign_in_events (
        id, account_id, event_type, ip, asn, asn_organization, country, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.id,
      accountId,
      event.eventType,
      event.trace.ip,
      event.trace.asn,
      event.trace.asnOrganization,
      event.trace.country,
      createdAt,
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
