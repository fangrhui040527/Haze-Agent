import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agentService,
  AgentTaskCancelledError,
} from '../../services/agents/index.ts';
import { abortError, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
  AgentTaskHandle,
} from '../../shared/types/agents.ts';

export type RunStatus =
  'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'task_cancelled';

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
  task: AgentTaskHandle | null;
  cancellationPending: boolean;
  cancellationError: string | null;
  cancelTask(): Promise<void>;
}

/** One agent run at a time, shared by the chat (input/answers) and the office (animation). */
export function useAgentRun(): AgentRun {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const [task, setTask] = useState<AgentTaskHandle | null>(null);
  const [cancellationPending, setCancellationPending] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(
    null,
  );
  const taskRef = useRef<AgentTaskHandle | null>(null);
  const cancellationRef = useRef<AbortController | null>(null);
  const cancellationKeys = useRef(new Map<string, string>());

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      cancellationRef.current?.abort();
      cancellationRef.current = null;
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
    taskRef.current = null;
    setTask(null);
    cancellationRef.current?.abort();
    cancellationRef.current = null;
    setCancellationPending(false);
    setCancellationError(null);
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
        (admitted) => {
          if (
            controllerRef.current === controller &&
            !controller.signal.aborted
          ) {
            taskRef.current = admitted;
            setTask(admitted);
          }
        },
      );
      if (controller.signal.aborted || controllerRef.current !== controller)
        throw abortError();
      setStatus('completed');
      return answer;
    } catch (error) {
      if (controllerRef.current === controller)
        setStatus(
          error instanceof AgentTaskCancelledError
            ? 'task_cancelled'
            : isAbortError(error)
              ? 'cancelled'
              : 'failed',
        );
      throw error;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const cancelTask = useCallback(async () => {
    const admitted = taskRef.current;
    if (
      !admitted ||
      admitted.schemaVersion !== 'haze.task.v2' ||
      cancellationRef.current ||
      !agentService.cancelTask
    )
      return;
    const controller = new AbortController();
    cancellationRef.current = controller;
    setCancellationPending(true);
    setCancellationError(null);
    let operationKey = cancellationKeys.current.get(admitted.id);
    if (!operationKey) {
      operationKey = crypto.randomUUID();
      cancellationKeys.current.set(admitted.id, operationKey);
    }
    try {
      const cancelled = await agentService.cancelTask(
        admitted.id,
        operationKey,
        controller.signal,
      );
      if (taskRef.current?.id === admitted.id && !controller.signal.aborted) {
        const updated = { ...admitted, status: cancelled.status };
        taskRef.current = updated;
        setTask(updated);
        if (cancelled.status === 'cancelled' && !controllerRef.current)
          setStatus('task_cancelled');
      }
    } catch (error) {
      if (taskRef.current?.id === admitted.id && !controller.signal.aborted)
        setCancellationError(
          error instanceof Error
            ? error.message
            : 'Cancellation failed. Check the saved task status.',
        );
    } finally {
      if (cancellationRef.current === controller) {
        cancellationRef.current = null;
        setCancellationPending(false);
      }
    }
  }, []);

  const last = events[events.length - 1];
  const statusText =
    status === 'idle'
      ? 'Agents are idle. Ask a question to start.'
      : status === 'completed'
        ? 'Answer ready.'
        : status === 'task_cancelled'
          ? 'The server cancelled this task. Saved artifacts remain available.'
          : status === 'cancelled'
            ? 'Stopped waiting. Check the saved task for its server status.'
            : (last?.message ?? 'Starting…');

  return {
    events,
    status,
    statusText,
    startedAt,
    serviceLabel:
      task?.mode === 'fixture'
        ? 'Fixture adapters · development execution'
        : agentService.label,
    ask,
    cancel,
    task,
    cancellationPending,
    cancellationError,
    cancelTask,
  };
}
