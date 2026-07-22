import {
  assertDeploymentBindings,
  blocksSearchIndexing,
  type OrbitBindings,
} from './server/identity/bindings';
import { handleApiRequest, runIdentityCleanup, type ApiDependencies } from './server/http/api';
import { dashboardAssetResponse } from './server/dashboard/response';
import { runScheduledBackups } from './server/backup/r2-backup';
import {
  bumpPublicCacheEpoch,
  mutationInvalidatesPublicCache,
  servePublicRead,
} from './server/cache/public-cache';
import { observeRequest } from './server/observability/telemetry';
import { cleanupMedia } from './server/media/media-service';
import { D1MediaRepository } from './server/repositories/d1/d1-media-repository';
import { D1PublicRepository } from './server/repositories/d1/d1-public-repository';
import type { PublicRepository } from './server/repositories/public-repository';
import { serveDynamicPublicPage } from './server/public/response';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerDependencies extends Omit<ApiDependencies, 'requestId'> {
  publicRepository?: PublicRepository;
}

function protectFromIndexing(response: Response, env: OrbitBindings): Response {
  if (!blocksSearchIndexing(env)) return response;
  const protectedResponse = new Response(response.body, response);
  protectedResponse.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return protectedResponse;
}

function denyAllRobots(): Response {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function preserveMachineGuideEncoding(request: Request, response: Response): Response {
  if (new URL(request.url).pathname !== '/skill.md') return response;
  const encodedResponse = new Response(response.body, response);
  encodedResponse.headers.set('content-type', 'text/markdown; charset=utf-8');
  return encodedResponse;
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
  dependencies: WorkerDependencies = {},
): Promise<Response> {
  const response = await observeRequest(request, async (requestId) => {
    assertDeploymentBindings(env);
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt' && blocksSearchIndexing(env)) {
      return denyAllRobots();
    }
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'orbit-v6', environment: env.ORBIT_ENVIRONMENT });
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
      return response;
    }
    if (
      (url.pathname === '/dashboard' || url.pathname === '/dashboard/')
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      if (!env.ASSETS) return new Response('Not found', { status: 404 });
      return await dashboardAssetResponse(request, env.ASSETS);
    }
    if (env.ORBIT_ENVIRONMENT === 'staging' && url.pathname === '/__staging/oauth') {
      return await startStagingOAuth(request, env);
    }
    if (!env.ASSETS) {
      return new Response('Not found', { status: 404 });
    }
    const publicPage = await serveDynamicPublicPage(
      request,
      env.ASSETS,
      dependencies.publicRepository ?? new D1PublicRepository(env.DB),
    );
    if (publicPage) return publicPage;
    return preserveMachineGuideEncoding(request, await env.ASSETS.fetch(request));
  }, env.ORBIT_ENVIRONMENT);
  return protectFromIndexing(response, env);
}

export default {
  async fetch(request: Request, env: OrbitBindings): Promise<Response> {
    return await handleWorkerRequest(request, env);
  },

  scheduled(_controller: unknown, env: OrbitBindings, ctx: ExecutionContextLike): void {
    assertDeploymentBindings(env);
    ctx.waitUntil(Promise.all([
      runIdentityCleanup(env),
      runScheduledBackups(env),
      cleanupMedia(env, new D1MediaRepository(env.DB)),
    ]));
  },
};
