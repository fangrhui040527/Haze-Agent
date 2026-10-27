import { describe, expect, it } from 'vitest';
import type { ManagerChatResponse } from '../../../../app/contracts/manager-chat.ts';
import {
  fixtureTask,
  taskId,
  runId,
  at,
} from '../../services/agents/testFixtures.ts';
import {
  applyTurnResponse,
  conversationHistory,
  currentTaskQuestions,
  reconcileTaskMessages,
  retainConversationMessages,
  type ChatMessage,
} from './conversationState.ts';

function waitingTask() {
  const task = fixtureTask();
  task.status = 'waiting';
  delete task.result;
  task.questions = [
    {
      id: runId,
      task_id: taskId,
      run_id: runId,
      objective_revision: 1,
      question: 'Which place should I investigate?',
      kind: 'human',
      status: 'open',
      created_at: at,
    },
  ];
  return task;
}

describe('Manager transcript reconciliation', () => {
  it('keeps Clear chat empty after a detached restored task delivers again, including reload', () => {
    const oldTask = fixtureTask();
    const oldTranscript = reconcileTaskMessages([], oldTask);
    expect(oldTranscript.some((message) => message.taskCard)).toBe(true);
    const cleared: ChatMessage[] = [];
    // Clear persists detached-restore permission as false before clearing text.
    const allowDetachedRestore = JSON.parse(JSON.stringify(false)) as boolean;
    expect(
      reconcileTaskMessages(cleared, oldTask, new Set(), allowDetachedRestore),
    ).toBe(cleared);
    const reloaded = JSON.parse(JSON.stringify(cleared)) as ChatMessage[];
    expect(
      reconcileTaskMessages(reloaded, oldTask, new Set(), allowDetachedRestore),
    ).toBe(reloaded);
    const pending: ChatMessage = {
      id: 'next-turn',
      role: 'agents',
      state: 'pending',
      at,
    };
    const admitted = applyTurnResponse([pending], 'next-turn', {
      schema_version: 'haze.manager.chat.response.v1',
      kind: 'task_admitted',
      paragraphs: ['New task started.'],
      citations: [],
      task: {
        task_id: oldTask.id,
        title: 'Explicitly selected task',
        summary: 'Queued.',
        status_url: `/api/tasks/${oldTask.id}`,
      },
    });
    expect(
      reconcileTaskMessages(admitted, oldTask, new Set(), false).some(
        (message) => message.workspaceTaskId === oldTask.id,
      ),
    ).toBe(true);
  });
  it('retains compact task access and never republishes evicted questions or results after reload', () => {
    const task = waitingTask();
    const initial = reconcileTaskMessages([], task);
    const seen = new Set(
      initial.flatMap((message) =>
        message.eventKey ? [message.eventKey] : [],
      ),
    );
    const chatter: ChatMessage[] = Array.from({ length: 140 }, (_, index) => ({
      id: `chat-${index}`,
      role: 'user',
      state: 'done',
      at,
      text: 'A later question.',
    }));
    const trimmed = retainConversationMessages([...initial, ...chatter]);
    expect(trimmed.filter((message) => message.taskCard)).toHaveLength(1);
    expect(trimmed.filter((message) => !message.taskCard)).toHaveLength(100);
    expect(trimmed.some((message) => message.taskQuestion)).toBe(false);
    const restored = JSON.parse(JSON.stringify(trimmed)) as ChatMessage[];
    expect(reconcileTaskMessages(restored, task, seen)).toBe(restored);
    const complete = fixtureTask();
    const completed = reconcileTaskMessages(restored, complete, seen);
    for (const message of completed)
      if (message.eventKey) seen.add(message.eventKey);
    const later = retainConversationMessages([
      ...completed,
      ...chatter.map((message) => ({ ...message, id: `later-${message.id}` })),
    ]);
    expect(
      later.some((message) => message.eventKey?.startsWith('result:')),
    ).toBe(false);
    expect(reconcileTaskMessages(later, complete, new Set([...seen]))).toBe(
      later,
    );
    expect(later.filter((message) => message.taskCard)).toHaveLength(1);
  });
  it('deduplicates task questions and task cards across repeated polls and reloads', () => {
    const task = waitingTask();
    const first = reconcileTaskMessages([], task);
    const restored = JSON.parse(JSON.stringify(first)) as ChatMessage[];
    const polled = reconcileTaskMessages(restored, task);
    expect(polled).toBe(restored);
    expect(polled.filter((message) => message.taskCard)).toHaveLength(1);
    expect(polled.filter((message) => message.taskQuestion)).toHaveLength(1);
    expect(currentTaskQuestions([task])).toEqual([
      {
        task_id: taskId,
        question_id: runId,
        expected_objective_revision: 1,
        expected_run_id: runId,
        expected_generation: task.generation,
        expected_state_revision: task.state_revision,
      },
    ]);
  });
  it('closes obsolete question affordances and excludes them from routing associations', () => {
    const task = waitingTask();
    const first = reconcileTaskMessages([], task);
    task.objective_revision = 2;
    task.state_revision++;
    const revised = reconcileTaskMessages(first, task);
    expect(
      revised.find((message) => message.taskQuestion)?.questionAnswered,
    ).toBe(true);
    expect(currentTaskQuestions([task])).toEqual([]);
  });
  it('deduplicates current completion notices and labels earlier revisions historical', () => {
    const task = fixtureTask();
    const first = reconcileTaskMessages([], task);
    expect(
      first.filter((message) => message.eventKey?.startsWith('result:')),
    ).toHaveLength(1);
    expect(reconcileTaskMessages(first, task)).toBe(first);
    task.objective_revision++;
    task.result!.currency = 'stale';
    task.status = 'running';
    const revised = reconcileTaskMessages(first, task);
    expect(
      revised.find((message) => message.eventKey?.startsWith('result:'))?.stale,
    ).toBe(true);
    expect(
      revised.filter((message) => message.eventKey?.startsWith('result:')),
    ).toHaveLength(1);
  });
  it('adds one card for repeated task admission and task update delivery', () => {
    const response: ManagerChatResponse = {
      schema_version: 'haze.manager.chat.response.v1',
      kind: 'task_admitted',
      paragraphs: ['I started this investigation.'],
      citations: [],
      task: {
        task_id: taskId,
        title: 'Investigation',
        summary: 'Queued.',
        status_url: `/api/tasks/${taskId}`,
      },
    };
    const pending = (id: string): ChatMessage => ({
      id,
      role: 'agents',
      state: 'pending',
      at,
    });
    let messages = applyTurnResponse([pending('one')], 'one', response);
    messages = applyTurnResponse(
      [...messages, pending('retry')],
      'retry',
      response,
    );
    expect(messages.filter((message) => message.taskCard)).toHaveLength(1);
    const updated = applyTurnResponse(
      [...messages, pending('answer')],
      'answer',
      {
        ...response,
        kind: 'task_updated',
        task: { ...response.task!, summary: 'Answer accepted.' },
      },
    );
    expect(updated.filter((message) => message.taskCard)).toHaveLength(1);
    expect(updated.find((message) => message.taskCard)?.taskCard?.summary).toBe(
      'Answer accepted.',
    );
  });
  it('bounds model history by count and bytes, omitting stale and unfinished messages', () => {
    const messages: ChatMessage[] = Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? 'agents' : 'user',
      state: 'done',
      at,
      text: '多'.repeat(7000),
    }));
    messages.push({
      id: 'pending',
      role: 'agents',
      state: 'pending',
      at,
      text: 'not finished',
    });
    messages.push({
      id: 'stale',
      role: 'agents',
      state: 'done',
      stale: true,
      at,
      text: 'stale answer',
    });
    const history = conversationHistory(messages);
    expect(history.length).toBeLessThanOrEqual(20);
    expect(
      new TextEncoder().encode(JSON.stringify(history)).byteLength,
    ).toBeLessThanOrEqual(28000);
    expect(
      history.some((message) =>
        /not finished|stale answer/u.test(message.text),
      ),
    ).toBe(false);
  });
});
