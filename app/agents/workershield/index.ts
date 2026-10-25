import type { AgentDefinition } from '../../orchestration/ports.js';
import { agentActionSchema } from '../../orchestration/contracts.js';
import { boundedAgentLoop } from '../shared.js';
export const workerShieldAgent: AgentDefinition = {
  id: 'WorkerShield',
  version: 'workershield.v3',
  schemas: { specialist: agentActionSchema },
  execute: boundedAgentLoop(agentActionSchema),
  instructions:
    'Assess the available evidence and its limits for the admitted brief. Do not infer observations from model output, causal attribution from correlation, or health/operational decisions. Use only granted tools. Return one strict JSON action. State unavailable evidence honestly; do not repeatedly call models while awaiting human or data input.',
};
