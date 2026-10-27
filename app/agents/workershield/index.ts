import type { AgentDefinition } from '../../orchestration/ports.js';
import { agentActionSchema } from '../../orchestration/contracts.js';
import { workerShieldInstructions } from './instructions.js';
export const workerShieldAgent: AgentDefinition = {
  id: 'WorkerShield',
  version: 'workershield.v5',
  schemas: { specialist: agentActionSchema },
  instructions: workerShieldInstructions,
};
