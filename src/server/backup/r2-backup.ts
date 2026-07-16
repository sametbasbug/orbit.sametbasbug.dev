import { createEntityId } from '../foundation/ids';
import { canonicalJson } from '../publication/content';
import { sha256Base64Url } from '../identity/tokens';
import type { OrbitBindings, R2BucketLike } from '../identity/bindings';
import { D1PlatformRepository } from '../repositories/d1/d1-platform-repository';
import {
  CHUNKED_BACKUP_VERSION,
  createChunkedBackup,
  decryptChunkedBackup,
  encryptChunkedBackup,
  importBackupEncryptionKey,
} from './chunked-backup';

type BackupKind = 'daily' | 'weekly' | 'monthly' | 'manual';

const RETENTION: Record<Exclude<BackupKind, 'manual'>, number> = {
  daily: 14,
  weekly: 8,
  monthly: 6,
};

function requireBackupBindings(env: OrbitBindings): { bucket: R2BucketLike; encryptionKey: string } {
  if (!env.BACKUPS || !env.ORBIT_BACKUP_ENCRYPTION_KEY_V1) {
    throw new Error('backup_bindings_missing');
  }
  return { bucket: env.BACKUPS, encryptionKey: env.ORBIT_BACKUP_ENCRYPTION_KEY_V1 };
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown';
  return /^[a-z0-9_:-]{1,160}$/iu.test(message) ? message : 'backup_failed';
}

function objectKey(kind: BackupKind, now: number, runId: string): string {
  const timestamp = new Date(now).toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `orbit-v6/${kind}/${timestamp}-${runId}.json.enc`;
}

async function allObjects(bucket: R2BucketLike, prefix: string) {
  const objects = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function enforceBackupRetention(bucket: R2BucketLike): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const [kind, keep] of Object.entries(RETENTION) as Array<[keyof typeof RETENTION, number]>) {
    const objects = await allObjects(bucket, `orbit-v6/${kind}/`);
    const stale = objects.sort((a, b) => b.key.localeCompare(a.key)).slice(keep);
    if (stale.length) await bucket.delete(stale.map((item) => item.key));
    deleted[kind] = stale.length;
  }
  return deleted;
}

export async function runR2Backup(
  env: OrbitBindings,
  kind: BackupKind,
  now = Date.now(),
  actorAccountId: string | null = null,
): Promise<{ runId: string; objectKey: string; manifestChecksum: string; objectChecksum: string }> {
  const repository = new D1PlatformRepository(env.DB);
  const runId = createEntityId();
  await repository.startBackupRun({ id: runId, kind, actorAccountId, now });
  try {
    const { bucket, encryptionKey } = requireBackupBindings(env);
    const key = await importBackupEncryptionKey(encryptionKey);
    const bundle = await createChunkedBackup(env.DB, now, true);
    const envelope = await encryptChunkedBackup(bundle, key);
    const serialized = canonicalJson(envelope);
    const storedChecksum = await sha256Base64Url(serialized);
    const keyName = objectKey(kind, now, runId);
    await bucket.put(keyName, serialized, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        backupKind: kind,
        createdAt: new Date(now).toISOString(),
        schemaVersion: String(CHUNKED_BACKUP_VERSION),
        objectChecksum: storedChecksum,
      },
    });
    const stored = await bucket.get(keyName);
    if (!stored) throw new Error('backup_r2_readback_missing');
    const readback = await stored.text();
    if (await sha256Base64Url(readback) !== storedChecksum) throw new Error('backup_r2_readback_checksum_failed');
    const verified = await decryptChunkedBackup(JSON.parse(readback), key);
    if (verified.manifest.checksum.value !== bundle.manifest.checksum.value) {
      throw new Error('backup_r2_manifest_mismatch');
    }
    await repository.finishBackupRun({
      id: runId,
      objectKey: keyName,
      manifestChecksum: bundle.manifest.checksum.value,
      schemaVersion: bundle.manifest.schemaVersion,
      counts: bundle.manifest.counts,
      now: Date.now(),
    });
    return {
      runId,
      objectKey: keyName,
      manifestChecksum: bundle.manifest.checksum.value,
      objectChecksum: storedChecksum,
    };
  } catch (error) {
    await repository.failBackupRun({ id: runId, errorCode: safeErrorCode(error), now: Date.now() });
    throw error;
  }
}

export async function runScheduledBackups(env: OrbitBindings, now = Date.now()): Promise<void> {
  const date = new Date(now);
  const kinds: BackupKind[] = ['daily'];
  if (date.getUTCDay() === 1) kinds.push('weekly');
  if (date.getUTCDate() === 1) kinds.push('monthly');
  for (const kind of kinds) await runR2Backup(env, kind, now);
  const { bucket } = requireBackupBindings(env);
  await enforceBackupRetention(bucket);
}
