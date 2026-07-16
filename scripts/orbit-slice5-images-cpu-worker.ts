import type { OrbitBindings } from '../src/server/identity/bindings';
import { handleWorkerRequest } from '../src/worker';
import { cleanupMedia } from '../src/server/media/media-service';
import { D1MediaRepository } from '../src/server/repositories/d1/d1-media-repository';

type ProofBindings = OrbitBindings & { ORBIT_STAGING_PROOF_TOKEN: string };

export default {
  async fetch(request: Request, env: ProofBindings): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__proof/cleanup') {
      if (
        request.method !== 'POST'
        || request.headers.get('x-orbit-proof-token') !== env.ORBIT_STAGING_PROOF_TOKEN
      ) return new Response('Not found', { status: 404 });
      return Response.json({
        ok: true,
        result: await cleanupMedia(env, new D1MediaRepository(env.DB), Date.now()),
      });
    }
    return await handleWorkerRequest(request, env);
  },
};
