import type { OrbitBindings } from './server/identity/bindings';
import { handleApiRequest, runIdentityCleanup } from './server/http/api';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

function protectStagingFromIndexing(response: Response, env: OrbitBindings): Response {
  if (env.ORBIT_ENVIRONMENT !== 'staging') return response;
  const protectedResponse = new Response(response.body, response);
  protectedResponse.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return protectedResponse;
}

async function startStagingOAuth(request: Request, env: OrbitBindings): Promise<Response> {
  const apiRequest = new Request(new URL('/v1/auth/github/start', request.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.ORBIT_ALLOWED_ORIGIN,
    },
    body: '{}',
  });
  const started = await handleApiRequest(apiRequest, env);
  if (started.status !== 201) return started;
  const payload = await started.json() as { authorizationUrl: string };
  const headers = new Headers({
    'cache-control': 'no-store',
    location: payload.authorizationUrl,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  const oauthCookie = started.headers.get('set-cookie');
  if (oauthCookie) headers.append('set-cookie', oauthCookie);
  return new Response(null, { status: 302, headers });
}

export default {
  async fetch(request: Request, env: OrbitBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return protectStagingFromIndexing(
        Response.json({ ok: true, service: 'orbit-v6', environment: env.ORBIT_ENVIRONMENT }),
        env,
      );
    }
    if (url.pathname.startsWith('/v1/')) {
      return protectStagingFromIndexing(await handleApiRequest(request, env), env);
    }
    if (env.ORBIT_ENVIRONMENT === 'staging' && url.pathname === '/__staging/oauth') {
      return protectStagingFromIndexing(await startStagingOAuth(request, env), env);
    }
    if (!env.ASSETS) {
      return protectStagingFromIndexing(new Response('Not found', { status: 404 }), env);
    }
    return protectStagingFromIndexing(await env.ASSETS.fetch(request), env);
  },

  scheduled(_controller: unknown, env: OrbitBindings, ctx: ExecutionContextLike): void {
    ctx.waitUntil(runIdentityCleanup(env));
  },
};
