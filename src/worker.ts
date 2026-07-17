import type { OrbitBindings } from './server/identity/bindings';
import { handleApiRequest, runIdentityCleanup, type ApiDependencies } from './server/http/api';
import { dashboardResponse } from './server/dashboard/html';
import { runScheduledBackups } from './server/backup/r2-backup';
import {
  bumpPublicCacheEpoch,
  mutationInvalidatesPublicCache,
  servePublicRead,
} from './server/cache/public-cache';
import { observeRequest } from './server/observability/telemetry';
import { cleanupMedia } from './server/media/media-service';
import { D1MediaRepository } from './server/repositories/d1/d1-media-repository';

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

export async function handleWorkerRequest(
  request: Request,
  env: OrbitBindings,
  dependencies: Omit<ApiDependencies, 'requestId'> = {},
): Promise<Response> {
    return await observeRequest(request, async (requestId) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return protectStagingFromIndexing(
        Response.json({ ok: true, service: 'orbit-v6', environment: env.ORBIT_ENVIRONMENT }),
        env,
      );
    }
    if (url.pathname.startsWith('/v1/')) {
      const response = await servePublicRead(request, env, async () => {
        const testNow = env.ORBIT_ENVIRONMENT === 'test'
          ? request.headers.get('x-test-now')
          : null;
        return await handleApiRequest(request, env, {
          ...dependencies,
          requestId,
          now: dependencies.now ?? (testNow ? () => Number(testNow) : undefined),
        });
      });
      if (mutationInvalidatesPublicCache(request, response)) {
        await bumpPublicCacheEpoch(env);
      }
      return protectStagingFromIndexing(response, env);
    }
    if ((url.pathname === '/dashboard' || url.pathname === '/dashboard/') && request.method === 'GET') {
      return protectStagingFromIndexing(dashboardResponse(), env);
    }
    if (env.ORBIT_ENVIRONMENT === 'staging' && url.pathname === '/__staging/oauth') {
      return protectStagingFromIndexing(await startStagingOAuth(request, env), env);
    }
    if (!env.ASSETS) {
      return protectStagingFromIndexing(new Response('Not found', { status: 404 }), env);
    }
    return protectStagingFromIndexing(await env.ASSETS.fetch(request), env);
    }, env.ORBIT_ENVIRONMENT);
}

export default {
  async fetch(request: Request, env: OrbitBindings): Promise<Response> {
    return await handleWorkerRequest(request, env);
  },

  scheduled(_controller: unknown, env: OrbitBindings, ctx: ExecutionContextLike): void {
    ctx.waitUntil(Promise.all([
      runIdentityCleanup(env),
      runScheduledBackups(env),
      cleanupMedia(env, new D1MediaRepository(env.DB)),
    ]));
  },
};
