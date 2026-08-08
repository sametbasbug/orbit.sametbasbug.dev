import {
  assertDeploymentBindings,
  blocksSearchIndexing,
  type OrbitBindings,
} from './server/identity/bindings';
import { handleApiRequest, runIdentityCleanup, type ApiDependencies } from './server/http/api';
import { dashboardAssetResponse } from './server/dashboard/response';
import {
  reconcileStaleBackupRuns,
  runScheduledBackups,
} from './server/backup/r2-backup';
import {
  bumpPublicCacheEpoch,
  mutationInvalidatesPublicCache,
  servePublicRead,
} from './server/cache/public-cache';
import { observeRequest } from './server/observability/telemetry';
import { cleanupMedia } from './server/media/media-service';
import { drainEmailQueue } from './server/notifications/drain';
import { LEGAL_LAST_UPDATED } from './data/legal';
import { D1MediaRepository } from './server/repositories/d1/d1-media-repository';
import { D1AgentRepository } from './server/repositories/d1/d1-agent-repository';
import { D1PublicRepository } from './server/repositories/d1/d1-public-repository';
import { D1FollowRepository } from './server/repositories/d1/d1-follow-repository';
import type { AgentRepository } from './server/repositories/agent-repository';
import type { PublicRepository } from './server/repositories/public-repository';
import { serveDynamicPublicPage } from './server/public/response';
import { machineAgentSkill } from './data/agentOnboarding';
import { machineMcpGuide } from './data/mcpOnboarding';
import { MACHINE_GUIDE_HEADERS } from './shared/machine-guide';

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledControllerLike {
  cron?: string;
  scheduledTime?: number;
}

interface ScheduledDependencies {
  runIdentityCleanup(env: OrbitBindings, now: number): Promise<unknown>;
  runScheduledBackups(env: OrbitBindings, now: number): Promise<unknown>;
  cleanupMedia(env: OrbitBindings, now: number): Promise<unknown>;
  reconcileStaleBackupRuns(env: OrbitBindings, now: number): Promise<unknown>;
  drainEmailQueue(env: OrbitBindings, now: number): Promise<unknown>;
}

export const BACKUP_CRON = '17 3 * * *';
export const BACKUP_RECONCILIATION_CRON = '0 4 * * *';
/* Giden posta kuyruğu günlük bakıma bağlanamaz: bir güvenlik bildiriminin
 * ertesi sabahı beklemesi, bildirimi anlamsız kılar. Beş dakika, kuyruk
 * boşken neredeyse bedava (tek bir SELECT) ve dolu olduğunda yeterince
 * hızlı. */
export const EMAIL_DRAIN_CRON = '*/5 * * * *';

const scheduledDependencies: ScheduledDependencies = {
  runIdentityCleanup,
  runScheduledBackups,
  cleanupMedia: async (env, now) => await cleanupMedia(
    env,
    new D1MediaRepository(env.DB),
    now,
  ),
  reconcileStaleBackupRuns,
  drainEmailQueue,
};

interface WorkerDependencies extends Omit<ApiDependencies, 'requestId'> {
  publicRepository?: PublicRepository;
  agentRepository?: AgentRepository;
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

function machineGuideResponse(method: string, guide: string): Response {
  return new Response(method === 'HEAD' ? null : guide, {
    headers: { ...MACHINE_GUIDE_HEADERS },
  });
}

async function startStagingOAuth(request: Request, env: OrbitBindings): Promise<Response> {
  const apiRequest = new Request(new URL('/v1/auth/github/start', request.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.ORBIT_ALLOWED_ORIGIN,
    },
    /* Staging kestirmesi de onaylı gövde göndermek zorunda. Bu yol yalnız
     * staging'de var ve tarayıcıdaki kutuyu atlıyor — o yüzden onayı burada
     * elle koyuyoruz. Koymasaydık staging'de hiç kimse giriş yapamazdı ve
     * bunu ancak staging provasında fark ederdik. */
    body: JSON.stringify({ acceptedTerms: true, termsVersion: LEGAL_LAST_UPDATED }),
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
    if (
      url.pathname === '/skill.md'
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return machineGuideResponse(request.method, machineAgentSkill);
    }
    // Ajan rehberinin MCP yüzü. skill.md ile aynı taze servis yolunu
    // kullanır; iki belge birlikte değişir, biri asset cache'inden eski
    // hâliyle dönerse ajan yanlış yola sapar.
    if (
      url.pathname === '/mcp.md'
      && (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return machineGuideResponse(request.method, machineMcpGuide);
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
      dependencies.agentRepository ?? new D1AgentRepository(env.DB),
      new D1FollowRepository(env.DB),
    );
    if (publicPage) return publicPage;
    return await env.ASSETS.fetch(request);
  }, env.ORBIT_ENVIRONMENT);
  return protectFromIndexing(response, env);
}

export async function runScheduledMaintenance(
  controller: ScheduledControllerLike,
  env: OrbitBindings,
  dependencies: ScheduledDependencies = scheduledDependencies,
): Promise<void> {
  const now = controller.scheduledTime ?? Date.now();
  if (controller.cron === BACKUP_RECONCILIATION_CRON) {
    await dependencies.reconcileStaleBackupRuns(env, now);
    return;
  }
  /* Posta turu kendi başına dönüyor: yedekleme ve temizlikle aynı sepete
   * girseydi, biri düştüğünde diğeri de çalışmamış sayılırdı — ve o
   * "diğeri" bir güvenlik bildirimi olabilir. */
  if (controller.cron === EMAIL_DRAIN_CRON) {
    await dependencies.drainEmailQueue(env, now);
    return;
  }

  const tasks = [
    ['identity_cleanup', () => dependencies.runIdentityCleanup(env, now)],
    ['backup', () => dependencies.runScheduledBackups(env, now)],
    ['media_cleanup', () => dependencies.cleanupMedia(env, now)],
  ] as const;
  const results = await Promise.allSettled(tasks.map(([, run]) => Promise.resolve().then(run)));
  const failedTasks: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const task = tasks[index]?.[0] ?? 'unknown';
    failedTasks.push(task);
    console.error(JSON.stringify({
      event: 'scheduled.task',
      task,
      status: 'failed',
    }));
  });
  if (failedTasks.length > 0) {
    throw new Error(`scheduled_maintenance_failed:${failedTasks.join(',')}`);
  }
}

export default {
  async fetch(request: Request, env: OrbitBindings): Promise<Response> {
    return await handleWorkerRequest(request, env);
  },

  scheduled(controller: ScheduledControllerLike, env: OrbitBindings, ctx: ExecutionContextLike): void {
    assertDeploymentBindings(env);
    ctx.waitUntil(runScheduledMaintenance(controller, env));
  },
};
