import { createRequestId } from '../foundation/ids';

function routeName(path: string): string {
  const routes: Array<[RegExp, string]> = [
    [/^\/v1\/records\/[^/]+\/replies$/u, '/v1/records/:record/replies'],
    [/^\/v1\/records\/[^/]+\/(?:withdraw|delete)$/u, '/v1/records/:record/:action'],
    [/^\/v1\/records\/[^/]+$/u, '/v1/records/:record'],
    [/^\/v1\/agents\/[^/]+\/credentials\/(?:rotate|revoke)$/u, '/v1/agents/:agent/credentials/:action'],
    [/^\/v1\/agents\/[^/]+(?:\/manage)?$/u, '/v1/agents/:agent'],
    [/^\/v1\/approvals\/[^/]+(?:\/(?:approve|reject))?$/u, '/v1/approvals/:review/:action'],
    [/^\/v1\/sessions\/[^/]+\/revoke$/u, '/v1/sessions/:session/revoke'],
    [/^\/v1\/announcements\/[^/]+\/read$/u, '/v1/announcements/:announcement/read'],
    [/^\/v1\/admin\/announcements\/[^/]+\/(?:publish|withdraw)$/u, '/v1/admin/announcements/:announcement/:action'],
    [/^\/v1\/admin\/invitations\/[^/]+\/revoke$/u, '/v1/admin/invitations/:invitation/revoke'],
    [/^\/v1\/admin\/moderation\/[^/]+\/reverse$/u, '/v1/admin/moderation/:action/reverse'],
    [/^\/v1\/admin\/agents\/[^/]+\/policy$/u, '/v1/admin/agents/:agent/policy'],
    [/^\/v1\/[a-z0-9/_-]+$/u, path],
    [/^\/dashboard\/?$/u, '/dashboard'],
    [/^\/healthz$/u, '/healthz'],
    [/^\/__staging\/oauth$/u, '/__staging/oauth'],
  ];
  return routes.find(([pattern]) => pattern.test(path))?.[1] ?? 'static_asset';
}

function actorType(request: Request): 'agent' | 'account' | 'anonymous' {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) return 'agent';
  if (request.headers.has('cookie')) return 'account';
  return 'anonymous';
}

export async function observeRequest(
  request: Request,
  handler: (requestId: string) => Promise<Response>,
  environment: 'local' | 'test' | 'staging' | 'production' = 'local',
): Promise<Response> {
  const requestId = createRequestId();
  const started = performance.now();
  let response: Response;
  try {
    response = await handler(requestId);
  } catch (error) {
    response = Response.json({ error: { code: 'internal_error', message: 'An internal error occurred.', requestId } }, {
      status: 500,
      headers: { 'cache-control': 'no-store' },
    });
    console.error(JSON.stringify({
      event: 'worker.unhandled_error', requestId, route: routeName(new URL(request.url).pathname),
      status: 500, durationMs: Math.round(performance.now() - started), actorType: actorType(request),
      authCategory: 'unknown', quotaResult: 'not_checked', errorClass: error instanceof Error ? error.name : 'UnknownError',
    }));
  }
  const result = new Response(response.body, response);
  result.headers.set('x-request-id', requestId);
  const status = result.status;
  const actor = actorType(request);
  const sampledOut = environment === 'production'
    && status < 400
    && actor === 'anonymous'
    && requestId.charCodeAt(requestId.length - 1) % 10 !== 0;
  if (!sampledOut) {
    console.log(JSON.stringify({
      event: 'worker.request', requestId, route: routeName(new URL(request.url).pathname), status,
      durationMs: Math.round(performance.now() - started), actorType: actor,
      authCategory: status === 401 ? 'rejected_unauthorized' : status === 403 ? 'rejected_forbidden' : status < 400 ? 'accepted_or_not_required' : 'not_applicable',
      quotaResult: status === 429 ? 'rejected' : 'not_rejected',
      errorClass: status >= 500 ? 'server_error' : null,
    }));
  }
  return result;
}
