import {
  ExecutionRegistry,
  type ExecutionMode,
} from './orchestration/ports.js';
import { managerAgent } from './agents/manager/index.js';
import { hazeOpsAgent } from './agents/hazeops/index.js';
import { workerShieldAgent } from './agents/workershield/index.js';
import { evidenceCriticAgent } from './agents/evidence-critic/index.js';
import { damageAccountantAgent } from './agents/damage-accountant/index.js';
import {
  createDamageAccountAssignments,
  createDamageAccountCapability,
  createDamageAccountTools,
} from './capabilities/damage-account/index.js';
import {
  createEvidenceSynthesisAssignments,
  createEvidenceSynthesisCapability,
} from './capabilities/evidence-synthesis/index.js';
import {
  createEpisodeInvestigationAssignments,
  createEpisodeInvestigationCapability,
} from './capabilities/episode-investigation/index.js';
import {
  createPm25Assignments,
  createPm25Capability,
  createPm25Tools,
} from './capabilities/pm25/index.js';
import {
  createDamageAccountingAssignments,
  createDamageAccountingCapability,
} from './capabilities/damage-accounting/index.js';
import { damageAccountScopeSchema } from './capabilities/damage-accounting/contracts.js';

/** The single composition root owns all domain imports and executable registration. */
export function createExecutionRegistry(options: {
  mode: ExecutionMode;
  env?: NodeJS.ProcessEnv;
}): ExecutionRegistry {
  const registry = new ExecutionRegistry();
  for (const agent of [
    managerAgent,
    hazeOpsAgent,
    workerShieldAgent,
    evidenceCriticAgent,
    damageAccountantAgent,
  ])
    registry.registerAgent(agent);
  const calculatedDamage = createDamageAccountCapability();
  registry.registerCapability({
    ...calculatedDamage,
    // Supplied manifest scopes belong to the separate account-intake workflow.
    matches: (request) =>
      !damageAccountScopeSchema.safeParse(request.scope).success &&
      calculatedDamage.matches(request),
  });
  registry.registerCapability(createPm25Capability());
  registry.registerCapability(createDamageAccountingCapability());
  registry.registerCapability(createEpisodeInvestigationCapability());
  registry.registerCapability(createEvidenceSynthesisCapability());
  for (const assignment of [
    ...createDamageAccountAssignments(),
    ...createPm25Assignments(),
    ...createDamageAccountingAssignments(),
    ...createEpisodeInvestigationAssignments(),
    ...createEvidenceSynthesisAssignments(),
  ])
    registry.registerAssignment(assignment);
  for (const tool of createPm25Tools(options)) registry.registerTool(tool);
  for (const tool of createDamageAccountTools(options))
    registry.registerTool(tool);
  return registry;
}
