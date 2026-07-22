import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createEntityId, createRequestId, isUuidV7 } from '../src/server/foundation/ids';
import { createErrorEnvelope } from '../src/server/foundation/errors';
import { redactSecrets } from '../src/server/foundation/redaction';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = 'wrangler.test.jsonc';

let persistDirectory = '';
let baseUrl = '';
let worker: ChildProcessWithoutNullStreams | undefined;
let firstMigrationOutput = '';
let secondMigrationOutput = '';

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

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local test port.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
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

function registrationData(prefix: string, invitationId: string, githubUserId: string, now: number) {
  return {
    invitationId,
    githubIdentityId: `${prefix}-identity`,
    githubUserId,
    githubLogin: `${prefix}-login`,
    accountId: `${prefix}-account`,
    handle: `${prefix}-handle`,
    displayName: `${prefix} display`,
    sessionId: `${prefix}-session`,
    sessionDigest: `${prefix}-session-digest`,
    csrfDigest: `${prefix}-csrf-digest`,
    auditEventId: `${prefix}-audit`,
    requestId: `${prefix}-request`,
    now,
  };
}

before(async () => {
  persistDirectory = await mkdtemp(path.join(tmpdir(), 'orbit-v6-d1-'));
  firstMigrationOutput = runMigrations();
  secondMigrationOutput = runMigrations();

  const port = await availablePort();
  let inspectorPort = await availablePort();
  while (inspectorPort === port) inspectorPort = await availablePort();
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

describe('Orbit V6 Slice 0 local-D1 foundation', { concurrency: false }, () => {
  test('all forward migrations apply from an empty database and safely re-run', async () => {
    for (const migration of [
      '0001_identity.sql',
      '0002_agents.sql',
      '0003_content.sql',
      '0004_reliability_audit.sql',
      '0005_slice1_identity.sql',
    ]) {
      assert.match(firstMigrationOutput, new RegExp(migration.replace('.', '\\.')));
    }
    assert.match(firstMigrationOutput, /executed successfully/i);
    assert.match(secondMigrationOutput, /No migrations to apply/i);

    const check = await callAction<{ rows: unknown[] }>('foreignKeyCheck');
    assert.deepEqual(check.rows, []);
  });

  test('invitation redemption rolls the entire registration back on late validation failure', async () => {
    const now = Date.now();
    const invitationId = 'invite-rollback';
    await callAction('seedInvitation', {
      ownerId: 'owner-rollback',
      invitationId,
      expectedGithubUserId: 'github-expected',
      now,
    });
    const registration = registrationData('rollback', invitationId, 'github-mismatch', now + 1);

    await callAction('redeemInvitation', registration, 409);
    const state = await callAction<{
      accountCount: number;
      sessionCount: number;
      redemptionCount: number;
      auditCount: number;
    }>('registrationState', registration);

    assert.deepEqual(state, {
      accountCount: 0,
      sessionCount: 0,
      redemptionCount: 0,
      auditCount: 0,
    });
  });

  test('a second redemption of the same invitation is rejected without orphan writes', async () => {
    const now = Date.now();
    const invitationId = 'invite-single-use';
    await callAction('seedInvitation', {
      ownerId: 'owner-single-use',
      invitationId,
      now,
    });

    const first = registrationData('first-use', invitationId, 'github-first', now + 1);
    const firstResult = await callAction<{
      accountCount: number;
      sessionCount: number;
      redemptionCount: number;
      auditCount: number;
      metrics: { batches: number; statements: number };
    }>('redeemInvitation', first);
    assert.equal(firstResult.accountCount, 1);
    assert.equal(firstResult.sessionCount, 1);
    assert.equal(firstResult.redemptionCount, 1);
    assert.equal(firstResult.auditCount, 1);
    assert.deepEqual(firstResult.metrics, {
      batches: 1,
      statements: 7,
      operations: { 'invitation.redeem': 7 },
    });

    const second = registrationData('second-use', invitationId, 'github-second', now + 2);
    await callAction('redeemInvitation', second, 409);
    const secondState = await callAction<{
      accountCount: number;
      sessionCount: number;
      redemptionCount: number;
      auditCount: number;
    }>('registrationState', second);
    assert.deepEqual(secondState, {
      accountCount: 0,
      sessionCount: 0,
      redemptionCount: 1,
      auditCount: 0,
    });
  });

  test('API credential rotation is atomic on late failure, success and stale retry', async () => {
    const now = Date.now();
    const seed = {
      sponsorId: 'rotation-sponsor',
      agentId: 'rotation-agent',
      credentialId: 'credential-old',
      credentialDigest: 'digest-old',
      now,
    };
    await callAction('seedAgent', seed);
    await callAction('seedAudit', {
      auditEventId: 'rotation-audit-collision',
      requestId: 'rotation-seed-request',
      now,
    });

    const failedRotation = {
      agentId: seed.agentId,
      expectedCredentialId: seed.credentialId,
      replacementCredentialId: 'credential-rolled-back',
      replacementDigest: 'digest-rolled-back',
      sponsorId: seed.sponsorId,
      auditEventId: 'rotation-audit-collision',
      requestId: 'rotation-failure-request',
      now: now + 1,
    };
    await callAction('rotateCredential', failedRotation, 409);
    const afterFailure = await callAction<{ rows: Array<{
      id: string;
      revoked_at: number | null;
      replaced_by_credential_id: string | null;
    }> }>('credentialState', { agentId: seed.agentId });
    assert.deepEqual(afterFailure.rows, [{
      id: seed.credentialId,
      revoked_at: null,
      replaced_by_credential_id: null,
    }]);

    const successfulRotation = {
      ...failedRotation,
      replacementCredentialId: 'credential-new',
      replacementDigest: 'digest-new',
      auditEventId: 'rotation-audit-success',
      requestId: 'rotation-success-request',
      now: now + 2,
    };
    const afterSuccess = await callAction<{
      rows: Array<{ id: string; revoked_at: number | null; replaced_by_credential_id: string | null }>;
      metrics: { batches: number; statements: number };
    }>('rotateCredential', successfulRotation);
    assert.equal(afterSuccess.metrics.batches, 1);
    assert.equal(afterSuccess.metrics.statements, 4);
    assert.deepEqual(afterSuccess.rows, [
      {
        id: seed.credentialId,
        revoked_at: now + 2,
        replaced_by_credential_id: 'credential-new',
      },
      {
        id: 'credential-new',
        revoked_at: null,
        replaced_by_credential_id: null,
      },
    ]);

    await callAction('rotateCredential', {
      ...successfulRotation,
      replacementCredentialId: 'credential-stale',
      replacementDigest: 'digest-stale',
      auditEventId: 'rotation-audit-stale',
      requestId: 'rotation-stale-request',
      now: now + 3,
    }, 409);
    const afterStale = await callAction<{ rows: Array<{ id: string; revoked_at: number | null }> }>(
      'credentialState',
      { agentId: seed.agentId },
    );
    assert.equal(afterStale.rows.length, 2);
    assert.equal(afterStale.rows.filter((row) => row.revoked_at === null).length, 1);
    assert.equal(afterStale.rows.find((row) => row.revoked_at === null)?.id, 'credential-new');
  });

  test('records cannot point at a revision owned by another record', async () => {
    const now = Date.now();
    const data = {
      sponsorId: 'record-sponsor',
      agentId: 'record-agent',
      record_one: 'record-one',
      revision_one: 'revision-one',
      record_two: 'record-two',
      revision_two: 'revision-two',
      now,
    };
    const seeded = await callAction<{ metrics: { batches: number; statements: number } }>(
      'seedRecordPair',
      data,
    );
    assert.equal(seeded.metrics.batches, 2);
    assert.equal(seeded.metrics.statements, 6);

    await callAction('setCurrentRevision', {
      recordId: data.record_one,
      revisionId: data.revision_two,
      now: now + 1,
    }, 409);
    const state = await callAction<{ row: { current_revision_id: string } }>('recordState', {
      recordId: data.record_one,
    });
    assert.equal(state.row.current_revision_id, data.revision_one);
    const check = await callAction<{ rows: unknown[] }>('foreignKeyCheck');
    assert.deepEqual(check.rows, []);
  });

  test('audit events reject both update and delete mutations', async () => {
    const auditEventId = 'audit-append-only';
    await callAction('seedAudit', {
      auditEventId,
      requestId: 'audit-append-only-request',
      now: Date.now(),
    });
    await callAction('mutateAudit', { auditEventId, mutation: 'update' }, 409);
    await callAction('mutateAudit', { auditEventId, mutation: 'delete' }, 409);
    const state = await callAction<{ row: { id: string; event_type: string; metadata_json: string } }>(
      'auditState',
      { auditEventId },
    );
    assert.deepEqual(state.row, {
      id: auditEventId,
      event_type: 'test.seed',
      metadata_json: '{}',
    });
  });

  test('UUIDv7 IDs validate and preserve generation order', () => {
    const ids = Array.from({ length: 100 }, () => createEntityId());
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every(isUuidV7));
    assert.deepEqual([...ids].sort(), ids);
    assert.match(createRequestId(), /^req_[0-9a-f-]{36}$/);
  });

  test('error envelopes expose the stable request ID', () => {
    assert.deepEqual(
      createErrorEnvelope('invalid_invitation', 'The invitation is not valid.', 'req_test'),
      {
        error: {
          code: 'invalid_invitation',
          message: 'The invitation is not valid.',
          requestId: 'req_test',
          details: {},
        },
      },
    );
  });

  test('secret redaction removes credential-shaped values and sensitive keys', () => {
    assert.deepEqual(
      redactSecrets({
        authorization: 'Bearer orb_agent_v1_selector_supersecret',
        nested: {
          message: 'received orb_inv_v1_selector_invitationsecret',
          safe: 'visible',
        },
      }),
      {
        authorization: '[REDACTED]',
        nested: {
          message: 'received [REDACTED]',
          safe: 'visible',
        },
      },
    );
  });
});
