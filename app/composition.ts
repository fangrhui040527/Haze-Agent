import {
  ExecutionRegistry,
  type ExecutionMode,
} from './orchestration/ports.js';
import { managerAgent } from './agents/manager/index.js';
import { ManagerConversation } from './agents/manager/conversation.js';
import type { ManagerConversationFactory } from './orchestration/conversation.js';

export const createManagerConversation: ManagerConversationFactory = (
  options,
) => new ManagerConversation(options);
import { hazeOpsAgent } from './agents/hazeops/index.js';
import { workerShieldAgent } from './agents/workershield/index.js';
import { evidenceCriticAgent } from './agents/evidence-critic/index.js';
import { damageAccountantAgent } from './agents/damage-accountant/index.js';
import {
  createDamageAppraisalAssignments,
  createDamageAppraisalCapability,
  createDamageAppraisalTools,
} from './capabilities/damage-appraisal/index.js';
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
  createSmokeLedgerAssignments,
  createSmokeLedgerCapability,
  createSmokeLedgerTools,
  SMOKELEDGER_CAPABILITY,
} from './capabilities/smokeledger/index.js';
import { smokeLedgerFinalRenderer } from './capabilities/smokeledger/final-answer.js';
import {
  createDamageAccountIntakeAssignments,
  createDamageAccountIntakeCapability,
} from './capabilities/damage-account-intake/index.js';
import { damageAccountScopeSchema } from './capabilities/damage-account-intake/contracts.js';
import { HazeWorld } from './world/haze-world.js';
import { HazeOpsService } from './agents/hazeops/service.js';
import { loadDashboardConfig } from './dashboard/config.js';
import { DashboardService } from './dashboard/http.js';
import type { TaskStore } from './tasks/store.js';
import type { TaskIdentity } from './contracts/tasks.js';
import { createWorldModelDamageInputTool } from './adapters/damage-input-adapter/index.js';
import { damageWorldInputPolicy } from './capabilities/damage-appraisal/world-input-policy.js';
import {
  createEvidenceCollectionAssignments,
  createEvidenceCollectionCapability,
  createEvidenceCollectionTools,
} from './capabilities/evidence-collection/index.js';
import {
  WEB_SEARCH_TOOL_ID,
  createWebSearchTools,
} from './capabilities/evidence-collection/web-search.js';
import { ModelRouteRegistry } from './adapters/model-routes.js';
import type { ModelRouteService } from './orchestration/model-service.js';
import { CliNightshiftJobAdapter } from './adapters/nightshift/jobs.js';
import type { NightshiftJobPort } from './orchestration/ports.js';
import { NIGHTSHIFT_TOOL_IDS } from './tasks/nightshift-tools.js';
import {
  createDamageEvidenceResearchCapability,
  createDamageEvidenceResearchAssignments,
  createCapturedExcerptTools,
} from './capabilities/damage-evidence-research/index.js';
import {
  DamageEvidenceMaintenance,
  createDamageEvidenceMaintenanceExtension,
} from './capabilities/damage-evidence-maintenance/index.js';
import {
  createDamageEvidenceReviewAssignments,
  createDamageEvidenceReviewTools,
  assertScientificInputBindings,
} from './capabilities/damage-evidence-review/index.js';

export function createNightshiftJobAdapter(
  env: NodeJS.ProcessEnv,
): NightshiftJobPort {
  return new CliNightshiftJobAdapter(env);
}
import {
  createDamageReductionAssignments,
  createDamageReductionCapability,
  createDamageReductionSelectionTool,
  createDamageReductionTools,
} from './capabilities/damage-reduction-planning/index.js';
import { createDamageReductionClaimTool } from './capabilities/damage-reduction-planning/claims.js';
import { createConditionalPlanningTools } from './capabilities/damage-reduction-planning/preview-workflow.js';
import { readDamageReductionPreview } from './capabilities/damage-reduction-planning/view.js';
import { createReductionProgrammeExtension } from './capabilities/damage-reduction-programmes/index.js';
import {
  createPilotTools,
  readPilotTaskView,
} from './capabilities/damage-reduction-planning/pilot-workflow.js';
import { pm25FinalRenderer } from './capabilities/pm25/final-answer.js';
import { damageAccountFinalRenderer } from './capabilities/damage-appraisal/final-answer.js';
import { reductionFinalRenderer } from './capabilities/damage-reduction-planning/final-answer.js';
import { sampleModeEnabled } from './adapters/sample-mode.js';
import { createSamplePm25Source } from './sample-data/pm25-source.js';

