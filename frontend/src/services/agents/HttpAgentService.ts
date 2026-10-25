import { delay } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';
import { AgentRunError, type AgentService } from './AgentService.ts';

/**
 * Asks the Haze server (server/src/runs).
 *
 *   POST /api/runs                 -> 202 { runId }
 *   GET  /api/runs/:id/events (SSE) -> "agent" events (AgentEvent), then "answer" (AgentAnswer)
 *   POST /api/runs/:id/cancel      -> 204
 *
 * The server only emits events for agents that really ran. Its steps often finish
 * within milliseconds, so events are played back at least PLAYBACK_GAP_MS apart for
 * the office animation. Playback only spaces them out: it never adds, removes or
 * reorders an event.
 */
const PLAYBACK_GAP_MS = 650;

export class HttpAgentService implements AgentService {
  readonly label = 'Haze server agents';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer> {
    const response = await fetch(`${this.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw new AgentRunError(
        `The server refused the question (HTTP ${response.status}).`,
        response.status >= 500,
      );
    }
    const { runId } = (await response.json()) as { runId: string };

    const queue: (
      | { kind: 'event'; event: AgentEvent }
      | { kind: 'answer'; answer: AgentAnswer }
      | { kind: 'lost' }
    )[] = [];
    let wake: (() => void) | null = null;
    const push = (entry: (typeof queue)[number]) => {
      queue.push(entry);
      wake?.();
    };
    const source = new EventSource(`${this.baseUrl}/api/runs/${runId}/events`);
    let finished = false;
    source.addEventListener('agent', (e) =>
      push({
        kind: 'event',
        event: JSON.parse((e as MessageEvent<string>).data) as AgentEvent,
      }),
    );
    source.addEventListener('answer', (e) =>
      push({
        kind: 'answer',
        answer: JSON.parse((e as MessageEvent<string>).data) as AgentAnswer,
      }),
    );
    source.addEventListener('end', () => {
      finished = true;
      source.close();
    });
    source.onerror = () => {
      if (!finished) push({ kind: 'lost' });
      source.close();
    };
    const onAbort = () => {
      void fetch(`${this.baseUrl}/api/runs/${runId}/cancel`, {
        method: 'POST',
      }).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          wake = null;
        }
        if (signal.aborted) {
          onEvent({
            type: 'run_cancelled',
            runId,
            at: new Date().toISOString(),
            message: 'Cancelled.',
          });
          throw new DOMException('Cancelled', 'AbortError');
        }
        const entry = queue.shift();
        if (!entry) continue;
        if (entry.kind === 'answer') return entry.answer;
        if (entry.kind === 'lost') {
          const message =
            'Lost the connection to the server before the answer arrived.';
          onEvent({
            type: 'run_failed',
            runId,
            at: new Date().toISOString(),
            agent: null,
            error: message,
            retryable: true,
            message,
          });
          throw new AgentRunError(message, true);
        }
        onEvent(entry.event);
        if (entry.event.type === 'run_failed') {
          throw new AgentRunError(entry.event.error, entry.event.retryable);
        }
        if (entry.event.type === 'run_cancelled')
          throw new DOMException('Cancelled', 'AbortError');
        await delay(PLAYBACK_GAP_MS, signal).catch(() => undefined);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      source.close();
    }
  }
}
