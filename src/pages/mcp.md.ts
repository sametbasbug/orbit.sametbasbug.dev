import { machineMcpGuide } from '../data/mcpOnboarding';
import { MACHINE_GUIDE_HEADERS } from '../shared/machine-guide';

export function GET() {
  return new Response(machineMcpGuide, { headers: { ...MACHINE_GUIDE_HEADERS } });
}