/** Concrete provider routing stays registered at the application boundary. */
export function createModelRouteRegistry(
  env: NodeJS.ProcessEnv,
): ModelRouteService {
  return new ModelRouteRegistry(env);
}

/** Both application surfaces use the task runtime's single SQLite owner. */
export function createDashboardServices(options: {
  store: TaskStore;
  identity: TaskIdentity;
  mode: ExecutionMode;
  env: NodeJS.ProcessEnv;
}) {
  const config = loadDashboardConfig(options.env);
  const world = new HazeWorld(options.store, options.identity, options.mode);
  const hazeops = new HazeOpsService({ ...options, config, world });
  // Preserve the readiness rejection for the request while construction remains sync.
  void hazeops.ready.catch(() => undefined);
  try {
    const view = new DashboardService({
      world,
      hazeops,
      config,
      mode: options.mode,
    });
    return { view, hazeops };
  } catch (error) {
    void hazeops.close();
    throw error;
  }
}

/** Compose domain collectors at the application boundary, outside core HTTP routing. */
export function startApplicationServices(
  runtime: { extension(id: string): { service?: unknown } | undefined },
  dashboard: ReturnType<typeof createDashboardServices>,
): void {
  const maintenance = runtime.extension('damage-evidence-maintenance')?.service;
  if (maintenance instanceof DamageEvidenceMaintenance)
    maintenance.attach(dashboard.hazeops);
  dashboard.hazeops.start();
  dashboard.view.start();
}

