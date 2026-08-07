import {
  D1FoundationRepository,
  type D1DatabaseLike,
} from '../src/server/repositories/d1/d1-foundation-repository';
import { createDynamicBackup } from '../src/server/backup/dynamic-backup';
import type { McpAuthorizationScope } from '../src/server/identity/mcp-authorization-scopes';
import { D1McpAuthorizationRepository } from '../src/server/repositories/d1/d1-mcp-authorization-repository';
import { D1PublicRepository } from '../src/server/repositories/d1/d1-public-repository';

interface TestStatement {
  bind(...values: unknown[]): TestStatement;
  run<T = unknown>(): Promise<T>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface TestDatabase extends D1DatabaseLike {
  prepare(query: string): TestStatement;
}

interface Environment {
  DB: TestDatabase;
}

interface ActionRequest {
  action: string;
  data?: Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function stringValue(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing_${key}`);
  }
  return value;
}

function optionalString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`missing_${key}`);
  }
  return value;
}

function stringArrayValue(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`missing_${key}`);
  }
  return value as string[];
}

async function count(db: TestDatabase, table: string, column: string, value: string): Promise<number> {
  const allowed = new Set([
    'accounts:id',
    'sessions:account_id',
    'audit_events:id',
    'invitation_redemptions:invitation_id',
    'agent_credentials:agent_id',
  ]);
  if (!allowed.has(`${table}:${column}`)) {
    throw new Error('unsupported_count');
  }
  const row = await db.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

async function seedOwner(db: TestDatabase, accountId: string, now: number): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO accounts (
      id, handle, handle_normalized, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).bind(accountId, accountId, accountId, accountId, now, now).run();
  await db.prepare(`
    INSERT OR IGNORE INTO account_quotas (
      account_id, quota_key, limit_value, updated_by_account_id, updated_at
    ) VALUES (?, 'agents.max_active', -1, ?, ?)
  `).bind(accountId, accountId, now).run();
}

async function seedMcpAgent(
  db: TestDatabase,
  accountId: string,
  agentId: string,
  now: number,
): Promise<void> {
  await seedOwner(db, accountId, now);
  await db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'test.svg', 'direct_publish', 'active', ?, ?)
  `).bind(agentId, agentId, agentId, agentId, now, now).run();
  await db.prepare(`
    INSERT OR IGNORE INTO agent_memberships (
      id, agent_id, account_id, role, created_by_account_id, created_at
    ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
  `).bind(`${agentId}:${accountId}:primary`, agentId, accountId, accountId, now).run();
}

async function seedAgent(
  db: TestDatabase,
  sponsorId: string,
  agentId: string,
  credentialId: string,
  credentialDigest: string,
  now: number,
): Promise<void> {
  await seedOwner(db, sponsorId, now);
  await db.prepare(`
    INSERT INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'test.svg', 'direct_publish', 'active', ?, ?)
  `).bind(agentId, agentId, agentId, agentId, now, now).run();
  await db.prepare(`
    INSERT INTO agent_credentials (
      id, agent_id, secret_digest, hash_version, scopes,
      created_by_account_id, created_at
    ) VALUES (?, ?, ?, 1, 'feed:read records:write', ?, ?)
  `).bind(credentialId, agentId, credentialDigest, sponsorId, now).run();
}

/**
 * Public okuma testleri için sabit bir dünya kurar: accent'li ajanlar, biri
 * emekli iki konu, bir gönderi ve görünürlük durumları farklı yanıtlar.
 * Amaç D1PublicRepository'nin hidrasyon SQL'ini gerçek veritabanında koşturmak.
 */
async function seedPublicWorld(
  db: TestDatabase,
  repository: D1FoundationRepository,
  now: number,
): Promise<void> {
  await seedOwner(db, 'public-owner', now);

  const agents: Array<[handle: string, avatar: string, accent: string]> = [
    ['alfa', '/agents/alfa.webp', '#a891ff'],
    ['beta', '/agents/beta.webp', '#f0bd68'],
    ['gama', '', '#69cfe3'],
    ['delta', '/agents/delta.webp', '#ff4fd8'],
    ['epsilon', '', '#5fbf7a'],
    ['zeta', '', '#c76a3d'],
    ['eta', '', '#3d7ac7'],
  ];
  for (const [handle, avatar, accent] of agents) {
    await db.prepare(`
      INSERT INTO agents (
        id, handle, handle_normalized, display_name, bio, avatar_asset,
        accent, publication_mode, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, ?, 'direct_publish', 'active', ?, ?)
    `).bind(handle, handle, handle, handle, avatar, accent, now, now).run();
  }

  await db.prepare(`
    INSERT INTO topics (id, slug, label, status, accent)
    VALUES ('topic-live', 'yorunge', 'Yörünge', 'active', '#3aa0d8')
  `).run();
  await db.prepare(`
    INSERT INTO topics (id, slug, label, status, accent)
    VALUES ('topic-retired', 'arsiv', 'Arşiv', 'retired', '#999999')
  `).run();

  const publish = async (
    id: string,
    authorAgentId: string,
    publishedAt: number,
    parent: { parentId: string; rootId: string } | null,
  ): Promise<void> => {
    await repository.createRecordWithRevision({
      record: {
        id,
        kind: parent ? 'reply' : 'post',
        authorAgentId,
        slug: `slug-${id}`,
        parentId: parent?.parentId,
        rootId: parent?.rootId ?? id,
        lifecycleState: 'published',
        createdAt: publishedAt,
        publishedAt,
      },
      revision: {
        id: `rev-${id}`,
        bodyMarkdown: `${id} gövdesi`,
        summary: `${id} özeti`,
        state: 'published',
        createdByAgentId: authorAgentId,
        createdAt: publishedAt,
        publishedAt,
      },
    });
  };

  // Ana gönderi: iki konu, biri emekli.
  await publish('post-main', 'alfa', now, null);
  for (const topicId of ['topic-live', 'topic-retired']) {
    await db.prepare(`
      INSERT INTO record_topics (record_id, topic_id, created_at) VALUES (?, ?, ?)
    `).bind('post-main', topicId, now).run();
  }

  const thread = { parentId: 'post-main', rootId: 'post-main' };
  await publish('reply-beta-1', 'beta', now + 10, thread);
  await publish('reply-gama', 'gama', now + 20, thread);
  await publish('reply-beta-2', 'beta', now + 30, thread);
  // Kaldırılan ve silinen yanıt: ne sayıya ne avatar yığınına girmeli.
  await publish('reply-removed', 'delta', now + 40, thread);
  await db.prepare(`UPDATE records SET moderation_state = 'removed' WHERE id = 'reply-removed'`).run();
  await publish('reply-deleted', 'delta', now + 50, thread);
  await db.prepare(`UPDATE records SET deleted_at = ? WHERE id = 'reply-deleted'`).bind(now + 51).run();

  // İkinci gönderi: beş farklı ajan yanıtlıyor, avatar yığını dörtte kesilmeli.
  await publish('post-crowded', 'alfa', now + 100, null);
  const crowd = { parentId: 'post-crowded', rootId: 'post-crowded' };
  const crowdAgents = ['beta', 'gama', 'delta', 'epsilon', 'zeta'];
  for (const [index, handle] of crowdAgents.entries()) {
    await publish(`reply-crowd-${handle}`, handle, now + 101 + index, crowd);
  }
}

/**
 * Duyuru dünyası: public yüzeyin dışarıda bırakması gereken her durumdan
 * en az bir örnek. Yalnız `public-*` kimlikli olanlar herkese açık.
 *
 * Hedefli duyuru için gerçek bir ajana ihtiyaç var — `target_agent_id`
 * yabancı anahtar taşıyor — ve seedPublicWorld zaten `alfa`yı kuruyor.
 */
async function seedAnnouncementWorld(db: TestDatabase, now: number): Promise<void> {
  await seedOwner(db, 'announcement-owner', now);
  const rows: Array<{
    id: string;
    title: string;
    severity: 'info' | 'warning' | 'critical';
    audience: 'all_agents' | 'equinox_agents' | 'agent';
    target: string | null;
    status: 'draft' | 'active' | 'expired' | 'withdrawn';
    startsAt: number;
    expiresAt: number | null;
  }> = [
    { id: 'public-info', title: 'Herkese açık bilgi', severity: 'info', audience: 'all_agents', target: null, status: 'active', startsAt: now - 3000, expiresAt: null },
    { id: 'public-critical', title: 'Herkese açık kritik', severity: 'critical', audience: 'all_agents', target: null, status: 'active', startsAt: now - 1000, expiresAt: now + 86_400_000 },
    { id: 'public-warning', title: 'Herkese açık uyarı', severity: 'warning', audience: 'all_agents', target: null, status: 'active', startsAt: now - 2000, expiresAt: null },
    // Aşağıdakilerin hiçbiri public listeye giremez.
    { id: 'hidden-equinox', title: 'Equinox iç notu', severity: 'info', audience: 'equinox_agents', target: null, status: 'active', startsAt: now - 1000, expiresAt: null },
    { id: 'hidden-targeted', title: 'Tek ajana not', severity: 'critical', audience: 'agent', target: 'alfa', status: 'active', startsAt: now - 1000, expiresAt: null },
    { id: 'hidden-draft', title: 'Taslak duyuru', severity: 'info', audience: 'all_agents', target: null, status: 'draft', startsAt: now - 1000, expiresAt: null },
    { id: 'hidden-withdrawn', title: 'Geri çekilmiş duyuru', severity: 'critical', audience: 'all_agents', target: null, status: 'withdrawn', startsAt: now - 1000, expiresAt: null },
    { id: 'hidden-expired-status', title: 'Süresi dolmuş duyuru', severity: 'info', audience: 'all_agents', target: null, status: 'expired', startsAt: now - 5000, expiresAt: now - 4000 },
    // Durumu hâlâ 'active' ama yürürlük penceresi kapanmış: cron duyuruyu
    // 'expired' yapana kadar geçen sürede de görünmemeli.
    { id: 'hidden-lapsed', title: 'Penceresi kapanmış duyuru', severity: 'warning', audience: 'all_agents', target: null, status: 'active', startsAt: now - 5000, expiresAt: now - 10 },
    // Yayımlanmış ama başlangıcı gelecekte: sıraya girmeden görünmemeli.
    { id: 'hidden-future', title: 'Henüz başlamamış duyuru', severity: 'info', audience: 'all_agents', target: null, status: 'active', startsAt: now + 60_000, expiresAt: null },
  ];
  for (const row of rows) {
    await db.prepare(`
      INSERT INTO announcements (
        id, title, body_markdown, severity, audience_type, target_agent_id,
        status, starts_at, expires_at, created_by_account_id,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'announcement-owner', ?, ?, ?)
    `).bind(
      row.id,
      row.title,
      `${row.title} gövdesi. **Kalın** metin markdown yolundan geçmeli.`,
      row.severity,
      row.audience,
      row.target,
      row.status,
      row.startsAt,
      row.expiresAt,
      now,
      now,
      row.status === 'draft' ? null : row.startsAt,
    ).run();
  }
}

async function handleAction(body: ActionRequest, env: Environment): Promise<Response> {
  const data = body.data ?? {};
  const repository = new D1FoundationRepository(env.DB);
  const mcpRepository = new D1McpAuthorizationRepository(env.DB);
  const publicRepository = new D1PublicRepository(env.DB);

  switch (body.action) {
    case 'health':
      return json({ ok: true });

    case 'seedInvitation': {
      const ownerId = stringValue(data, 'ownerId');
      const invitationId = stringValue(data, 'invitationId');
      const expectedGithubUserId = data.expectedGithubUserId;
      const now = numberValue(data, 'now');
      await seedOwner(env.DB, ownerId, now);
      await env.DB.prepare(`
        INSERT INTO invitations (
          id, secret_digest, hash_version, expected_github_user_id,
          agent_quota, created_by_account_id, created_at, expires_at
        ) VALUES (?, ?, 1, ?, 1, ?, ?, ?)
      `).bind(
        invitationId,
        `digest:${invitationId}`,
        typeof expectedGithubUserId === 'string' ? expectedGithubUserId : null,
        ownerId,
        now,
        now + 72 * 60 * 60 * 1000,
      ).run();
      return json({ ok: true });
    }

    case 'redeemInvitation': {
      const now = numberValue(data, 'now');
      const accountId = stringValue(data, 'accountId');
      const invitationId = stringValue(data, 'invitationId');
      const githubUserId = stringValue(data, 'githubUserId');
      const auditEventId = stringValue(data, 'auditEventId');
      await repository.redeemInvitation({
        invitationId,
        githubIdentityId: stringValue(data, 'githubIdentityId'),
        githubUserId,
        githubLogin: stringValue(data, 'githubLogin'),
        account: {
          id: accountId,
          handle: stringValue(data, 'handle'),
          displayName: stringValue(data, 'displayName'),
        },
        session: {
          id: stringValue(data, 'sessionId'),
          secretDigest: stringValue(data, 'sessionDigest'),
          hashVersion: 1,
          csrfDigest: stringValue(data, 'csrfDigest'),
          idleExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
          absoluteExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
        },
        agentQuota: 1,
        auditEventId,
        requestId: stringValue(data, 'requestId'),
        now,
      });
      return json({
        accountCount: await count(env.DB, 'accounts', 'id', accountId),
        sessionCount: await count(env.DB, 'sessions', 'account_id', accountId),
        redemptionCount: await count(env.DB, 'invitation_redemptions', 'invitation_id', invitationId),
        auditCount: await count(env.DB, 'audit_events', 'id', auditEventId),
        metrics: repository.metrics(),
      });
    }

    case 'registrationState': {
      const accountId = stringValue(data, 'accountId');
      const invitationId = stringValue(data, 'invitationId');
      const auditEventId = stringValue(data, 'auditEventId');
      return json({
        accountCount: await count(env.DB, 'accounts', 'id', accountId),
        sessionCount: await count(env.DB, 'sessions', 'account_id', accountId),
        redemptionCount: await count(env.DB, 'invitation_redemptions', 'invitation_id', invitationId),
        auditCount: await count(env.DB, 'audit_events', 'id', auditEventId),
      });
    }

    case 'seedMcpAgent': {
      await seedMcpAgent(
        env.DB,
        stringValue(data, 'accountId'),
        stringValue(data, 'agentId'),
        numberValue(data, 'now'),
      );
      return json({ ok: true });
    }

    case 'seedAccount': {
      await seedOwner(
        env.DB,
        stringValue(data, 'accountId'),
        numberValue(data, 'now'),
      );
      return json({ ok: true });
    }

    case 'grantPlatformOwner': {
      const accountId = stringValue(data, 'accountId');
      const now = numberValue(data, 'now');
      await seedOwner(env.DB, accountId, now);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO account_roles (
          id, account_id, role, granted_by_account_id, granted_at
        ) VALUES (?, ?, 'platform_owner', ?, ?)
      `).bind(`${accountId}:platform_owner`, accountId, accountId, now).run();
      return json({ ok: true });
    }

    case 'createMcpGrant': {
      const now = numberValue(data, 'now');
      const grantExpiresAt = data.grantExpiresAt;
      const scopes = stringArrayValue(data, 'scopes') as McpAuthorizationScope[];
      await mcpRepository.createGrantWithCode({
        grant: {
          id: stringValue(data, 'grantId'),
          accountId: stringValue(data, 'accountId'),
          agentId: stringValue(data, 'agentId'),
          scopes,
          oauthClientId: stringValue(data, 'oauthClientId'),
          oauthClientLabel: stringValue(data, 'oauthClientLabel'),
          createdAt: now,
          expiresAt: typeof grantExpiresAt === 'number' ? grantExpiresAt : null,
        },
        code: {
          id: stringValue(data, 'codeId'),
          secretDigest: stringValue(data, 'codeDigest'),
          hashVersion: 1,
          grantId: stringValue(data, 'grantId'),
          authorizationRequestId: stringValue(data, 'authorizationRequestId'),
          createdAt: now,
          expiresAt: numberValue(data, 'codeExpiresAt'),
          consumedAt: null,
        },
        auditEventId: stringValue(data, 'auditEventId'),
        requestId: stringValue(data, 'requestId'),
      });
      return json({
        grant: await mcpRepository.getGrant(stringValue(data, 'grantId')),
        code: await mcpRepository.getDelegationCode(stringValue(data, 'codeId')),
      }, 201);
    }

    case 'getMcpGrant': {
      return json({
        grant: await mcpRepository.getGrant(stringValue(data, 'grantId')),
      });
    }

    case 'listMcpGrants': {
      return json({
        grants: await mcpRepository.listAccountGrants(stringValue(data, 'accountId')),
      });
    }

    case 'getMcpCode': {
      return json({
        code: await mcpRepository.getDelegationCode(stringValue(data, 'codeId')),
      });
    }

    case 'redeemMcpCode': {
      const grant = await mcpRepository.redeemDelegationCode({
        codeId: stringValue(data, 'codeId'),
        grantId: stringValue(data, 'grantId'),
        authorizationRequestId: stringValue(data, 'authorizationRequestId'),
        redemptionAuditEventId: stringValue(data, 'auditEventId'),
        requestId: stringValue(data, 'requestId'),
        redeemedAt: numberValue(data, 'now'),
      });
      return json({
        grant,
        code: await mcpRepository.getDelegationCode(stringValue(data, 'codeId')),
      });
    }

    case 'touchMcpGrant': {
      const touched = await mcpRepository.touchGrant({
        grantId: stringValue(data, 'grantId'),
        usedAt: numberValue(data, 'now'),
      });
      return json({
        touched,
        grant: await mcpRepository.getGrant(stringValue(data, 'grantId')),
      });
    }

    case 'revokeMcpGrant': {
      await mcpRepository.revokeGrant({
        grantId: stringValue(data, 'grantId'),
        actorAccountId: stringValue(data, 'actorAccountId'),
        reason: stringValue(data, 'reason'),
        auditEventId: stringValue(data, 'auditEventId'),
        requestId: stringValue(data, 'requestId'),
        revokedAt: numberValue(data, 'now'),
      });
      return json({
        grant: await mcpRepository.getGrant(stringValue(data, 'grantId')),
      });
    }

    case 'mcpAuthorizationState': {
      const grantId = stringValue(data, 'grantId');
      const codeId = stringValue(data, 'codeId');
      const redemption = await env.DB.prepare(`
        SELECT code_id, grant_id, authorization_request_id, redeemed_at
        FROM mcp_delegation_redemptions
        WHERE code_id = ?
      `).bind(codeId).first();
      const revocation = await env.DB.prepare(`
        SELECT grant_id, actor_account_id, reason, revoked_at
        FROM mcp_authorization_revocations
        WHERE grant_id = ?
      `).bind(grantId).first();
      const audits = await env.DB.prepare(`
        SELECT event_type, actor_type, actor_id, subject_type, subject_id,
               request_id, metadata_json, created_at
        FROM audit_events
        WHERE subject_type = 'mcp_authorization_grant'
          AND subject_id = ?
        ORDER BY sequence
      `).bind(grantId).all();
      return json({ redemption, revocation, audits: audits.results });
    }

    case 'revokeMcpMembership': {
      await env.DB.prepare(`
        UPDATE agent_memberships
        SET revoked_at = ?
        WHERE account_id = ?
          AND agent_id = ?
          AND role = 'primary_sponsor'
          AND revoked_at IS NULL
      `).bind(
        numberValue(data, 'now'),
        stringValue(data, 'accountId'),
        stringValue(data, 'agentId'),
      ).run();
      return json({ ok: true });
    }

    case 'exportBackup': {
      return json(await createDynamicBackup(
        env.DB,
        numberValue(data, 'now'),
        Boolean(data.includeSessions),
      ));
    }

    case 'seedAgent': {
      await seedAgent(
        env.DB,
        stringValue(data, 'sponsorId'),
        stringValue(data, 'agentId'),
        stringValue(data, 'credentialId'),
        stringValue(data, 'credentialDigest'),
        numberValue(data, 'now'),
      );
      return json({ ok: true });
    }

    case 'seedAudit': {
      await env.DB.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type,
          subject_id, request_id, metadata_json, created_at
        ) VALUES (?, 'test.seed', 'system', NULL, NULL, NULL, ?, '{}', ?)
      `).bind(
        stringValue(data, 'auditEventId'),
        stringValue(data, 'requestId'),
        numberValue(data, 'now'),
      ).run();
      return json({ ok: true });
    }

    case 'rotateCredential': {
      const agentId = stringValue(data, 'agentId');
      const expectedCredentialId = stringValue(data, 'expectedCredentialId');
      const replacementCredentialId = stringValue(data, 'replacementCredentialId');
      await repository.rotateAgentCredential({
        agentId,
        expectedCredentialId,
        replacement: {
          id: replacementCredentialId,
          secretDigest: stringValue(data, 'replacementDigest'),
          hashVersion: 1,
          scopes: 'feed:read records:write',
          createdAt: numberValue(data, 'now'),
        },
        sponsorAccountId: stringValue(data, 'sponsorId'),
        auditEventId: stringValue(data, 'auditEventId'),
        requestId: stringValue(data, 'requestId'),
        now: numberValue(data, 'now'),
      });
      const rows = await env.DB.prepare(`
        SELECT id, revoked_at, replaced_by_credential_id
        FROM agent_credentials
        WHERE agent_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all<{
        id: string;
        revoked_at: number | null;
        replaced_by_credential_id: string | null;
      }>();
      return json({ rows: rows.results, metrics: repository.metrics() });
    }

    case 'credentialState': {
      const agentId = stringValue(data, 'agentId');
      const rows = await env.DB.prepare(`
        SELECT id, revoked_at, replaced_by_credential_id
        FROM agent_credentials
        WHERE agent_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all();
      return json({ rows: rows.results });
    }

    case 'seedRecordPair': {
      const now = numberValue(data, 'now');
      const sponsorId = stringValue(data, 'sponsorId');
      const agentId = stringValue(data, 'agentId');
      await seedOwner(env.DB, sponsorId, now);
      await env.DB.prepare(`
        INSERT OR IGNORE INTO agents (
          id, handle, handle_normalized, display_name, bio, avatar_asset,
          publication_mode, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', 'test.svg', 'direct_publish', 'active', ?, ?)
      `).bind(agentId, agentId, agentId, agentId, now, now).run();

      for (const suffix of ['one', 'two']) {
        const recordId = stringValue(data, `record_${suffix}`);
        const revisionId = stringValue(data, `revision_${suffix}`);
        await repository.createRecordWithRevision({
          record: {
            id: recordId,
            kind: 'post',
            authorAgentId: agentId,
            slug: `test-${recordId}`,
            rootId: recordId,
            lifecycleState: 'published',
            createdAt: now,
            publishedAt: now,
          },
          revision: {
            id: revisionId,
            bodyMarkdown: `body ${suffix}`,
            summary: `summary ${suffix}`,
            state: 'published',
            createdByAgentId: agentId,
            createdAt: now,
            publishedAt: now,
          },
        });
      }
      return json({ metrics: repository.metrics() });
    }

    case 'setCurrentRevision': {
      await repository.setCurrentRevision(
        stringValue(data, 'recordId'),
        stringValue(data, 'revisionId'),
        numberValue(data, 'now'),
      );
      return json({ ok: true });
    }

    case 'recordState': {
      const row = await env.DB.prepare(`
        SELECT current_revision_id FROM records WHERE id = ?
      `).bind(stringValue(data, 'recordId')).first();
      return json({ row });
    }

    case 'foreignKeyCheck': {
      const rows = await env.DB.prepare('PRAGMA foreign_key_check').all();
      return json({ rows: rows.results });
    }

    case 'mutateAudit': {
      const auditEventId = stringValue(data, 'auditEventId');
      const mutation = stringValue(data, 'mutation');
      if (mutation === 'update') {
        await env.DB.prepare(`
          UPDATE audit_events SET event_type = 'test.mutated' WHERE id = ?
        `).bind(auditEventId).run();
      } else if (mutation === 'delete') {
        await env.DB.prepare('DELETE FROM audit_events WHERE id = ?').bind(auditEventId).run();
      } else {
        throw new Error('unsupported_mutation');
      }
      return json({ ok: true });
    }

    case 'auditState': {
      const row = await env.DB.prepare(`
        SELECT id, event_type, metadata_json FROM audit_events WHERE id = ?
      `).bind(stringValue(data, 'auditEventId')).first();
      return json({ row });
    }

    case 'seedPublicWorld': {
      await seedPublicWorld(env.DB, repository, numberValue(data, 'now'));
      return json({ ok: true });
    }

    case 'seedAnnouncementWorld': {
      await seedAnnouncementWorld(env.DB, numberValue(data, 'now'));
      return json({ ok: true });
    }

    case 'publicAnnouncements': {
      const announcements = await publicRepository.listPublicAnnouncements(numberValue(data, 'now'));
      return json({ announcements });
    }

    case 'publicFeed': {
      const page = await publicRepository.listFeed({
        limit: numberValue(data, 'limit'),
        cursor: null,
        agentHandle: optionalString(data, 'agentHandle'),
        projectSlug: null,
        topicSlug: optionalString(data, 'topicSlug'),
      });
      return json(page);
    }

    case 'publicRecord': {
      const record = await publicRepository.getRecord(stringValue(data, 'idOrSlug'));
      return json({ record });
    }

    case 'publicThreadReplies': {
      const replies = await publicRepository.listThreadReplies(stringValue(data, 'rootId'));
      return json({ replies });
    }

    default:
      return json({ error: 'unknown_action' }, 404);
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    try {
      const body = await request.json() as ActionRequest;
      return await handleAction(body, env);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        409,
      );
    }
  },
};
