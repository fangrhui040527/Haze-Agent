import { describe, expect, it, vi } from 'vitest';
import type {
  AgentAnswer,
  AgentTaskHandle,
} from '../../shared/types/agents.ts';
import {
  artifactId,
  fixtureResult,
  fixtureTask,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { AgentTaskCancelledError } from '../../services/agents/AgentService.ts';
import { acceptTaskReadback } from './taskReadback.ts';
import { awaitCurrentTaskAnswer } from './awaitCurrentTaskAnswer.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function handle(): AgentTaskHandle {
  return {
    id: taskId,
    schemaVersion: 'haze.task.v3',
    taskUrl: `/api/tasks/${taskId}`,
    status: 'completed',
    record: fixtureTask(),
  };
}

function answer(task: AgentTaskHandle, text: string): AgentAnswer {
  return {
    runId: task.record!.current_run_id,
    paragraphs: [text],
    citations: [],
    source: 'evidence_fixture',
    fictional: true,
    durationMs: 1,
    evidence: {
      taskUrl: task.taskUrl,
      result: { ...fixtureResult(), answer: text },
      objectiveRevision: task.record!.objective_revision,
      runId: task.record!.current_run_id,
    },
  };
}

function continued(): AgentTaskHandle {
  const task = handle();
  task.status = 'running';
  task.record!.status = 'running';
  task.record!.current_run_id = artifactId;
  task.record!.generation = 2;
  task.record!.state_revision = 1;
  task.record!.runs.push({ ...task.record!.runs[0], id: artifactId });
  delete task.record!.result;
  return task;
}

describe('answers arriving after a task change', () => {
  it('returns an unchanged completion without opening another watcher', async () => {
    const current = handle();
    const completed = answer(current, 'Current answer');
    const watch = vi.fn();
    await expect(
      awaitCurrentTaskAnswer({
        signal: new AbortController().signal,
        currentTask: () => current,
        onTask: () => {},
        execute: (onTask) => {
          onTask(current);
          return Promise.resolve(completed);
        },
        watch,
      }),
    ).resolves.toBe(completed);
    expect(watch).not.toHaveBeenCalled();
  });

  it('preserves an unchanged observation failure instead of retrying indefinitely', async () => {
    const current = handle();
    const watch = vi.fn();
    await expect(
      awaitCurrentTaskAnswer({
        signal: new AbortController().signal,
        currentTask: () => current,
        onTask: () => {},
        execute: () => Promise.reject(new Error('Transport unavailable')),
        watch,
      }),
    ).rejects.toThrow('Transport unavailable');
    expect(watch).not.toHaveBeenCalled();
  });

  it('waits for the continued run instead of publishing its predecessor answer', async () => {
    const old = handle();
    let current = old;
    const oldAnswer = deferred<AgentAnswer>();
    const freshAnswer = deferred<AgentAnswer>();
    const watching = deferred<void>();
    const controller = new AbortController();
    const accept = (task: AgentTaskHandle) => {
      if (acceptTaskReadback(current, task)) current = task;
    };
    let published: AgentAnswer | null = null;
    const watch = vi.fn(
      async (id: string, onTask: (task: AgentTaskHandle) => void) => {
        expect(id).toBe(taskId);
        expect(controller.signal.aborted).toBe(false);
        watching.resolve();
        const result = await freshAnswer.promise;
        const completed = {
          ...current,
          record: { ...current.record!, status: 'completed' as const },
        };
        onTask(completed);
        return result;
      },
    );
    const result = awaitCurrentTaskAnswer({
      signal: controller.signal,
      currentTask: () => current,
      onTask: accept,
      onAnswer: (value) => {
        published = value;
      },
      execute: async (onTask) => {
        const result = await oldAnswer.promise;
        onTask(old); // This delayed completion must be rejected by readback guards.
        return result;
      },
      watch,
    });
    current = continued();
    oldAnswer.resolve(answer(old, 'Old answer'));
    await watching.promise;
    expect(published).toBeNull();
    expect(current.record!.status).toBe('running');
    expect(watch).toHaveBeenCalledTimes(1);
    freshAnswer.resolve(answer(current, 'Current answer'));
    await expect(result).resolves.toMatchObject({
      paragraphs: ['Current answer'],
    });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('also rejects an old answer after a same-run generation change', async () => {
    const old = handle();
    let current = old;
    const delayed = deferred<AgentAnswer>();
    const watch = vi.fn(
      (_id: string, onTask: (task: AgentTaskHandle) => void) => {
        const finished = {
          ...current,
          record: { ...current.record!, status: 'completed' as const },
        };
        onTask(finished);
        return Promise.resolve(answer(finished, 'Revised answer'));
      },
    );
    const pending = awaitCurrentTaskAnswer({
      signal: new AbortController().signal,
      currentTask: () => current,
      onTask: (task) => {
        if (acceptTaskReadback(current, task)) current = task;
      },
      execute: async (onTask) => {
        const result = await delayed.promise;
        onTask(old);
        return result;
      },
      watch,
    });
    current = handle();
    current.record!.generation = 2;
    current.record!.state_revision = 3;
    current.record!.status = 'running';
    delayed.resolve(answer(old, 'Old answer'));
    await expect(pending).resolves.toMatchObject({
      paragraphs: ['Revised answer'],
    });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'failed', 'timed_out'] as const)(
    'surfaces the newer saved %s status without restarting its watcher',
    async (status) => {
      const old = handle();
      let current = old;
      const delayed = deferred<AgentAnswer>();
      const watch = vi.fn();
      const pending = awaitCurrentTaskAnswer({
        signal: new AbortController().signal,
        currentTask: () => current,
        onTask: () => {},
        execute: () => delayed.promise,
        watch,
      });
      current = continued();
      current.record!.status = status;
      current.record!.error = {
        code: 'LATEST_RUN_FAILED',
        message: 'The current run ended.',
      };
      delayed.resolve(answer(old, 'Old answer'));
      if (status === 'cancelled')
        await expect(pending).rejects.toBeInstanceOf(AgentTaskCancelledError);
      else await expect(pending).rejects.toThrow('The current run ended.');
      expect(watch).not.toHaveBeenCalled();
    },
  );

  it('keeps aborting the same observation effective while waiting for a fresh answer', async () => {
    const old = handle();
    let current = old;
    const delayed = deferred<AgentAnswer>();
    const controller = new AbortController();
    const watch = vi.fn(() => {
      controller.abort();
      return Promise.resolve(answer(current, 'Must not publish'));
    });
    const pending = awaitCurrentTaskAnswer({
      signal: controller.signal,
      currentTask: () => current,
      onTask: () => {},
      execute: () => delayed.promise,
      watch,
    });
    current = continued();
    delayed.resolve(answer(old, 'Old answer'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(watch).toHaveBeenCalledTimes(1);
  });
});
