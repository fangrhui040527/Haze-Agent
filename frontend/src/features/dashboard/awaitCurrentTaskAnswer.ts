import {
  AgentRunError,
  AgentTaskCancelledError,
} from '../../services/agents/AgentService.ts';
import { abortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentTaskHandle,
} from '../../shared/types/agents.ts';

type Readback = (task: AgentTaskHandle) => void;
type Observe = (onTask: Readback) => Promise<AgentAnswer>;

function sameRevision(
  observed: AgentTaskHandle | null,
  current: AgentTaskHandle,
) {
  const before = observed?.record;
  const after = current.record;
  return !!(
    before &&
    after &&
    observed.id === current.id &&
    before.current_run_id === after.current_run_id &&
    before.objective_revision === after.objective_revision &&
    before.generation === after.generation &&
    before.state_revision === after.state_revision
  );
}

/** A delayed old completion must not finish a task that was corrected or continued. */
export async function awaitCurrentTaskAnswer({
  signal,
  execute,
  currentTask,
  onTask,
  onAnswer,
  watch,
}: {
  signal: AbortSignal;
  execute: Observe;
  currentTask: () => AgentTaskHandle | null;
  onTask: Readback;
  /** Publish synchronously with the freshness check, before another readback can arrive. */
  onAnswer?: (answer: AgentAnswer) => void;
  watch?: (taskId: string, onTask: Readback) => Promise<AgentAnswer>;
}): Promise<AgentAnswer> {
  let observe = execute;
  while (true) {
    let observed = currentTask();
    let answer: AgentAnswer | undefined;
    let failure: unknown;
    try {
      answer = await observe((task) => {
        observed = task;
        onTask(task);
      });
    } catch (error) {
      failure = error;
    }
    if (signal.aborted) throw abortError();
    const current = currentTask();
    const record = current?.record;
    const fresh = !record || sameRevision(observed, current);
    if (fresh) {
      if (!answer) throw failure;
      if (
        !record ||
        !answer.evidence ||
        (record?.status === 'completed' &&
          answer.runId === record.current_run_id &&
          answer.evidence.objectiveRevision === record.objective_revision)
      ) {
        onAnswer?.(answer);
        return answer;
      }
    }
    if (!current || !record) throw failure;
    if (record.status === 'cancelled') throw new AgentTaskCancelledError();
    if (record.status === 'failed' || record.status === 'timed_out')
      throw new AgentRunError(
        record.error?.message ?? `Task ended with status ${record.status}.`,
        false,
      );
    if (!watch)
      throw new AgentRunError(
        'The saved task changed while its answer was loading. Open the task report again to read the current run.',
        false,
      );
    // The prior observer is finished. Reuse its controller and event sink; never fork watchers.
    observe = (readback) => watch(current.id, readback);
  }
}
