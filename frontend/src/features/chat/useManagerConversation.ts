import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagerChatQuestion,
  ManagerChatRequest,
} from '../../../../app/contracts/manager-chat.ts';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import { agentService, AgentRunError } from '../../services/agents/index.ts';
import { useLocalStorageState } from '../../shared/hooks/hooks.ts';
import { readLocal, writeLocal } from '../../shared/lib/store.ts';
import { isAbortError } from '../../shared/lib/delay.ts';
import {
  consumeNextTaskNightshiftPermission,
  getNextTaskNightshiftPermission,
  getNextTaskNightshiftPermissionId,
} from '../../shared/lib/nextTaskPermissions.ts';
import { acceptTaskReadback } from '../dashboard/taskReadback.ts';
import type { AgentTaskHandle } from '../../shared/types/agents.ts';
import {
  applyTurnResponse,
  conversationHistory,
  currentTaskQuestions,
  reconcileTaskMessages,
  retainConversationMessages,
  type ChatMessage,
} from './conversationState.ts';

export function useManagerConversation(
  restoredTask: AgentTaskHandle | null,
  observeTask?: (taskId: string) => void,
) {
  const [messages, setMessages] = useLocalStorageState<ChatMessage[]>(
    'haze.chat.v1',
    readLocal<ChatMessage[]>('hazewatch.chat.v1', []),
  );
  const [conversationId, setConversationId] = useLocalStorageState(
    'haze.chat.conversation.v1',
    messages.findLast((message) => message.request)?.request?.conversation_id ??
      crypto.randomUUID(),
  );
  const [sending, setSending] = useState(false);
  const [allowDetachedRestore, setAllowDetachedRestore] = useLocalStorageState(
    'haze.chat.detached-task-restore.v1',
    true,
  );
  const detachedRestoreRef = useRef(allowDetachedRestore);
  const [observationErrors, setObservationErrors] = useState<
    Record<string, string>
  >({});
  const messagesRef = useRef(messages);
  const conversationRef = useRef(conversationId);
  const requestRef = useRef<AbortController | null>(null);
  const recordsRef = useRef(new Map<string, TaskRecord>());
  const seenEventsRef = useRef(
    new Set([
      ...readLocal<string[]>('haze.chat.events.v1', []),
      ...messages.flatMap((message) =>
        message.eventKey ? [message.eventKey] : [],
      ),
    ]),
  );
  const save = useCallback(
    (next: ChatMessage[]) => {
      for (const message of next)
        if (message.eventKey) seenEventsRef.current.add(message.eventKey);
      messagesRef.current = retainConversationMessages(next);
      setMessages(messagesRef.current);
      writeLocal('haze.chat.events.v1', [...seenEventsRef.current]);
    },
    [setMessages],
  );

  const receiveTask = useCallback(
    (record: TaskRecord) => {
      if (
        !detachedRestoreRef.current &&
        !messagesRef.current.some(
          (message) => message.taskCard?.task_id === record.id,
        )
      )
        return;
      const previous = recordsRef.current.get(record.id);
      const handle = (value: TaskRecord): AgentTaskHandle => ({
        id: value.id,
        schemaVersion: 'haze.task.v3',
        status: value.status,
        taskUrl: `/api/tasks/${value.id}`,
        record: value,
      });
      if (
        !acceptTaskReadback(previous ? handle(previous) : null, handle(record))
      )
        return;
      recordsRef.current.set(record.id, record);
      const next = reconcileTaskMessages(
        messagesRef.current,
        record,
        seenEventsRef.current,
        detachedRestoreRef.current,
      );
      if (next !== messagesRef.current) save(next);
    },
    [save],
  );

  useEffect(() => {
    if (restoredTask?.record) receiveTask(restoredTask.record);
  }, [restoredTask, receiveTask]);

  useEffect(() => {
    // A reload keeps the original payload so a delivery interrupted by navigation
    // can be retried against the server turn ledger without admitting another task.
    const next = messagesRef.current.map((message): ChatMessage =>
      message.state === 'pending'
        ? {
            ...message,
            state: 'error',
            retryable: Boolean(message.request),
            error:
              'Delivery was interrupted. Retry to recover this saved conversation turn.',
          }
        : message,
    );
    if (next.some((message, index) => message !== messagesRef.current[index]))
      save(next);
    return () => requestRef.current?.abort();
  }, [save]);

  const taskIds = [
    ...new Set([
      ...messages.flatMap((message) =>
        message.taskCard ? [message.taskCard.task_id] : [],
      ),
      ...(restoredTask &&
      (allowDetachedRestore ||
        messages.some(
          (message) => message.taskCard?.task_id === restoredTask.id,
        ))
        ? [restoredTask.id]
        : []),
    ]),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    if (!taskIds || !agentService.readTask) return;
    const controller = new AbortController();
    const pollingConversation = conversationRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await Promise.all(
        taskIds.split(',').map(async (taskId) => {
          try {
            const record = await agentService.readTask!(
              taskId,
              AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            );
            if (
              controller.signal.aborted ||
              pollingConversation !== conversationRef.current
            )
              return;
            receiveTask(record);
            setObservationErrors((previous) => {
              if (!(taskId in previous)) return previous;
              const next = { ...previous };
              delete next[taskId];
              return next;
            });
          } catch (error) {
            if (
              !controller.signal.aborted &&
              pollingConversation === conversationRef.current
            )
              setObservationErrors((previous) => ({
                ...previous,
                [taskId]:
                  error instanceof Error
                    ? error.message
                    : 'Task progress is temporarily unavailable.',
              }));
          }
        }),
      );
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskIds, receiveTask, conversationId]);

  const deliver = async (pendingId: string, request: ManagerChatRequest) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setSending(true);
    try {
      if (!agentService.managerChat)
        throw new AgentRunError(
          'This service does not support Manager conversations.',
          false,
        );
      const response = await agentService.managerChat(
        request,
        AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]),
      );
      if (
        controller.signal.aborted ||
        request.conversation_id !== conversationRef.current
      )
        return;
      save(applyTurnResponse(messagesRef.current, pendingId, response));
      if (
        response.task &&
        (response.kind === 'task_admitted' || response.kind === 'task_updated')
      )
        observeTask?.(response.task.task_id);
      if (response.kind === 'task_admitted' && request.nightshift_tools?.length)
        consumeNextTaskNightshiftPermission(request.nightshift_permission_id);
    } catch (error) {
      if (
        controller.signal.aborted ||
        request.conversation_id !== conversationRef.current
      )
        return;
      save(
        messagesRef.current.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                state: 'error',
                error: isAbortError(error)
                  ? 'The conversation request timed out. Retry to recover the same turn.'
                  : error instanceof Error
                    ? error.message
                    : 'The Manager could not be reached.',
                retryable:
                  error instanceof AgentRunError ? error.retryable : true,
              }
            : message,
        ),
      );
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setSending(false);
      }
    }
  };

  const send = async (
    text: string,
    selectedItemId: string | null,
    answerTo?: ManagerChatQuestion,
  ) => {
    const message = text.trim();
    if (!message || requestRef.current) return false;
    const turnId = crypto.randomUUID();
    writeLocal('haze.chat.conversation.v1', conversationRef.current);
    const request: ManagerChatRequest = {
      schema_version: 'haze.manager.chat.request.v1',
      conversation_id: conversationRef.current,
      turn_id: turnId,
      message,
      history: conversationHistory(messagesRef.current),
      task_questions: currentTaskQuestions([...recordsRef.current.values()]),
      ...(selectedItemId ? { selected_item_id: selectedItemId } : {}),
      ...(answerTo ? { answer_to: answerTo } : {}),
      ...(getNextTaskNightshiftPermission()
        ? {
            nightshift_tools: [
              'nightshift.submit',
              'nightshift.result',
              'nightshift.cancel',
            ] as const,
            nightshift_permission_id: getNextTaskNightshiftPermissionId(),
          }
        : {}),
    };
    save([
      ...messagesRef.current,
      {
        id: `${turnId}:user`,
        role: 'user',
        at: new Date().toISOString(),
        text: message,
        state: 'done',
      },
      {
        id: turnId,
        role: 'agents',
        at: new Date().toISOString(),
        state: 'pending',
        request,
      },
    ]);
    await deliver(turnId, request);
    return true;
  };

  const retry = async (message: ChatMessage) => {
    if (!message.request || requestRef.current) return;
    // A confirmed failure response is a completed ledger turn. An explicit retry
    // requests another inference; an uncertain delivery recovers the exact turn.
    const request = message.errorCategory
      ? { ...message.request, turn_id: crypto.randomUUID() }
      : message.request;
    save(
      messagesRef.current.map((item) =>
        item.id === message.id
          ? {
              ...item,
              id: request.turn_id,
              request,
              state: 'pending',
              error: undefined,
              errorCategory: undefined,
            }
          : item,
      ),
    );
    await deliver(request.turn_id, request);
  };
  const clear = () => {
    detachedRestoreRef.current = false;
    setAllowDetachedRestore(false);
    requestRef.current?.abort();
    requestRef.current = null;
    const nextId = crypto.randomUUID();
    conversationRef.current = nextId;
    setConversationId(nextId);
    recordsRef.current.clear();
    seenEventsRef.current.clear();
    save([]);
    setSending(false);
    setObservationErrors({});
  };
  return {
    messages,
    allowDetachedRestore,
    seenEvents: seenEventsRef.current,
    sending,
    observationErrors,
    send,
    retry,
    clear,
  };
}
