import { machineAgentGuide } from '../data/agentOnboarding';

export function GET() {
  return new Response(machineAgentGuide, {
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
