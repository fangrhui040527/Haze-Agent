import type { AgentDefinition } from '../../orchestration/ports.js';
import { z } from 'zod';
import { managerPlanSchema } from '../../orchestration/contracts.js';
import { managerDecisionSchema } from '../../contracts/manager.js';
import { decide } from './decision.js';
import { managerInstructions } from './instructions.js';
import { assembleManagerContext } from './context.js';
import { fixtureDecision } from './fixture.js';
export { decide } from './decision.js';
export { assembleManagerContext } from './context.js';
export type { ManagerContext } from './context.js';
const synthesisSchema = z.strictObject({
  answer: z.string().min(1).max(20000),
  uncertainty: z.array(z.string().min(1).max(4096)).max(64).optional(),
});
export const managerAgent: AgentDefinition = {
  id: 'Manager',
  version: 'manager.v4',
  schemas: {
    plan: managerPlanSchema,
    synthesis: synthesisSchema,
    decision: managerDecisionSchema,
  },
  instructions: managerInstructions,
  decide,
  assembleContext: assembleManagerContext,
  fixtureDecision,
};
