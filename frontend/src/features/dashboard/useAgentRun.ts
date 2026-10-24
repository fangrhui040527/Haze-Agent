import { useCallback, useEffect, useRef, useState } from 'react';
import { agentService } from '../../services/agents/index.ts';
import { abortError, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';

export type RunStatus =
  'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentRun {
  /** Events of the current (or last) run, in order. The office animates from these. */
  events: AgentEvent[];
  status: RunStatus;
  /** Plain-text status for the status line (always available, even without animation). */
  statusText: string;
  startedAt: number | null;
  serviceLabel: string;
  ask(request: AskRequest): Promise<AgentAnswer>;
  cancel(): void;
}

/** One agent run at a time, shared by the chat (input/answers) and the office (animation). */
export function useAgentRun(): AgentRun {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const ask = useCallback(async (request: AskRequest) => {
    if (controllerRef.current)
      throw new Error('A question is already being answered.');
    const controller = new AbortController();
    controllerRef.current = controller;
    setEvents([]);
    setStatus('running');
    setStartedAt(Date.now());
    try {
      const answer = await agentService.ask(
        request,
        (e) => {
          if (
            controllerRef.current === controller &&
            !controller.signal.aborted
          ) {
            setEvents((prev) => [...prev, e]);
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted || controllerRef.current !== controller)
        throw abortError();
      setStatus('completed');
      return answer;
    } catch (error) {
      if (controllerRef.current === controller)
        setStatus(isAbortError(error) ? 'cancelled' : 'failed');
      throw error;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  const last = events[events.length - 1];
  const statusText =
    status === 'idle'
      ? 'Agents are idle. Ask a question to start.'
      : status === 'completed'
        ? 'Answer ready.'
        : status === 'cancelled'
          ? 'Cancelled.'
          : (last?.message ?? 'Starting…');

  return {
    events,
    status,
    statusText,
    startedAt,
    serviceLabel: agentService.label,
    ask,
    cancel,
  };
}
