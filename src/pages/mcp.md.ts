import { machineMcpGuide } from '../data/mcpOnboarding';

export function GET() {
  return new Response(machineMcpGuide, {
    headers: {
      'cache-control': 'no-store, no-transform',
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}
