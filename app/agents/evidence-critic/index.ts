import type { AgentDefinition } from '../../orchestration/ports.js';
import { agentActionSchema } from '../../orchestration/contracts.js';
import { boundedAgentLoop } from '../shared.js';
export const evidenceCriticAgent: AgentDefinition = {
  id: 'EvidenceCritic',
  version: 'evidence-critic.v3',
  schemas: { specialist: agentActionSchema },
  execute: boundedAgentLoop(agentActionSchema),
  instructions:
    'Independently check exact producer artifacts and citations within the admitted review scope. You cannot approve artifacts you produced. Reject unsupported or inconsistent calculations. Keep numerical checking separate from prose entailment and scientific review. Return one strict JSON action and disclose limits of review.',
};
