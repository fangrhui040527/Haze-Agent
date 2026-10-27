import type {
  ManagerChatQuestion,
  ManagerChatRequest,
  ManagerChatResponse,
} from '../../../../app/contracts/manager-chat.ts';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import type { AgentAnswer, Citation } from '../../shared/types/agents.ts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agents';
  at: string;
  text?: string;
  paragraphs?: string[];
  citations?: (Citation | ManagerChatResponse['citations'][number])[];
  source?:
    | AgentAnswer['source']
    | 'model'
    | 'template_fallback'
    | 'computed_demo'
    | 'input_required';
  scheduling?: unknown;
  agentExecution?: unknown;
  evidence?: AgentAnswer['evidence'];
  task?: AgentAnswer['task'];
  taskCard?: NonNullable<ManagerChatResponse['task']>;
  taskQuestion?: ManagerChatQuestion;
  workspaceTaskId?: string;
  questionAnswered?: boolean;
  eventKey?: string;
  stale?: boolean;
  state: 'pending' | 'done' | 'error' | 'cancelled' | 'task_cancelled';
  error?: string;
  errorCategory?: string;
  retryable?: boolean;
  question?: string;
  focusItemId?: string | null;
  idempotencyKey?: string;
  request?: ManagerChatRequest;
}

export const MAX_STORED_MESSAGES = 100;

/** Task links survive transcript trimming; conversational text remains bounded. */
export function retainConversationMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  const retainedText = new Set(
    messages
      .filter((message) => !message.taskCard)
      .slice(-MAX_STORED_MESSAGES)
      .map((message) => message.id),
  );
  const lastCard = new Map<string, string>();
  for (const message of messages)
    if (message.taskCard) lastCard.set(message.taskCard.task_id, message.id);
  return messages.filter((message) =>
    message.taskCard
      ? lastCard.get(message.taskCard.task_id) === message.id
      : retainedText.has(message.id),
  );
}

