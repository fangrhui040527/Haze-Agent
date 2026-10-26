import { parseContractJson } from '../../contracts/json.js';
import {
  managerDecisionSchema,
  type ManagerDecision,
} from '../../contracts/manager.js';
import { TaskError } from '../../contracts/tasks.js';
import type { ManagerServices } from '../../orchestration/ports.js';

/** Models propose decisions. Only the runtime can authorize and execute them. */
export async function decide(
  services: ManagerServices,
): Promise<ManagerDecision> {
  const response = await services.model(services.context);
  const decision = managerDecisionSchema.parse(
    parseContractJson(response.text),
  );
  const context = services.context;
  if (decision.recovery_of)
    throw new TaskError(
      422,
      'recovery_metadata_denied',
      'Recovery metadata is reserved for runtime re-admission of an already persisted validated decision.',
    );
  if (
    decision.run_id !== context.run_id ||
    decision.generation !== context.generation ||
    decision.objective_revision !== context.objective_revision ||
    decision.plan_revision !== context.plan_revision ||
    decision.event_cursor !== context.event_cursor
  )
    throw new TaskError(
      409,
      'stale_manager_decision',
      'The Manager decision does not match its admitted checkpoint.',
    );
  return decision;
}
