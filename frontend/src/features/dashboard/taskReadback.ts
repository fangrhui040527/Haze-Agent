import type { AgentTaskHandle } from '../../shared/types/agents.ts';
/** Revisions are ordered within a run. A linked run can start at state revision one. */
export function acceptTaskReadback(
  previous: AgentTaskHandle | null,
  incoming: AgentTaskHandle,
): boolean {
  if (previous?.id !== incoming.id || !previous.record) return true;
  if (!incoming.record) return false;
  return (
    incoming.record.objective_revision >= previous.record.objective_revision &&
    incoming.record.runs.length >= previous.record.runs.length &&
    (incoming.record.current_run_id !== previous.record.current_run_id ||
      incoming.record.state_revision >= previous.record.state_revision)
  );
}
