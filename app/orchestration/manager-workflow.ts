import type { RunnableConfig } from '@langchain/core/runnables';
import type { CommandInstance, StateSnapshot } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentModelCompletion } from '../adapters/agent-model.js';
import type { ManagerContext, ManagerDecision } from '../contracts/manager.js';

/** The runtime depends on this workflow contract; the Manager owns its topology. */
export interface ManagerGraphState {
  cycle: number;
  cursor: number;
  context: ManagerContext;
  response: AgentModelCompletion | null;
  decision: ManagerDecision;
  original: ManagerDecision | null;
  lookup: unknown;
  forceDecision: boolean;
  route: 'decide' | 'wait' | 'done';
}

type Update = Partial<ManagerGraphState> | void;
export interface ManagerGraphHooks {
  hydrate(this: void, state: ManagerGraphState): Update | Promise<Update>;
  context(this: void, state: ManagerGraphState): Update | Promise<Update>;
  decide(this: void, state: ManagerGraphState): Promise<Update>;
  validate(this: void, state: ManagerGraphState): Update | Promise<Update>;
  lookup(this: void, state: ManagerGraphState): Promise<Update>;
  execute(this: void, state: ManagerGraphState): Update | Promise<Update>;
  dispatch(this: void, state: ManagerGraphState): Update | Promise<Update>;
  park(this: void, state: ManagerGraphState): Update | Promise<Update>;
  trace?(node: string): void;
  traceCompleted?(
    node: string,
    timing: { duration_ms: number; outcome: 'ok' | 'error' },
  ): void;
}

interface ManagerWorkflow {
  getState(config: RunnableConfig): Promise<StateSnapshot>;
  invoke(
    input:
      | Partial<ManagerGraphState>
      | CommandInstance<unknown, Partial<ManagerGraphState>, never>
      | null,
    config: RunnableConfig & { durability: 'sync' },
  ): Promise<unknown>;
}

export type ManagerGraphFactory = (
  checkpointer: BaseCheckpointSaver,
  hooks: ManagerGraphHooks,
) => ManagerWorkflow;
