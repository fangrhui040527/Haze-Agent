import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';

/**
 * Asks the agent system a question.
 *
 * While working, the implementation calls `onEvent` for every AgentEvent (see
 * src/shared/types/agents.ts). The chat, status line and pixel office render only from those
 * events, so a real backend can replace the mock without UI changes.
 *
 * - Resolves with the final answer.
 * - Rejects with an AbortError if `signal` is aborted (after emitting `run_cancelled`).
 * - Rejects with AgentRunError if the run fails (after emitting `run_failed`).
 */
export interface AgentService {
  readonly label: string;
  ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer>;
}

export class AgentRunError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AgentRunError';
    this.retryable = retryable;
  }
}
