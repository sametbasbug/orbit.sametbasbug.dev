import {
  D1FoundationRepository,
  type D1DatabaseLike,
} from '../src/server/repositories/d1/d1-foundation-repository';

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

function numberValue(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`missing_${key}`);
  }
  return value;
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

async function handleAction(body: ActionRequest, env: Environment): Promise<Response> {
  const data = body.data ?? {};
  const repository = new D1FoundationRepository(env.DB);

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
