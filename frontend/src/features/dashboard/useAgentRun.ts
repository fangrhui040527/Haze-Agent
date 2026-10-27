import { acceptTaskReadback } from './taskReadback.ts';
import { awaitCurrentTaskAnswer } from './awaitCurrentTaskAnswer.ts';
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
import type {
  Artifact,
  ArtifactImport,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import type { CapabilityCard } from '../../../../app/contracts/capabilities.ts';
import type {
  ControlReceipt,
  TaskControl,
  TaskUpdate,
} from '../../../../app/contracts/controls.ts';

export type RunStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'task_cancelled';
export interface AgentRun {
  events: AgentEvent[];
  status: RunStatus;
  statusText: string;
  startedAt: number | null;
  serviceLabel: string;
  ask(request: AskRequest): Promise<AgentAnswer>;
  /** Follow an already admitted task for the office without blocking conversation. */
  observeTask?(taskId: string): void;
  cancel(): void;
  /** Forget the dashboard selection without changing the saved server task. */
  reset(): void;
  task: AgentTaskHandle | null;
  operationPending: boolean;
  operationError: string | null;
  /** Readback or observation failed; the saved server task may still be active. */
  observationError?: string | null;
  receipt: ControlReceipt | null;
  control(
    action: TaskControl['action'],
    revokedTools?: string[],
  ): Promise<void>;
  update(
    passage: string,
    questionId?: string,
    scope?: TaskUpdate['scope'],
    contextRefs?: ArtifactRef[],
  ): Promise<void>;
  importSource(source: ArtifactImport, key: string): Promise<Artifact>;
  capabilities: CapabilityCard[];
  capabilitiesError: string | null;
  latestAnswer: AgentAnswer | null;
}

export function useAgentRun(
  initialTaskId?: string,
  storageKey = 'haze.general.task.id',
  options: { restoreFromStorage?: boolean } = {},
): AgentRun {
  const restoreFromStorage = options.restoreFromStorage !== false;
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [task, setTask] = useState<AgentTaskHandle | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [observationError, setObservationError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ControlReceipt | null>(null);
  const [latestAnswer, setLatestAnswer] = useState<AgentAnswer | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityCard[]>([]);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null,
  );
  const controllerRef = useRef<AbortController | null>(null);
  const restorationRef = useRef<AbortController | null>(null);
  const taskRef = useRef<AgentTaskHandle | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  // Failed delivery can be retried with the same exact body and key.
  const operationKeys = useRef(new Map<string, string>());
  useEffect(() => {
    const controller = new AbortController();
    agentService
      .capabilities?.(controller.signal)
      .then(setCapabilities)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setCapabilitiesError(
            error instanceof Error
              ? error.message
              : 'Capability metadata could not be loaded.',
          );
      });
    return () => {
      controller.abort();
      controllerRef.current?.abort();
      operationRef.current?.abort();
    };
  }, []);
  const onTask = useCallback(
    (admitted: AgentTaskHandle) => {
      if (initialTaskId !== undefined && admitted.id !== initialTaskId) return;
      if (!acceptTaskReadback(taskRef.current, admitted)) return;
      taskRef.current = admitted;
      setTask(admitted);
      try {
        sessionStorage.setItem(storageKey, admitted.id);
      } catch {
        /* Readback still works without browser storage. */
      }
      if (admitted.status === 'waiting' || admitted.status === 'paused')
        setStatus(admitted.status);
      else if (admitted.status === 'running' || admitted.status === 'queued')
        setStatus('running');
      else if (admitted.status === 'cancelled') setStatus('task_cancelled');
      else if (admitted.status === 'failed' || admitted.status === 'timed_out')
        setStatus('failed');
      else if (admitted.status === 'completed') setStatus('completed');
    },
    [initialTaskId, storageKey],
  );
  const observe = useCallback(
    async (
      execute: (
        signal: AbortSignal,
        event: (event: AgentEvent) => void,
        readback: (task: AgentTaskHandle) => void,
      ) => Promise<AgentAnswer>,
    ) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setObservationError(null);
      try {
        const onEvent = (event: AgentEvent) => {
          if (
            controllerRef.current === controller &&
            !controller.signal.aborted
          )
            setEvents((previous) =>
              previous.some(
                (item) =>
                  item.type === 'task_event' &&
                  event.type === 'task_event' &&
                  item.receipt.cursor === event.receipt.cursor,
              )
                ? previous
                : [...previous, event],
            );
        };
        const answer = await awaitCurrentTaskAnswer({
          signal: controller.signal,
          execute: (readback) => execute(controller.signal, onEvent, readback),
          currentTask: () => taskRef.current,
          onTask: (admitted) => {
            if (
              !controller.signal.aborted &&
              controllerRef.current === controller
            )
              onTask(admitted);
          },
          onAnswer: (answer) => {
            if (
              controller.signal.aborted ||
              controllerRef.current !== controller
            )
              throw abortError();
            setLatestAnswer(answer);
            setStatus('completed');
          },
          watch: agentService.watchTask
            ? (taskId, readback) =>
                agentService.watchTask!(
                  taskId,
                  onEvent,
                  controller.signal,
                  readback,
                )
            : undefined,
        });
        if (controller.signal.aborted || controllerRef.current !== controller)
          throw abortError();
        return answer;
      } catch (error) {
        if (controllerRef.current === controller) {
          if (
            !isAbortError(error) &&
            !(error instanceof AgentTaskCancelledError)
          )
            setObservationError(
              error instanceof Error
                ? error.message
                : 'Task observation failed.',
            );
          setStatus(
            error instanceof AgentTaskCancelledError
              ? 'task_cancelled'
              : isAbortError(error)
                ? 'cancelled'
                : 'failed',
          );
        }
        throw error;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [onTask],
  );
  useEffect(() => {
    let savedTaskId = initialTaskId ?? null;
    if (initialTaskId === undefined && restoreFromStorage) {
      try {
        savedTaskId = sessionStorage.getItem(storageKey);
      } catch {
        /* Browser storage is optional. */
      }
    }
    if (!savedTaskId) return;
    if (!agentService.readTask || !agentService.watchTask) {
      if (initialTaskId !== undefined) {
        setObservationError('This task service cannot restore saved reports.');
        setStatus('failed');
      }
      return;
    }
    const controller = new AbortController();
    restorationRef.current = controller;
    agentService
      .readTask(savedTaskId, controller.signal)
      .then((record) => {
        if (
          controller.signal.aborted ||
          taskRef.current ||
          controllerRef.current
        )
          return;
        onTask({
          id: record.id,
          schemaVersion: 'haze.task.v3',
          taskUrl: `${typeof import.meta.env.VITE_API_BASE_URL === 'string' ? import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '') : ''}/api/tasks/${record.id}`,
          status: record.status,
          mode: record.mode,
          record,
        });
        setStartedAt(Date.now());
        void observe((signal, event, readback) =>
          agentService.watchTask!(record.id, event, signal, readback),
        ).catch(() => {});
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !taskRef.current &&
          !controllerRef.current
        ) {
          const message =
            error instanceof Error
              ? error.message
              : 'The saved task could not be restored.';
          setOperationError(message);
          setObservationError(message);
          setStatus('failed');
        }
      });
    return () => {
      controller.abort();
      if (restorationRef.current === controller) restorationRef.current = null;
    };
  }, [initialTaskId, observe, onTask, storageKey, restoreFromStorage]);
  const ask = useCallback(
    async (request: AskRequest) => {
      if (controllerRef.current)
        throw new Error('A task is already being observed.');
      restorationRef.current?.abort();
      restorationRef.current = null;
      setEvents([]);
      setStatus('running');
      setStartedAt(Date.now());
      setLatestAnswer(null);
      taskRef.current = null;
      setTask(null);
      setReceipt(null);
      setOperationError(null);
      setObservationError(null);
      return observe((signal, event, readback) =>
        agentService.ask(request, event, signal, readback),
      );
    },
    [observe, onTask],
  );
  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const observeTask = useCallback(
    (taskId: string) => {
      if (
        !agentService.watchTask ||
        (initialTaskId !== undefined && initialTaskId !== taskId)
      )
        return;
      if (taskRef.current?.id === taskId && controllerRef.current) return;
      restorationRef.current?.abort();
      restorationRef.current = null;
      const previousObserver = controllerRef.current;
      controllerRef.current = null;
      previousObserver?.abort();
      taskRef.current = null;
      setTask(null);
      setEvents([]);
      setStartedAt(Date.now());
      setLatestAnswer(null);
      setReceipt(null);
      setOperationError(null);
      setObservationError(null);
      onTask({
        id: taskId,
        schemaVersion: 'haze.task.v3',
        taskUrl: `${typeof import.meta.env.VITE_API_BASE_URL === 'string' ? import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '') : ''}/api/tasks/${taskId}`,
        status: 'queued',
      });
      void observe((signal, event, readback) =>
        agentService.watchTask!(taskId, event, signal, readback),
      ).catch(() => {});
    },
    [initialTaskId, observe, onTask],
  );
  const reset = useCallback(() => {
    // Reports opened at a task URL stay pinned to that task.
    if (initialTaskId !== undefined) return;
    const observer = controllerRef.current;
    const operation = operationRef.current;
    controllerRef.current = null;
    operationRef.current = null;
    restorationRef.current?.abort();
    restorationRef.current = null;
    observer?.abort();
    operation?.abort();
    taskRef.current = null;
    operationKeys.current.clear();
    setEvents([]);
    setStatus('idle');
    setStartedAt(null);
    setTask(null);
    setLatestAnswer(null);
    setReceipt(null);
    setOperationPending(false);
    setOperationError(null);
    setObservationError(null);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* The in-memory selection is still cleared when storage is unavailable. */
    }
  }, [initialTaskId, storageKey]);
  const mutate = useCallback(
    async (body: TaskControl | TaskUpdate) => {
      const admitted = taskRef.current;
      if (!admitted || operationRef.current) return;
      const controller = new AbortController();
      operationRef.current = controller;
      setOperationPending(true);
      setOperationError(null);
      const fingerprint = JSON.stringify({ id: admitted.id, body });
      const key = operationKeys.current.get(fingerprint) ?? crypto.randomUUID();
      operationKeys.current.set(fingerprint, key);
      try {
        const supported =
          'action' in body
            ? typeof agentService.controlTask === 'function'
            : typeof agentService.updateTask === 'function';
        if (!supported)
          throw new Error('This task service does not support changes.');
        const received =
          'action' in body
            ? await agentService.controlTask!(
                admitted.id,
                body,
                key,
                controller.signal,
              )
            : await agentService.updateTask!(
                admitted.id,
                body,
                key,
                controller.signal,
              );
        if (controller.signal.aborted || operationRef.current !== controller)
          throw abortError();
        setReceipt(received);
        const record = await agentService.readTask!(
          admitted.id,
          controller.signal,
        );
        if (controller.signal.aborted || operationRef.current !== controller)
          throw abortError();
        onTask({
          ...admitted,
          status: record.status,
          mode: record.mode,
          record,
        });
        if (
          !controllerRef.current &&
          ['queued', 'running', 'waiting', 'paused'].includes(record.status) &&
          agentService.watchTask
        ) {
          setStartedAt(Date.now());
          void observe((signal, event, readback) =>
            agentService.watchTask!(admitted.id, event, signal, readback),
          ).catch(() => {});
        }
        if (record.status === 'cancelled') setStatus('task_cancelled');
      } catch (error) {
        if (!controller.signal.aborted) {
          setOperationError(
            error instanceof Error
              ? error.message
              : 'The change failed. Refresh the saved task and retry.',
          );
          // A stale expectation requires fresh readback before another mutation.
          try {
            const record = await agentService.readTask!(
              admitted.id,
              controller.signal,
            );
            if (
              !controller.signal.aborted &&
              operationRef.current === controller
            )
              onTask({ ...admitted, status: record.status, record });
          } catch {
            /* Keep the original operation error. */
          }
        }
        throw error;
      } finally {
        if (operationRef.current === controller) {
          operationRef.current = null;
          setOperationPending(false);
        }
      }
    },
    [observe, onTask],
  );
  const expectation = () => {
    const record = taskRef.current?.record;
    if (!record)
      throw new Error(
        'Wait for the current saved task revision before changing it.',
      );
    return {
      expected_objective_revision: record.objective_revision,
      expected_run_id: record.current_run_id,
      expected_generation: record.generation,
      expected_state_revision: record.state_revision,
    };
  };
  const control = async (
    action: TaskControl['action'],
    revokedTools?: string[],
  ) =>
    mutate({
      schema_version: 'haze.task.control.v3',
      ...expectation(),
      action,
      ...(revokedTools?.length ? { revoked_tools: revokedTools } : {}),
    });
  const update = async (
    passage: string,
    questionId?: string,
    scope?: TaskUpdate['scope'],
    contextRefs?: ArtifactRef[],
  ) =>
    mutate({
      schema_version: 'haze.task.update.v3',
      ...expectation(),
      kind: questionId ? 'clarification' : 'correction',
      passage,
      ...(questionId ? { question_id: questionId } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(contextRefs?.length ? { context_refs: contextRefs } : {}),
    });
  const importSource = async (source: ArtifactImport, key: string) => {
    if (!agentService.importSource)
      throw new Error('Source imports are unavailable.');
    return agentService.importSource(source, key);
  };
  const last = events.at(-1);
  const statusText =
    status === 'idle'
      ? 'Agents are idle. Describe a task to start.'
      : status === 'completed'
        ? 'Answer ready.'
        : status === 'paused'
          ? 'Task paused. Saved work is retained.'
          : status === 'waiting'
            ? 'Waiting for clarification or source material.'
            : status === 'task_cancelled'
              ? 'The server cancelled this task. Saved artifacts remain available.'
              : status === 'cancelled'
                ? 'Stopped waiting. Check the saved task for its server status.'
                : status === 'failed'
                  ? (task?.record?.error?.message ??
                    observationError ??
                    'Task failed.')
                  : (last?.message ?? 'Starting...');
  return {
    events,
    status,
    statusText,
    startedAt,
    serviceLabel: task?.mode
      ? `${task.mode} execution - actual receipts`
      : agentService.label,
    ask,
    observeTask,
    cancel,
    reset,
    task,
    operationPending,
    operationError,
    observationError,
    receipt,
    control,
    update,
    importSource,
    capabilities,
    capabilitiesError,
    latestAnswer,
  };
}