/** The single composition root owns all domain imports and executable registration. */
export function createExecutionRegistry(options: {
  mode: ExecutionMode;
  env?: NodeJS.ProcessEnv;
}): ExecutionRegistry {
  if (sampleModeEnabled(options.env ?? {}))
    options = { ...options, env: { ...options.env, SAMPLE_MODE: 'true' } };
  const registry = new ExecutionRegistry();
  registry.registerExtension(createReductionProgrammeExtension);
  registry.registerExtension(
    createDamageEvidenceMaintenanceExtension(options.env),
  );
  registry.registerTaskView('reduction-preview', readDamageReductionPreview);
  registry.registerTaskView('reduction-pilot', readPilotTaskView);
  registry.registerStoreTools((store, mode) => [
    createWorldModelDamageInputTool(store, mode, {
      ...damageWorldInputPolicy,
      checkScientificInputs: assertScientificInputBindings,
    }),
    createDamageReductionSelectionTool(store, mode),
    ...createDamageReductionTools({ store, mode }),
    createDamageReductionClaimTool(store, mode),
    ...createConditionalPlanningTools(store, mode),
    ...createPilotTools(store, mode),
    ...createCapturedExcerptTools(store, mode),
  ]);
  for (const agent of [
    managerAgent,
    hazeOpsAgent,
    workerShieldAgent,
    evidenceCriticAgent,
    damageAccountantAgent,
  ])
    registry.registerAgent(agent);
  const reduction = createDamageReductionCapability();
  const research = createDamageEvidenceResearchCapability();
  registry.registerCapability(research);
  registry.registerCapability(reduction);
  const calculatedDamage = createDamageAppraisalCapability();
  registry.registerCapability({
    ...calculatedDamage,
    // Supplied manifest scopes belong to the separate account-intake workflow.
    matches: (request) =>
      !research.matches(request) &&
      !reduction.matches(request) &&
      !damageAccountScopeSchema.safeParse(request.scope).success &&
      calculatedDamage.matches(request),
  });
  const collection = createEvidenceCollectionCapability();
  registry.registerCapability({
    ...collection,
    matches: (request) =>
      !research.matches(request) && collection.matches(request),
  });
  const pm25 = createPm25Capability();
  registry.registerCapability({
    ...pm25,
    // Explicit fresh collection is separate from summarizing stored samples.
    matches: (request) =>
      !research.matches(request) &&
      !reduction.matches(request) &&
      !collection.matches(request) &&
      pm25.matches(request),
  });
  const componentIntake = createDamageAccountIntakeCapability();
  registry.registerCapability({
    ...componentIntake,
    // Manifest intake and calculation advertise different starting plans.
    matches: (request) =>
      !research.matches(request) &&
      !reduction.matches(request) &&
      componentIntake.matches(request) &&
      (!calculatedDamage.matches(request) ||
        damageAccountScopeSchema.safeParse(request.scope).success),
  });
  // Before episode-investigation: fixture planning picks the first match, and SmokeLedger
  // only matches requests with a readable town and window.
  registry.registerCapability(createSmokeLedgerCapability());
  registry.registerCapability(createEpisodeInvestigationCapability());
  registry.registerCapability(createEvidenceSynthesisCapability());
  // Quantitative answers are rendered from reviewed artifacts, not Manager prose.
  registry.registerFinalRenderer(pm25.card.id, pm25FinalRenderer);
  registry.registerFinalRenderer(
    calculatedDamage.card.id,
    damageAccountFinalRenderer,
  );
  registry.registerFinalRenderer(reduction.card.id, reductionFinalRenderer);
  registry.registerFinalRenderer(
    SMOKELEDGER_CAPABILITY,
    smokeLedgerFinalRenderer,
  );
  for (const assignment of [
    ...createDamageReductionAssignments(),
    ...createDamageEvidenceResearchAssignments(),
    ...createDamageEvidenceReviewAssignments(),
    ...createDamageAppraisalAssignments(),
    ...createPm25Assignments(),
    ...createEvidenceCollectionAssignments(),
    ...createDamageAccountIntakeAssignments(),
    ...createSmokeLedgerAssignments(),
    ...createEpisodeInvestigationAssignments(),
    ...createEvidenceSynthesisAssignments(),
  ]) {
    const optional = [
      ...(['HazeOps', 'WorkerShield', 'EvidenceCritic'].includes(
        assignment.agent,
      )
        ? NIGHTSHIFT_TOOL_IDS
        : []),
      // Web search is scoped to evidence collection, not to every HazeOps
      // assignment: it gathers unreviewed third-party documents, which is
      // collection rather than review, protective analysis or planning.
      // Widening it to another assignment should be a deliberate decision.
      ...(assignment.agent === 'HazeOps' &&
      assignment.capability === 'evidence-collection'
        ? [WEB_SEARCH_TOOL_ID]
        : []),
    ];
    registry.registerAssignment({
      ...assignment,
      ...(optional.length ? { optional_tools: optional } : {}),
    });
  }
  for (const tool of createPm25Tools({
    ...options,
    ...(options.mode === 'live' && sampleModeEnabled(options.env ?? {})
      ? { source: createSamplePm25Source(options.env) }
      : {}),
  }))
    registry.registerTool(tool);
  for (const tool of createEvidenceCollectionTools(options))
    registry.registerTool(tool);
  for (const tool of createWebSearchTools(options)) registry.registerTool(tool);
  for (const tool of createDamageEvidenceReviewTools(options))
    registry.registerTool(tool);
  for (const tool of createDamageAppraisalTools(options))
    registry.registerTool(tool);
  for (const tool of createSmokeLedgerTools(options))
    registry.registerTool(tool);
  return registry;
}