export function conversationHistory(
  messages: ChatMessage[],
): ManagerChatRequest['history'] {
  const history = messages
    .filter(
      (message) =>
        message.state === 'done' && !message.stale && !message.taskCard,
    )
    .map((message) => ({
      role: message.role === 'user' ? ('user' as const) : ('manager' as const),
      text: (message.text ?? message.paragraphs?.join('\n\n') ?? '').slice(
        0,
        8000,
      ),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-20);
  while (new TextEncoder().encode(JSON.stringify(history)).byteLength > 28000)
    history.shift();
  return history;
}

export function questionIdentity(
  record: TaskRecord,
  questionId: string,
): ManagerChatQuestion {
  return {
    task_id: record.id,
    question_id: questionId,
    expected_objective_revision: record.objective_revision,
    expected_run_id: record.current_run_id,
    expected_generation: record.generation,
    expected_state_revision: record.state_revision,
  };
}

export function currentTaskQuestions(
  records: TaskRecord[],
): ManagerChatQuestion[] {
  return records
    .flatMap((record) =>
      record.questions
        .filter(
          (question) =>
            question.status === 'open' &&
            question.run_id === record.current_run_id &&
            question.objective_revision === record.objective_revision,
        )
        .map((question) => questionIdentity(record, question.id)),
    )
    .slice(-24);
}

export function taskProgress(record: TaskRecord): string {
  if (record.status === 'completed')
    return 'Completed. The result is available in the Manager workspace.';
  if (record.status === 'waiting')
    return 'Waiting for information. You can keep chatting.';
  if (record.status === 'paused')
    return 'Paused. Resume this task in the Manager workspace.';
  if (record.status === 'failed' || record.status === 'timed_out')
    return (
      record.error?.message ??
      'This task stopped. Open the Manager workspace for details.'
    );
  if (record.status === 'cancelled')
    return 'Cancelled. Saved work remains available in the Manager workspace.';
  const completed = record.assignments.filter(
    (assignment) => assignment.status === 'completed',
  ).length;
  return record.assignments.length
    ? `${completed} of ${record.assignments.length} assignments completed.`
    : 'The Manager is preparing this task.';
}

/** A task question has one stable transcript identity across polling and reloads. */
export function reconcileTaskMessages(
  messages: ChatMessage[],
  record: TaskRecord,
  seenEventKeys: ReadonlySet<string> = new Set(),
): ChatMessage[] {
  const taskUrl = `/api/tasks/${record.id}`;
  let next = messages.map((message) => {
    if (message.taskCard?.task_id === record.id)
      return {
        ...message,
        taskCard: { ...message.taskCard, summary: taskProgress(record) },
      };
    const question = message.taskQuestion;
    if (question?.task_id === record.id) {
      const current = record.questions.find(
        (item) => item.id === question.question_id,
      );
      const active =
        current?.status === 'open' &&
        current.run_id === record.current_run_id &&
        current.objective_revision === record.objective_revision;
      return {
        ...message,
        taskQuestion: questionIdentity(record, question.question_id),
        questionAnswered: !active,
      };
    }
    if (
      message.workspaceTaskId === record.id &&
      message.eventKey?.startsWith('result:')
    )
      return !message.stale &&
        (message.eventKey !==
          `result:${record.id}:${record.current_run_id}:${record.objective_revision}` ||
          record.result?.currency !== 'current')
        ? { ...message, stale: true }
        : message;
    const evidence = message.evidence;
    if (
      evidence &&
      evidence.taskUrl.endsWith(taskUrl) &&
      ((evidence.objectiveRevision ?? 1) < record.objective_revision ||
        (evidence.runId && evidence.runId !== record.current_run_id) ||
        record.result?.currency === 'stale')
    )
      return { ...message, stale: true };
    return message;
  });
  if (!next.some((message) => message.taskCard?.task_id === record.id))
    next.push({
      id: `task:${record.id}`,
      role: 'agents',
      at: record.created_at,
      state: 'done',
      taskCard: {
        task_id: record.id,
        title: record.original_request.objective.slice(0, 180),
        summary: taskProgress(record),
        status_url: taskUrl,
      },
    });
  const existing = new Set([
    ...seenEventKeys,
    ...next.map((message) => message.eventKey ?? message.id),
  ]);
  for (const question of record.questions) {
    if (
      question.status !== 'open' ||
      question.run_id !== record.current_run_id ||
      question.objective_revision !== record.objective_revision
    )
      continue;
    const key = `question:${record.id}:${question.id}`;
    if (existing.has(key)) continue;
    next.push({
      id: key,
      eventKey: key,
      role: 'agents',
      at: question.created_at,
      state: 'done',
      paragraphs: [question.question],
      taskQuestion: questionIdentity(record, question.id),
      questionAnswered: false,
    });
    existing.add(key);
  }
  if (record.status === 'completed' && record.result?.currency === 'current') {
    const key = `result:${record.id}:${record.current_run_id}:${record.objective_revision}`;
    if (!existing.has(key)) {
      const evidenceAlreadySaved = next.some(
        (message) =>
          message.evidence?.taskUrl.endsWith(taskUrl) &&
          message.evidence.objectiveRevision === record.objective_revision &&
          message.evidence.runId === record.current_run_id,
      );
      if (!evidenceAlreadySaved)
        next.push({
          id: key,
          eventKey: key,
          role: 'agents',
          at: record.updated_at,
          state: 'done',
          paragraphs: [
            'The task is complete. Open the Manager workspace to read its result.',
          ],
          workspaceTaskId: record.id,
        });
    }
  }
  next = retainConversationMessages(next);
  return JSON.stringify(next) === JSON.stringify(messages) ? messages : next;
}

/** Keep the exact original turn on retry; history and permission changes cannot change it. */
export function applyTurnResponse(
  messages: ChatMessage[],
  pendingId: string,
  response: ManagerChatResponse,
): ChatMessage[] {
  const duplicateTask =
    response.task &&
    messages.some(
      (message) =>
        message.id !== pendingId &&
        message.taskCard?.task_id === response.task?.task_id,
    );
  return messages.map((message) =>
    message.id === pendingId
      ? {
          ...message,
          state: 'done',
          paragraphs: response.paragraphs,
          citations: response.citations,
          taskCard: duplicateTask ? undefined : response.task,
          errorCategory: response.error?.category,
          retryable: response.error?.retryable,
        }
      : message.taskCard?.task_id === response.task?.task_id && response.task
        ? { ...message, taskCard: response.task }
        : message,
  );
}
