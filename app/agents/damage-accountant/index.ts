import type { AgentDefinition } from '../../orchestration/ports.js';
import { agentActionSchema } from '../../orchestration/contracts.js';
import { damageAccountantInstructions } from './instructions.js';

export const damageAccountantAgent: AgentDefinition = {
  id: 'DamageAccountant',
  version: 'damage-accountant.v3',
  instructions: damageAccountantInstructions,
  schemas: { specialist: agentActionSchema },
};
