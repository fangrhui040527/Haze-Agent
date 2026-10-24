import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';
import type { AgentService } from './AgentService.ts';

/**
 * TODO(backend): real agent adapter. NOT IMPLEMENTED — the backend API for chat is not decided.
 *
 * What we know from the spec (Haze_Agent_Architecture_v0.13.pdf §15.2 p.28):
 *   POST /run returns 202 + a status location; GET /runs/{id} returns execution state
 *   (queued/running/waiting/paused/completed/failed/cancelled/timed_out). That is POLLING with
 *   run-level state only -> map it to `run_state` events (fallback level B).
 *
 * If the backend adds per-agent events (agreed in docs/02-critique.md §5.3), map each one to an
 * AgentEvent (agent_working, handoff, …) and the office will animate them automatically.
 * Never invent per-agent events the backend did not send.
 *
 * Sketch (do not ship until the endpoints are confirmed):
 *   1. POST question -> runId
 *   2. Either: new EventSource(`${baseUrl}/runs/${runId}/events`) and map messages -> onEvent
 *      Or:     poll GET /runs/{runId} every ~2 s and emit run_state events
 *   3. On completion, fetch the answer and map to AgentAnswer (source: 'model' only if the
 *      backend confirms a model produced it; otherwise 'template_fallback').
 *   4. On signal abort: call the backend's cancel endpoint (if any), emit run_cancelled.
 */
export class HttpAgentService implements AgentService {
  readonly label = 'Backend agents';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // TODO(backend): add the `signal: AbortSignal` parameter (3rd) and use it to cancel the run.
  ask(
    _request: AskRequest,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentAnswer> {
    const message = `HttpAgentService is not implemented yet (${this.baseUrl}). See TODOs in this file.`;
    onEvent({
      type: 'run_failed',
      runId: 'not-started',
      at: new Date().toISOString(),
      agent: null,
      error: message,
      retryable: false,
      message,
    });
    return Promise.reject(new Error(message));
  }
}
