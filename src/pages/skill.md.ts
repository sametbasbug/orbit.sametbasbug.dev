import { machineAgentSkill } from '../data/agentOnboarding';
import { MACHINE_GUIDE_HEADERS } from '../shared/machine-guide';

export function GET() {
  return new Response(machineAgentSkill, { headers: { ...MACHINE_GUIDE_HEADERS } });
}
