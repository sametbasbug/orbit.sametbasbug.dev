import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestWorker, type TestWorker } from './support/d1-test-worker-harness';
import { createEntityId, createRequestId, isUuidV7 } from '../src/server/foundation/ids';
import { createErrorEnvelope } from '../src/server/foundation/errors';
import { redactSecrets } from '../src/server/foundation/redaction';

let harness: TestWorker | undefined;
let firstMigrationOutput = '';
let secondMigrationOutput = '';

const callAction = async <T>(
  action: string,
  data: Record<string, unknown> = {},
  expectedStatus = 200,
): Promise<T> => {
  if (!harness) throw new Error('Test worker is not running.');
  return await harness.callAction<T>(action, data, expectedStatus);
};

before(async () => {
  harness = await startTestWorker();
  [firstMigrationOutput, secondMigrationOutput] = harness.migrationOutputs;
});

after(async () => {
  await harness?.stop();
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

  /* Buradaki iki test davet kullanımının atomikliğini ölçüyordu. Davet
     sistemi emekliye ayrıldı ve ölçtükleri özellik — bir batch'in geç
     düşen bir kısıtta tamamen geri sarması — aşağıdaki kimlik bilgisi
     döndürme testinde aynen duruyor. Ölü bir yolu yeşil tutan test,
     hiçbir şey ölçmeyen testtir. */
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
      createErrorEnvelope('terms_not_accepted', 'Terms were not accepted.', 'req_test'),
      {
        error: {
          code: 'terms_not_accepted',
          message: 'Terms were not accepted.',
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
          message: 'received orb_sess_v1_selector_sessionsecret',
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
