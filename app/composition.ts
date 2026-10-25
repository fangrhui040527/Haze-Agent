import {
  ExecutionRegistry,
  type ExecutionMode,
} from './orchestration/ports.js';
import { managerAgent } from './agents/manager/index.js';
import { hazeOpsAgent } from './agents/hazeops/index.js';
import { workerShieldAgent } from './agents/workershield/index.js';
import { evidenceCriticAgent } from './agents/evidence-critic/index.js';
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
  ])
    registry.registerAgent(agent);
  registry.registerCapability(createPm25Capability());
  registry.registerCapability(createEpisodeInvestigationCapability());
  registry.registerCapability(createEvidenceSynthesisCapability());
  for (const assignment of [
    ...createPm25Assignments(),
    ...createEpisodeInvestigationAssignments(),
    ...createEvidenceSynthesisAssignments(),
  ])
    registry.registerAssignment(assignment);
  for (const tool of createPm25Tools(options)) registry.registerTool(tool);
  return registry;
}
