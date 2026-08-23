import {
  parseSiteAuthorizationScopes,
  serializeSiteAuthorizationScopes,
} from '../../identity/site-authorization-scopes';
import type {
  SiteAuthorizationCodeView,
  SiteAuthorizationRepository,
  SiteClientView,
  SiteGrantView,
  SiteTokenResolution,
  SiteTokenView,
} from '../site-authorization-repository';
import type { D1DatabaseLike, D1RunResultLike } from './d1-foundation-repository';

interface ClientSqlRow {
  id: string;
  client_id: string;
  secret_digest: string;
  hash_version: number;
  label: string;
  site_url: string;
  allowed_scopes: string;
  environment: string;
  status: string;
  created_at: number;
  revoked_at: number | null;
  actions_url: string | null;
  actions_endpoint: string | null;
}

interface GrantSqlRow {
  id: string;
  client_id: string;
  client_label: string;
  client_site_url: string;
  account_id: string;
  scopes: string;
  consent_version: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  agent_access_at: number | null;
}

interface CodeSqlRow {
  id: string;
  grant_id: string;
  code_digest: string;
  hash_version: number;
  redirect_uri: string;
  pkce_challenge: string;
  nonce: string | null;
  scopes: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface TokenSqlRow {
  id: string;
  grant_id: string;
  token_type: string;
  secret_digest: string;
  hash_version: number;
  replaced_by_id: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

const GRANT_SELECT = `
  SELECT grant_row.id, grant_row.client_id, client.label AS client_label,
         client.site_url AS client_site_url, grant_row.account_id,
         grant_row.scopes, grant_row.consent_version, grant_row.created_at,
         grant_row.updated_at, grant_row.last_used_at, grant_row.revoked_at,
         grant_row.revoked_reason, grant_row.agent_access_at
  FROM oauth_client_grants grant_row
  JOIN oauth_clients client ON client.id = grant_row.client_id
`;

function assertEnvironment(value: string): 'production' | 'development' {
  if (value !== 'production' && value !== 'development') {
    throw new Error('oauth_client_environment_invalid');
  }
  return value;
}

function assertClientStatus(value: string): 'active' | 'revoked' {
  if (value !== 'active' && value !== 'revoked') throw new Error('oauth_client_status_invalid');
  return value;
}

function assertAccountStatus(value: string): 'active' | 'suspended' | 'closed' {
  if (value !== 'active' && value !== 'suspended' && value !== 'closed') {
    throw new Error('oauth_grant_account_status_invalid');
  }
  return value;
}

function assertTokenType(value: string): 'access' | 'refresh' {
  if (value !== 'access' && value !== 'refresh') throw new Error('oauth_token_type_invalid');
  return value;
}

function clientFromSql(row: ClientSqlRow, redirectUris: string[]): SiteClientView {
  return {
    id: row.id,
    clientId: row.client_id,
    secretDigest: row.secret_digest,
    hashVersion: row.hash_version,
    label: row.label,
    siteUrl: row.site_url,
    allowedScopes: parseSiteAuthorizationScopes(row.allowed_scopes),
    environment: assertEnvironment(row.environment),
    status: assertClientStatus(row.status),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    actionsUrl: row.actions_url,
    actionsEndpoint: row.actions_endpoint,
    redirectUris,
  };
}

function grantFromSql(row: GrantSqlRow): SiteGrantView {
  return {
    id: row.id,
    clientId: row.client_id,
    clientLabel: row.client_label,
    clientSiteUrl: row.client_site_url,
    accountId: row.account_id,
    scopes: parseSiteAuthorizationScopes(row.scopes),
    consentVersion: row.consent_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    agentAccessAt: row.agent_access_at,
  };
}

function codeFromSql(row: CodeSqlRow): SiteAuthorizationCodeView {
  return {
    id: row.id,
    grantId: row.grant_id,
    codeDigest: row.code_digest,
    hashVersion: row.hash_version,
    redirectUri: row.redirect_uri,
    pkceChallenge: row.pkce_challenge,
    nonce: row.nonce,
    scopes: parseSiteAuthorizationScopes(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function tokenFromSql(row: TokenSqlRow): SiteTokenView {
  return {
    id: row.id,
    grantId: row.grant_id,
    tokenType: assertTokenType(row.token_type),
    secretDigest: row.secret_digest,
    hashVersion: row.hash_version,
    replacedById: row.replaced_by_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function auditMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function changedRows(result: D1RunResultLike): number {
  return result.meta?.changes ?? 0;
}

export class D1SiteAuthorizationRepository implements SiteAuthorizationRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async getClientByClientId(clientId: string): Promise<SiteClientView | null> {
    const row = await this.#db.prepare(`
      SELECT id, client_id, secret_digest, hash_version, label, site_url,
             allowed_scopes, environment, status, created_at, revoked_at,
             actions_url, actions_endpoint
      FROM oauth_clients
      WHERE client_id = ?
    `).bind(clientId).first<ClientSqlRow>();
    if (!row) return null;

    const uris = await this.#db.prepare(`
      SELECT redirect_uri FROM oauth_client_redirect_uris
      WHERE client_id = ?
      ORDER BY created_at, redirect_uri
    `).bind(row.id).all<{ redirect_uri: string }>();

    return clientFromSql(row, uris.results.map((entry) => entry.redirect_uri));
  }

  async getClientById(id: string): Promise<SiteClientView | null> {
    const row = await this.#db.prepare(`
      SELECT id, client_id, secret_digest, hash_version, label, site_url,
             allowed_scopes, environment, status, created_at, revoked_at,
             actions_url, actions_endpoint
      FROM oauth_clients
      WHERE id = ?
    `).bind(id).first<ClientSqlRow>();
    if (!row) return null;

    const uris = await this.#db.prepare(`
      SELECT redirect_uri FROM oauth_client_redirect_uris
      WHERE client_id = ?
      ORDER BY created_at, redirect_uri
    `).bind(row.id).all<{ redirect_uri: string }>();

    return clientFromSql(row, uris.results.map((entry) => entry.redirect_uri));
  }

  async createClient(
    input: Parameters<SiteAuthorizationRepository['createClient']>[0],
  ): Promise<SiteClientView | null> {
    /* Var olanı EZMİYORUZ. Aynı `client_id` ikinci kez kaydedilirse mevcut
     * sitenin sırrı sessizce geçersizleşir ve o site bir daha giriş
     * yaptıramaz — sebebi de hiçbir yerde görünmez. */
    const existing = await this.#db
      .prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?')
      .bind(input.clientId)
      .first();
    if (existing) return null;

    /* İstemci ve yönlendirme adresleri TEK toplu yazımda: adressiz bir
     * istemci satırı, hiçbir girişi tamamlayamayacak ölü bir kayıt olurdu. */
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO oauth_clients (
          id, client_id, secret_digest, hash_version, label, site_url,
          allowed_scopes, environment, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).bind(
        input.id,
        input.clientId,
        input.secretDigest,
        input.hashVersion,
        input.label,
        input.siteUrl,
        input.allowedScopes.join(' '),
        input.environment,
        input.createdAt,
      ),
      ...input.redirectUris.map((entry) => this.#db.prepare(`
        INSERT INTO oauth_client_redirect_uris (id, client_id, redirect_uri, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(entry.id, input.id, entry.uri, input.createdAt)),
    ]);

    return this.getClientByClientId(input.clientId);
  }

  async ensureSubject(
    input: Parameters<SiteAuthorizationRepository['ensureSubject']>[0],
  ): Promise<string> {
    /* `ON CONFLICT DO NOTHING` ile yazıp sonra okuyoruz. Önce okuyup sonra
     * yazmak, aynı kullanıcının iki sekmede aynı anda giriş yaptığı durumda
     * iki kimlik üretmeye çalışır ve biri UNIQUE'e çarpardı. */
    await this.#db.prepare(`
      INSERT INTO oauth_client_subjects (id, client_id, account_id, subject, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (client_id, account_id) DO NOTHING
    `).bind(
      input.id,
      input.clientId,
      input.accountId,
      input.subject,
      input.createdAt,
    ).run();

    const row = await this.#db.prepare(`
      SELECT subject FROM oauth_client_subjects WHERE client_id = ? AND account_id = ?
    `).bind(input.clientId, input.accountId).first<{ subject: string }>();
    if (!row) throw new Error('oauth_client_subject_missing_after_insert');
    return row.subject;
  }

  async getGrant(
    input: Parameters<SiteAuthorizationRepository['getGrant']>[0],
  ): Promise<SiteGrantView | null> {
    const row = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.client_id = ? AND grant_row.account_id = ?
    `).bind(input.clientId, input.accountId).first<GrantSqlRow>();
    return row ? grantFromSql(row) : null;
  }

  async getGrantById(grantId: string): Promise<SiteGrantView | null> {
    const row = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.id = ?
    `).bind(grantId).first<GrantSqlRow>();
    return row ? grantFromSql(row) : null;
  }

  async listAccountGrants(accountId: string): Promise<SiteGrantView[]> {
    const rows = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.account_id = ?
      ORDER BY grant_row.created_at DESC
    `).bind(accountId).all<GrantSqlRow>();
    return rows.results.map(grantFromSql);
  }

  async setAgentAccess(input: {
    grantId: string;
    allowed: boolean;
    now: number;
  }): Promise<SiteGrantView | null> {
    /* `revoked_at IS NULL` koşulu WHERE'de, çağıranın kontrolüne bırakılmadı:
     * iptal edilmiş bir izne ajan erişimi açmak sessizce "başarılı" dönerse
     * panelde açık görünen ama hiçbir zaman çalışmayacak bir anahtar doğar. */
    await this.#db.prepare(`
      UPDATE oauth_client_grants
         SET agent_access_at = ?, updated_at = ?
       WHERE id = ? AND revoked_at IS NULL
    `).bind(input.allowed ? input.now : null, input.now, input.grantId).run();

    const row = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.id = ?
    `).bind(input.grantId).first<GrantSqlRow>();
    return row ? grantFromSql(row) : null;
  }

  async recordConsentWithCode(
    input: Parameters<SiteAuthorizationRepository['recordConsentWithCode']>[0],
  ): Promise<SiteGrantView> {
    const grantScopes = serializeSiteAuthorizationScopes(input.grant.scopes);
    const codeScopes = serializeSiteAuthorizationScopes(input.code.scopes);

    /* İzin satırı UPSERT: aynı siteye ikinci giriş yeni izin doğurmuyor,
     * mevcut olanı tazeliyor. `revoked_at` de temizleniyor — kullanıcı iptal
     * ettiği bir siteye yeniden onay verdiyse o izin yeniden yaşıyor, yoksa
     * iptal ettiği site bir daha hiç bağlanamazdı. */
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO oauth_client_grants (
          id, client_id, account_id, scopes, consent_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id, account_id) DO UPDATE SET
          scopes = excluded.scopes,
          consent_version = excluded.consent_version,
          updated_at = excluded.updated_at,
          revoked_at = NULL,
          revoked_reason = NULL
      `).bind(
        input.grant.id,
        input.grant.clientId,
        input.grant.accountId,
        grantScopes,
        input.grant.consentVersion,
        input.grant.now,
        input.grant.now,
      ),
      this.#db.prepare(`
        INSERT INTO oauth_authorization_codes (
          id, grant_id, code_digest, hash_version, redirect_uri,
          pkce_challenge, nonce, scopes, created_at, expires_at
        )
        SELECT ?, grant_row.id, ?, ?, ?, ?, ?, ?, ?, ?
        FROM oauth_client_grants grant_row
        WHERE grant_row.client_id = ? AND grant_row.account_id = ?
      `).bind(
        input.code.id,
        input.code.codeDigest,
        input.code.hashVersion,
        input.code.redirectUri,
        input.code.pkceChallenge,
        input.code.nonce,
        codeScopes,
        input.code.createdAt,
        input.code.expiresAt,
        input.grant.clientId,
        input.grant.accountId,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        )
        SELECT ?, 'site.consent_recorded', 'account', ?, 'oauth_client_grant',
               grant_row.id, ?, ?, ?
        FROM oauth_client_grants grant_row
        WHERE grant_row.client_id = ? AND grant_row.account_id = ?
      `).bind(
        input.auditEventId,
        input.grant.accountId,
        input.requestId,
        auditMetadata({
          clientId: input.grant.clientId,
          scopes: input.grant.scopes,
          consentVersion: input.grant.consentVersion,
          redirectUri: input.code.redirectUri,
        }),
        input.grant.now,
        input.grant.clientId,
        input.grant.accountId,
      ),
    ]);

