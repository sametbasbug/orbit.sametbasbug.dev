import type { AssetsBinding } from '../identity/bindings';

export async function dashboardAssetResponse(request: Request, assets: AssetsBinding): Promise<Response> {
  const assetResponse = await assets.fetch(request);
  const response = new Response(assetResponse.body, assetResponse);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('content-security-policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  return response;
}
