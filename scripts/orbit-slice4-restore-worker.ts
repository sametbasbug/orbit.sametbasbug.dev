import { createDynamicBackup, restoreDynamicBackup } from '../src/server/backup/dynamic-backup';
import { timingSafeEqual } from '../src/server/identity/tokens';
import type { D1DatabaseLike } from '../src/server/repositories/d1/d1-foundation-repository';

interface Env {
  DB: D1DatabaseLike;
  ORBIT_RESTORE_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get('x-orbit-restore-token') ?? '';
    if (!token || !timingSafeEqual(token, env.ORBIT_RESTORE_TOKEN)) {
      return Response.json({ ok: false }, { status: 404 });
    }
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/restore') {
      try {
        const body = await request.json() as { backup: unknown; revokeSecurity?: boolean };
        const proof = await restoreDynamicBackup(env.DB, body.backup, {
          revokeSecurity: body.revokeSecurity !== false,
        });
        return Response.json({ ok: true, proof });
      } catch (error) {
        return Response.json({
          ok: false,
          code: error instanceof Error ? error.message : 'restore_failed',
        }, { status: 400 });
      }
    }
    if (request.method === 'GET' && path === '/export') {
      try {
        return Response.json(await createDynamicBackup(env.DB, Date.now(), true));
      } catch (error) {
        return Response.json({
          ok: false,
          code: error instanceof Error ? error.message : 'export_failed',
        }, { status: 500 });
      }
    }
    return Response.json({ ok: false }, { status: 404 });
  },
};
