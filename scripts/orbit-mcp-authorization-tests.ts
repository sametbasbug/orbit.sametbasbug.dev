import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { reserveWorkerPorts } from './orbit-test-ports';
import { BACKUP_SCHEMA_VERSION } from '../src/server/backup/dynamic-backup';
import {
  createOpaqueToken,
  parseOpaqueToken,
  verifyOpaqueToken,
} from '../src/server/identity/tokens';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.test.jsonc';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let migrationOutput = '';

function runMigrations(): string {
  const result = spawnSync(
    process.execPath,
    [
      WRANGLER,
      'd1',
      'migrations',
      'apply',
      'orbit-v6-local',
      '--config',
      CONFIG,
      '--local',
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Migration command failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function waitForWorker(process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  let output = '';
  process.stdout.on('data', (chunk) => { output += String(chunk); });
  process.stderr.on('data', (chunk) => { output += String(chunk); });
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready:\n${output}`);
    }
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'health' }),
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not bound the local port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler did not become ready within 20 seconds:\n${output}`);
}

async function callAction<T>(
  action: string,
  data: Record<string, unknown> = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, data }),
  });
  const body = await response.json() as T;
  assert.equal(
    response.status,
    expectedStatus,
    `${action} returned ${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}

function grantData(prefix: string, accountId: string, agentId: string, now: number) {
  return {
    grantId: `${prefix}-grant`,
    accountId,
    agentId,
    scopes: ['feed:read'],
    oauthClientId: `${prefix}-client`,
    oauthClientLabel: `${prefix} ChatGPT client`,
    codeId: `${prefix}-code`,
    codeDigest: `${prefix}-digest`,
    authorizationRequestId: `${prefix}-authorization-request`,
    now,
    codeExpiresAt: now + 5 * 60 * 1000,
    grantExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    auditEventId: `${prefix}-created-audit`,
    requestId: `${prefix}-created-request`,
  };
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-mcp-auth-d1-'));
  migrationOutput = runMigrations();
  const { port, inspectorPort } = await reserveWorkerPorts();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(
    process.execPath,
    [
      WRANGLER,
      'dev',
      '--config',
      CONFIG,
      '--local',
      `--port=${port}`,
      `--inspector-port=${inspectorPort}`,
      `--persist-to=${persistDirectory}`,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  await waitForWorker(worker);
});

after(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => worker?.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  if (persistDirectory) {
    await rm(persistDirectory, { recursive: true, force: true });
  }
});

describe('Orbit MCP authorization foundation', { concurrency: false }, () => {
  test('migration and delegation token family are available', async () => {
    assert.match(migrationOutput, /0022_mcp_authorization_foundation\.sql/u);
    const generated = await createOpaqueToken('delegation', 'test-delegation-pepper');
    assert.match(generated.token, /^orb_mcp_v1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/u);
    assert.equal(parseOpaqueToken(generated.token)?.family, 'delegation');
    const verified = await verifyOpaqueToken(
      generated.token,
      'delegation',
      generated.digest,
      'test-delegation-pepper',
    );
    assert.equal(verified?.selector, generated.selector);
    assert.equal(
      await verifyOpaqueToken(generated.token, 'delegation', generated.digest, 'wrong-pepper'),
      null,
    );
  });

  test('a primary sponsor creates a least-privilege grant and single-use code', async () => {
    const now = Date.now();
    const accountId = 'mcp-sponsor-account';
    const agentId = 'mcp-sponsor-agent';
    await callAction('seedMcpAgent', { accountId, agentId, now });
    const input = grantData('mcp-sponsor', accountId, agentId, now + 1);
    const created = await callAction<{
      grant: {
        id: string;
        accountId: string;
        agentId: string;
        handle: string;
        scopes: string[];
        oauthClientId: string;
        oauthClientLabel: string;
        revokedAt: number | null;
      };
      code: {
        id: string;
        secretDigest: string;
        authorizationRequestId: string;
        consumedAt: number | null;
      };
    }>('createMcpGrant', input, 201);

    assert.deepEqual(created.grant.scopes, ['feed:read']);
    assert.equal(created.grant.accountId, accountId);
    assert.equal(created.grant.agentId, agentId);
    assert.equal(created.grant.handle, agentId);
    assert.equal(created.grant.revokedAt, null);
    assert.equal(created.code.secretDigest, input.codeDigest);
    assert.equal(created.code.authorizationRequestId, input.authorizationRequestId);
    assert.equal(created.code.consumedAt, null);

    const listed = await callAction<{ grants: Array<{ id: string }> }>(
      'listMcpGrants',
      { accountId },
    );
    assert.deepEqual(listed.grants.map((grant) => grant.id), [input.grantId]);
  });

  test('legacy scope combinations persist and the current inbox bundle is canonical', async () => {
    const now = Date.now();
    const accountId = 'mcp-scope-sponsor';
    const agentId = 'mcp-scope-agent';
    await callAction('seedMcpAgent', { accountId, agentId, now });

    const combinations = [
      ['feed:read'],
      ['feed:read', 'posts:write'],
      ['feed:read', 'replies:write'],
      ['feed:read', 'posts:write', 'replies:write'],
      /* Sürüm 3 öncesi tam demet: yeni grant'ler istemez ama daha önce
       * verilmiş grant'ler bu biçimde saklandığı için kabul edilmeye devam
       * etmeli. */
      ['feed:read', 'posts:write', 'replies:write', 'messages:read', 'messages:write'],
      ['feed:read', 'reactions:write'],
      ['feed:read', 'replies:write', 'reactions:write'],
      ['feed:read', 'posts:write', 'replies:write', 'reactions:write'],
    ];
    for (const [index, scopes] of combinations.entries()) {
      const input = {
        ...grantData(`mcp-scope-${index}`, accountId, agentId, now + index + 1),
        scopes,
      };
      const created = await callAction<{ grant: { scopes: string[] } }>('createMcpGrant', input, 201);
      assert.deepEqual(created.grant.scopes, scopes);
    }

    const reordered = {
      ...grantData('mcp-scope-reordered', accountId, agentId, now + 10),
      scopes: ['messages:write', 'reactions:write', 'replies:write', 'feed:read', 'messages:read', 'posts:write'],
    };
    const canonical = await callAction<{ grant: { scopes: string[] } }>('createMcpGrant', reordered, 201);
    assert.deepEqual(canonical.grant.scopes, [
      'feed:read',
      'posts:write',
      'replies:write',
      'reactions:write',
      'messages:read',
      'messages:write',
    ]);
  });

  test('unrelated accounts and invalid scope sets are rejected', async () => {
    const now = Date.now();
    const sponsorId = 'mcp-policy-sponsor';
    const intruderId = 'mcp-policy-intruder';
    const agentId = 'mcp-policy-agent';
    await callAction('seedMcpAgent', { accountId: sponsorId, agentId, now });
    await callAction('seedAccount', { accountId: intruderId, now });

    const unrelated = grantData('mcp-unrelated', intruderId, agentId, now + 1);
    const unrelatedError = await callAction<{ error: string }>('createMcpGrant', unrelated, 409);
    assert.match(unrelatedError.error, /mcp_authorization_agent_not_manageable/u);

    const invalidSets = [
      ['records:write'],
      ['posts:write'],
      ['feed:read', 'feed:read'],
      ['feed:read', 'records:write'],
      ['feed:read', 'posts:write', 'replies:write', 'messages:read'],
      ['feed:read', 'messages:write'],
    ];
    for (const [index, scopes] of invalidSets.entries()) {
      const invalid = {
        ...grantData(`mcp-invalid-scope-${index}`, sponsorId, agentId, now + index + 2),
        scopes,
      };
      const scopeError = await callAction<{ error: string }>('createMcpGrant', invalid, 409);
      assert.match(scopeError.error, /mcp_authorization_scope_invalid/u);
    }
  });

  test('a platform owner may authorize a managed agent without becoming its sponsor', async () => {
    const now = Date.now();
    const sponsorId = 'mcp-owner-sponsor';
    const ownerId = 'mcp-platform-owner';
    const agentId = 'mcp-owner-agent';
    await callAction('seedMcpAgent', { accountId: sponsorId, agentId, now });
    await callAction('grantPlatformOwner', { accountId: ownerId, now });
    const input = grantData('mcp-owner', ownerId, agentId, now + 1);
    const created = await callAction<{ grant: { accountId: string; agentId: string } }>(
      'createMcpGrant',
      input,
      201,
    );
    assert.equal(created.grant.accountId, ownerId);
    assert.equal(created.grant.agentId, agentId);
  });

  test('delegation redemption is request-bound, expiring, and single-use', async () => {
    const now = Date.now();
    const accountId = 'mcp-redemption-sponsor';
    const agentId = 'mcp-redemption-agent';
    await callAction('seedMcpAgent', { accountId, agentId, now });

    const mismatch = grantData('mcp-mismatch', accountId, agentId, now + 1);
    await callAction('createMcpGrant', mismatch, 201);
    const mismatchError = await callAction<{ error: string }>('redeemMcpCode', {
      codeId: mismatch.codeId,
      grantId: mismatch.grantId,
      authorizationRequestId: 'different-authorization-request',
      auditEventId: 'mcp-mismatch-redeem-audit',
      requestId: 'mcp-mismatch-redeem-request',
      now: now + 2,
    }, 409);
    assert.match(mismatchError.error, /invalid_mcp_delegation_code/u);

    const singleUse = grantData('mcp-single-use', accountId, agentId, now + 3);
    await callAction('createMcpGrant', singleUse, 201);
    const redeemed = await callAction<{
      grant: { id: string; scopes: string[] };
      code: { consumedAt: number };
    }>('redeemMcpCode', {
      codeId: singleUse.codeId,
      grantId: singleUse.grantId,
      authorizationRequestId: singleUse.authorizationRequestId,
      auditEventId: 'mcp-single-use-redeem-audit',
      requestId: 'mcp-single-use-redeem-request',
      now: now + 4,
    });
    assert.equal(redeemed.grant.id, singleUse.grantId);
    assert.deepEqual(redeemed.grant.scopes, ['feed:read']);
    assert.equal(redeemed.code.consumedAt, now + 4);

    const replayError = await callAction<{ error: string }>('redeemMcpCode', {
      codeId: singleUse.codeId,
      grantId: singleUse.grantId,
      authorizationRequestId: singleUse.authorizationRequestId,
      auditEventId: 'mcp-single-use-replay-audit',
      requestId: 'mcp-single-use-replay-request',
      now: now + 5,
    }, 409);
    assert.match(replayError.error, /invalid_mcp_delegation_code|UNIQUE constraint/u);

    const expired = {
      ...grantData('mcp-expired', accountId, agentId, now + 6),
      codeExpiresAt: now + 7,
    };
    await callAction('createMcpGrant', expired, 201);
    const expiredError = await callAction<{ error: string }>('redeemMcpCode', {
      codeId: expired.codeId,
      grantId: expired.grantId,
      authorizationRequestId: expired.authorizationRequestId,
      auditEventId: 'mcp-expired-redeem-audit',
      requestId: 'mcp-expired-redeem-request',
      now: now + 8,
    }, 409);
    assert.match(expiredError.error, /invalid_mcp_delegation_code/u);
  });

  test('grant usage is monotonic and revocation blocks later redemption', async () => {
    const now = Date.now();
    const sponsorId = 'mcp-revoke-sponsor';
    const intruderId = 'mcp-revoke-intruder';
    const agentId = 'mcp-revoke-agent';
    await callAction('seedMcpAgent', { accountId: sponsorId, agentId, now });
    await callAction('seedAccount', { accountId: intruderId, now });
    const input = grantData('mcp-revoke', sponsorId, agentId, now + 1);
    await callAction('createMcpGrant', input, 201);

    const touched = await callAction<{
      touched: boolean;
      grant: { lastUsedAt: number };
    }>('touchMcpGrant', { grantId: input.grantId, now: now + 2 });
    assert.equal(touched.touched, true);
    assert.equal(touched.grant.lastUsedAt, now + 2);

    const olderTouch = await callAction<{ touched: boolean }>(
      'touchMcpGrant',
      { grantId: input.grantId, now: now + 1 },
    );
    assert.equal(olderTouch.touched, false);

    const forbidden = await callAction<{ error: string }>('revokeMcpGrant', {
      grantId: input.grantId,
      actorAccountId: intruderId,
      reason: 'not allowed',
      auditEventId: 'mcp-forbidden-revoke-audit',
      requestId: 'mcp-forbidden-revoke-request',
      now: now + 3,
    }, 409);
    assert.match(forbidden.error, /mcp_authorization_revoke_forbidden/u);

    const revoked = await callAction<{
      grant: { revokedAt: number; revokedReason: string };
    }>('revokeMcpGrant', {
      grantId: input.grantId,
      actorAccountId: sponsorId,
      reason: 'user_revoked',
      auditEventId: 'mcp-revoke-audit',
      requestId: 'mcp-revoke-request',
      now: now + 4,
    });
    assert.equal(revoked.grant.revokedAt, now + 4);
    assert.equal(revoked.grant.revokedReason, 'user_revoked');

    const afterRevoke = await callAction<{ touched: boolean }>(
      'touchMcpGrant',
      { grantId: input.grantId, now: now + 5 },
    );
    assert.equal(afterRevoke.touched, false);

    const redemptionError = await callAction<{ error: string }>('redeemMcpCode', {
      codeId: input.codeId,
      grantId: input.grantId,
      authorizationRequestId: input.authorizationRequestId,
      auditEventId: 'mcp-revoked-redeem-audit',
      requestId: 'mcp-revoked-redeem-request',
      now: now + 6,
    }, 409);
    assert.match(redemptionError.error, /invalid_mcp_delegation_code/u);

    const state = await callAction<{
      redemption: unknown;
      revocation: { actor_account_id: string; reason: string };
      audits: Array<{ event_type: string; actor_type: string; actor_id: string | null }>;
    }>('mcpAuthorizationState', { grantId: input.grantId, codeId: input.codeId });
    assert.equal(state.redemption, null);
    assert.equal(state.revocation.actor_account_id, sponsorId);
    assert.equal(state.revocation.reason, 'user_revoked');
    assert.deepEqual(
      state.audits.map((event) => event.event_type),
      ['mcp.authorization_created', 'mcp.authorization_revoked'],
    );
  });

  test('losing current agent management invalidates touch and redemption', async () => {
    const now = Date.now();
    const accountId = 'mcp-source-truth-sponsor';
    const agentId = 'mcp-source-truth-agent';
    await callAction('seedMcpAgent', { accountId, agentId, now });
    const input = grantData('mcp-source-truth', accountId, agentId, now + 1);
    await callAction('createMcpGrant', input, 201);
    await callAction('revokeMcpMembership', {
      accountId,
      agentId,
      now: now + 2,
    });

    const touched = await callAction<{ touched: boolean }>(
      'touchMcpGrant',
      { grantId: input.grantId, now: now + 3 },
    );
    assert.equal(touched.touched, false);

    const redemption = await callAction<{ error: string }>('redeemMcpCode', {
      codeId: input.codeId,
      grantId: input.grantId,
      authorizationRequestId: input.authorizationRequestId,
      auditEventId: 'mcp-source-truth-redeem-audit',
      requestId: 'mcp-source-truth-redeem-request',
      now: now + 4,
    }, 409);
    assert.match(redemption.error, /invalid_mcp_delegation_code/u);
  });

  test('durable grants and revocations enter backups without transient codes', async () => {
    const backup = await callAction<{
      schemaVersion: number;
      security: { containsPlaintextSecrets: boolean };
      tables: Record<string, Array<Record<string, unknown>>>;
      counts: Record<string, number>;
    }>('exportBackup', { now: Date.now(), includeSessions: false });

    assert.equal(backup.schemaVersion, BACKUP_SCHEMA_VERSION);
    assert.equal(backup.security.containsPlaintextSecrets, false);
    assert.ok(backup.tables.mcpAuthorizationGrants.length > 0);
    assert.ok(backup.tables.mcpAuthorizationRevocations.length > 0);
    assert.equal(
      backup.counts.mcpAuthorizationGrants,
      backup.tables.mcpAuthorizationGrants.length,
    );
    assert.equal(
      backup.counts.mcpAuthorizationRevocations,
      backup.tables.mcpAuthorizationRevocations.length,
    );
    assert.equal('mcpDelegationCodes' in backup.tables, false);
    assert.equal('mcpDelegationRedemptions' in backup.tables, false);
    assert.equal(JSON.stringify(backup).includes('orb_mcp_v1_'), false);
  });
});
