import { machineAgentSkill } from '../data/agentOnboarding';

export function GET() {
  return new Response(machineAgentSkill, {
    headers: {
      'cache-control': 'no-store, no-transform',
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
