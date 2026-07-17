import type { OrbitBindings } from '../src/server/identity/bindings';
import { cleanupMedia } from '../src/server/media/media-service';
import { D1MediaRepository } from '../src/server/repositories/d1/d1-media-repository';

type CleanupBindings = OrbitBindings & { ORBIT_STAGING_CLEANUP_TOKEN: string };

export default {
  async fetch(request: Request, env: CleanupBindings): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== 'POST'
      || request.headers.get('x-orbit-cleanup-token') !== env.ORBIT_STAGING_CLEANUP_TOKEN
    ) {
      return new Response('Not found', { status: 404 });
    }
    if (pathname === '/count') {
      const listed = await env.MEDIA?.list();
      return Response.json({ ok: true, count: listed?.objects.length ?? 0 });
    }
    if (pathname !== '/cleanup') return new Response('Not found', { status: 404 });
    const result = await cleanupMedia(env, new D1MediaRepository(env.DB), Date.now());
    return Response.json({ ok: true, result });
  },
};
