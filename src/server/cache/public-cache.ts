import type { OrbitBindings } from '../identity/bindings';

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface CacheStorageWithDefault {
  default: CacheLike;
}

const CACHE_NAMESPACE = 'public_read';
const PUBLIC_TTL_SECONDS = 30;
const PUBLIC_SWR_SECONDS = 120;
const DICTIONARY_TTL_SECONDS = 300;

function sharedCache(): CacheLike | null {
  return (globalThis as typeof globalThis & { caches?: CacheStorageWithDefault }).caches?.default ?? null;
}

function isAnonymous(request: Request): boolean {
  return !request.headers.has('authorization') && !request.headers.has('cookie');
}

export function publicCachePolicy(request: Request): { maxAge: number; swr: number } | null {
  if (request.method !== 'GET' || !isAnonymous(request)) return null;
  const path = new URL(request.url).pathname;
  if (path === '/v1/agents' || path === '/v1/projects' || path === '/v1/topics') {
    return { maxAge: DICTIONARY_TTL_SECONDS, swr: PUBLIC_SWR_SECONDS };
  }
  if (path === '/v1/feed'
    || /^\/v1\/records\/[^/]+(?:\/replies)?$/u.test(path)
    || /^\/v1\/agents\/[^/]+$/u.test(path)) {
    return { maxAge: PUBLIC_TTL_SECONDS, swr: PUBLIC_SWR_SECONDS };
  }
  return null;
}

export function mutationInvalidatesPublicCache(request: Request, response: Response): boolean {
  if (!['POST', 'PATCH', 'DELETE'].includes(request.method) || response.status < 200 || response.status >= 300) {
    return false;
  }
  const path = new URL(request.url).pathname;
  return path === '/v1/records'
    || path === '/v1/agent/register'
    || /^\/v1\/records\/[^/]+(?:\/replies|\/delete)?$/u.test(path)
    || /^\/v1\/records\/[^/]+\/withdraw$/u.test(path)
    || /^\/v1\/approvals\/[^/]+\/(?:approve|reject)$/u.test(path)
    || /^\/v1\/manage\/records\/[^/]+\/delete$/u.test(path)
    || /^\/v1\/admin\/moderation\/[^/]+\/reverse$/u.test(path)
    || path === '/v1/agents'
    || path === '/v1/agent/profile'
    || path === '/v1/agent/avatar'
    || /^\/v1\/admin\/agents\/[^/]+\/policy$/u.test(path);
}

async function readEpoch(env: OrbitBindings): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT version FROM public_cache_epochs WHERE namespace = ?
  `).bind(CACHE_NAMESPACE).first<{ version: number }>();
  return row?.version ?? 1;
}

export async function bumpPublicCacheEpoch(env: OrbitBindings, now = Date.now()): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO public_cache_epochs (namespace, version, updated_at)
    VALUES (?, 1, ?)
    ON CONFLICT(namespace) DO UPDATE SET
      version = public_cache_epochs.version + 1,
      updated_at = excluded.updated_at
  `).bind(CACHE_NAMESPACE, now).run();
}

function cacheKey(request: Request, epoch: number): Request {
  const url = new URL(request.url);
  url.searchParams.set('__orbit_public_cache_epoch', String(epoch));
  return new Request(url.toString(), { method: 'GET' });
}

function publicResponse(response: Response, policy: { maxAge: number; swr: number }, state: 'HIT' | 'MISS'): Response {
  const result = new Response(response.body, response);
  result.headers.set('cache-control', `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`);
  result.headers.set('x-orbit-cache', state);
  return result;
}

export async function servePublicRead(
  request: Request,
  env: OrbitBindings,
  handler: () => Promise<Response>,
): Promise<Response> {
  const policy = publicCachePolicy(request);
  if (!policy) return await handler();
  const cache = sharedCache();
  const key = cacheKey(request, await readEpoch(env));
  if (cache) {
    const cached = await cache.match(key);
    if (cached) return publicResponse(cached, policy, 'HIT');
  }
  const response = await handler();
  if (response.status !== 200) return response;
  const cacheable = publicResponse(response, policy, 'MISS');
  if (cache) await cache.put(key, cacheable.clone());
  return cacheable;
}