    const grant = await this.getGrant({
      clientId: input.grant.clientId,
      accountId: input.grant.accountId,
    });
    if (!grant) throw new Error('oauth_client_grant_missing_after_consent');
    return grant;
  }

  async getAuthorizationCodeByDigest(codeDigest: string): Promise<SiteAuthorizationCodeView | null> {
    const row = await this.#db.prepare(`
      SELECT id, grant_id, code_digest, hash_version, redirect_uri,
             pkce_challenge, nonce, scopes, created_at, expires_at, consumed_at
      FROM oauth_authorization_codes
      WHERE code_digest = ?
    `).bind(codeDigest).first<CodeSqlRow>();
    return row ? codeFromSql(row) : null;
  }

  async consumeAuthorizationCode(
    input: Parameters<SiteAuthorizationRepository['consumeAuthorizationCode']>[0],
  ): Promise<boolean> {
    /* Tek kullanımlığı sağlayan yer TEK bir ifade: `consumed_at IS NULL`
     * koşulu güncellemenin içinde. Okuyup sonra yazsaydık, aynı kodu iki kez
     * getiren iki istek arasında ikisinin de "kullanılmamış" gördüğü bir aralık
     * olurdu.
     *
     * Anahtarlar bundan SONRA yazılıyor. Sıra bilinçli: arada bir hata olursa
     * kod yanmış ama anahtar üretilmemiş olur — kullanıcı yeniden giriş yapar.
     * Ters sırada, anahtar üretilip kod açık kalabilirdi. */
    const result = await this.#db.prepare(`
      UPDATE oauth_authorization_codes
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(input.consumedAt, input.codeId, input.consumedAt).run();
    return changedRows(result) === 1;
  }

  async issueTokenPair(
    input: Parameters<SiteAuthorizationRepository['issueTokenPair']>[0],
  ): Promise<void> {
    const statements = [
      this.#db.prepare(`
        INSERT INTO oauth_site_tokens (
          id, grant_id, token_type, secret_digest, hash_version,
          created_at, expires_at
        ) VALUES (?, ?, 'access', ?, ?, ?, ?)
      `).bind(
        input.access.id,
        input.grantId,
        input.access.secretDigest,
        input.access.hashVersion,
        input.now,
        input.access.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO oauth_site_tokens (
          id, grant_id, token_type, secret_digest, hash_version,
          created_at, expires_at
        ) VALUES (?, ?, 'refresh', ?, ?, ?, ?)
      `).bind(
        input.refresh.id,
        input.grantId,
        input.refresh.secretDigest,
        input.refresh.hashVersion,
        input.now,
        input.refresh.expiresAt,
      ),
      this.#db.prepare(`
        UPDATE oauth_client_grants SET last_used_at = ? WHERE id = ?
      `).bind(input.now, input.grantId),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, ?, 'system', NULL, 'oauth_client_grant', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.auditEventType,
        input.grantId,
        input.requestId,
        auditMetadata({
          accessTokenId: input.access.id,
          refreshTokenId: input.refresh.id,
          replacesRefreshTokenId: input.replacesRefreshTokenId,
        }),
        input.now,
      ),
    ];

    if (input.replacesRefreshTokenId !== null) {
      /* Rotasyon zinciri: eski anahtar yenisine işaret ediyor ve aynı anda
       * iptal ediliyor. `used_at` zaten işaretlenmişti; iptal ayrı bir alan,
       * çünkü "kullanıldı" ile "artık geçerli değil" iki farklı soru. */
      statements.push(this.#db.prepare(`
        UPDATE oauth_site_tokens
        SET replaced_by_id = ?, revoked_at = ?, revoked_reason = 'rotated'
        WHERE id = ? AND token_type = 'refresh'
      `).bind(input.refresh.id, input.now, input.replacesRefreshTokenId));
    }

    await this.#db.batch(statements);
  }

  async resolveToken(
    input: Parameters<SiteAuthorizationRepository['resolveToken']>[0],
  ): Promise<SiteTokenResolution | null> {
    const row = await this.#db.prepare(`
      SELECT token.id, token.grant_id, token.token_type, token.secret_digest,
             token.hash_version, token.replaced_by_id, token.created_at,
             token.expires_at, token.used_at, token.revoked_at,
             token.revoked_reason,
             account.status AS account_status,
             client.status AS client_status,
             subject.subject AS subject
      FROM oauth_site_tokens token
      JOIN oauth_client_grants grant_row ON grant_row.id = token.grant_id
      JOIN oauth_clients client ON client.id = grant_row.client_id
      JOIN accounts account ON account.id = grant_row.account_id
      LEFT JOIN oauth_client_subjects subject
        ON subject.client_id = grant_row.client_id
       AND subject.account_id = grant_row.account_id
      WHERE token.secret_digest = ? AND token.token_type = ?
    `).bind(input.secretDigest, input.tokenType).first<TokenSqlRow & {
      account_status: string;
      client_status: string;
      subject: string | null;
    }>();
    if (!row) return null;

    const grant = await this.#db.prepare(`
      ${GRANT_SELECT}
      WHERE grant_row.id = ?
    `).bind(row.grant_id).first<GrantSqlRow>();
    if (!grant) throw new Error('oauth_client_grant_missing_for_token');
    if (row.subject === null) throw new Error('oauth_client_subject_missing_for_token');

    return {
      token: tokenFromSql(row),
      grant: grantFromSql(grant),
      accountStatus: assertAccountStatus(row.account_status),
      clientStatus: assertClientStatus(row.client_status),
      subject: row.subject,
    };
  }

  async markRefreshTokenUsed(
    input: Parameters<SiteAuthorizationRepository['markRefreshTokenUsed']>[0],
  ): Promise<boolean> {
    /* Yenileme anahtarını ilk kullanan kazanıyor. `used_at IS NULL` koşulu
     * güncellemenin içinde olduğu için ikinci istek `false` alıyor ve çağıran
     * bunu tekrar kullanım olarak işliyor. */
    const result = await this.#db.prepare(`
      UPDATE oauth_site_tokens
      SET used_at = ?
      WHERE id = ? AND token_type = 'refresh' AND used_at IS NULL
        AND revoked_at IS NULL AND expires_at > ?
    `).bind(input.usedAt, input.tokenId, input.usedAt).run();
    return changedRows(result) === 1;
  }

  async revokeGrantTokens(
    input: Parameters<SiteAuthorizationRepository['revokeGrantTokens']>[0],
  ): Promise<number> {
    const result = await this.#db.prepare(`
      UPDATE oauth_site_tokens
      SET revoked_at = ?, revoked_reason = ?
      WHERE grant_id = ? AND revoked_at IS NULL
    `).bind(input.revokedAt, input.reason.slice(0, 120), input.grantId).run();

    await this.#db.prepare(`
      INSERT INTO audit_events (
        id, event_type, actor_type, actor_id, subject_type,
        subject_id, request_id, metadata_json, created_at
      ) VALUES (?, 'site.tokens_revoked', 'system', NULL, 'oauth_client_grant',
        ?, ?, ?, ?)
    `).bind(
      input.auditEventId,
      input.grantId,
      input.requestId,
      auditMetadata({ reason: input.reason, revoked: changedRows(result) }),
      input.revokedAt,
    ).run();

    return changedRows(result);
  }

  async touchGrant(
    input: Parameters<SiteAuthorizationRepository['touchGrant']>[0],
  ): Promise<boolean> {
    const result = await this.#db.prepare(`
      UPDATE oauth_client_grants
      SET last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(input.usedAt, input.grantId).run();
    return changedRows(result) === 1;
  }

  async revokeGrant(
    input: Parameters<SiteAuthorizationRepository['revokeGrant']>[0],
  ): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        UPDATE oauth_client_grants
        SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND revoked_at IS NULL
      `).bind(input.revokedAt, input.reason.slice(0, 120), input.grantId),
      /* Anahtarlar aynı işlemde düşüyor. Ayrı adım olsaydı, iptalden sonra
       * hâlâ 15 dakika yaşayan bir erişim anahtarı kalırdı ve kullanıcının
       * "bağlantıyı kes" dediği an ile gerçekten kesildiği an ayrışırdı. */
      this.#db.prepare(`
        UPDATE oauth_site_tokens
        SET revoked_at = ?, revoked_reason = 'grant_revoked'
        WHERE grant_id = ? AND revoked_at IS NULL
      `).bind(input.revokedAt, input.grantId),
      /* Henüz takas edilmemiş kodlar da yanıyor: iptal anında tarayıcıda
       * duran bir kod, iptalden sonra anahtar üretebilirdi. */
      this.#db.prepare(`
        UPDATE oauth_authorization_codes
        SET consumed_at = ?
        WHERE grant_id = ? AND consumed_at IS NULL
      `).bind(input.revokedAt, input.grantId),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'site.grant_revoked', 'account', ?, 'oauth_client_grant',
          ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.actorAccountId,
        input.grantId,
        input.requestId,
        auditMetadata({ reason: input.reason }),
        input.revokedAt,
      ),
    ]);
  }

  async deleteExpiredAuthorizationCodes(
    input: Parameters<SiteAuthorizationRepository['deleteExpiredAuthorizationCodes']>[0],
  ): Promise<number> {
    const result = await this.#db.prepare(`
      DELETE FROM oauth_authorization_codes WHERE expires_at <= ?
    `).bind(input.deleteBefore).run();
    return changedRows(result);
  }
}
