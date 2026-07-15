import type { OrbitBindings } from './server/identity/bindings';
import { handleApiRequest, runIdentityCleanup } from './server/http/api';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: OrbitBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'orbit-v6' });
    }
    if (url.pathname.startsWith('/v1/')) {
      return await handleApiRequest(request, env);
    }
    if (!env.ASSETS) return new Response('Not found', { status: 404 });
    return await env.ASSETS.fetch(request);
  },

  scheduled(_controller: unknown, env: OrbitBindings, ctx: ExecutionContextLike): void {
    ctx.waitUntil(runIdentityCleanup(env));
  },
};
