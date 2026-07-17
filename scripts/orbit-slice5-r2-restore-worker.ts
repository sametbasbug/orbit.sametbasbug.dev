import type { D1DatabaseLike } from '../src/server/repositories/d1/d1-foundation-repository';
import type { R2BucketLike } from '../src/server/identity/bindings';
import {
  decryptChunkedBackup,
  importBackupEncryptionKey,
  restoreChunkedBackup,
} from '../src/server/backup/chunked-backup';

interface Env {
  DB: D1DatabaseLike;
  BACKUPS: R2BucketLike;
  ORBIT_RESTORE_TOKEN: string;
  ORBIT_BACKUP_ENCRYPTION_KEY_V1: string;
}

async function latestManual(bucket: R2BucketLike): Promise<string | null> {
  const page = await bucket.list({ prefix: 'orbit-v6/manual/', limit: 1000 });
  return page.objects.map((item) => item.key).sort((a, b) => b.localeCompare(a))[0] ?? null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('x-orbit-restore-token') !== env.ORBIT_RESTORE_TOKEN) {
      return Response.json({ code: 'forbidden' }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/healthz') return Response.json({ ok: true });
    if (request.method !== 'POST' || path !== '/restore-latest-manual') {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    try {
      const objectKey = await latestManual(env.BACKUPS);
      if (!objectKey) return Response.json({ code: 'manual_backup_missing' }, { status: 404 });
      const object = await env.BACKUPS.get(objectKey);
      if (!object) return Response.json({ code: 'manual_backup_missing' }, { status: 404 });
      const key = await importBackupEncryptionKey(env.ORBIT_BACKUP_ENCRYPTION_KEY_V1);
      const bundle = await decryptChunkedBackup(JSON.parse(await object.text()), key);
      const proof = await restoreChunkedBackup(env.DB, bundle, { revokeSecurity: true });
      return Response.json({
        ok: true,
        format: bundle.manifest.schema,
        counts: proof.counts,
        foreignKeyViolations: proof.foreignKeyViolations,
        uniqueViolations: proof.uniqueViolations,
        relationshipViolations: proof.relationshipViolations,
        restoreInputBytes: proof.restoreInputBytes,
        restoreStatements: proof.restoreStatements,
        securityRevocation: 'applied',
        source: 'private-r2-latest-manual',
      });
    } catch (error) {
      return Response.json({
        code: error instanceof Error && /^[a-z0-9_:-]+$/iu.test(error.message)
          ? error.message
          : 'restore_failed',
      }, { status: 400 });
    }
  },
};
