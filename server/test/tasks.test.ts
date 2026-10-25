import { describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '../../frontend/src/shared/types/tasks.ts';
import { Manager } from '../src/manager/manager.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { composeTask } from '../src/tasks/compose.ts';
import { TaskService } from '../src/tasks/tasks.ts';
import { KLANG } from './helpers.ts';

const waitForTask = (tasks: TaskService, id: string) =>
  new Promise<void>((resolve) => {
    tasks.subscribe(id, (event) => {
      if (event.type === 'result' || event.type === 'failed') resolve();
    });
  });

const frame = (question: string) =>
  new Manager().frame({ question, focusItemId: null }, [KLANG]);

describe('task reports', () => {
  it('keeps the request, computes no schedule and lists what is missing', () => {
    const framing = frame('Plan the crew schedule for Klang tomorrow');
    const report = composeTask({
      kind: 'scheduling',
      framing,
      items: [],
      nearby: new Map(),
      refreshNote: null,
    });
    expect(report.title).toBe('Outdoor work schedule: Klang');
    expect(report.blocks).toContainEqual(
      expect.objectContaining({ type: 'quote', text: framing.objective.text }),
    );
    expect(JSON.stringify(report.blocks)).toContain('No schedule was computed');
    expect(report.gaps[0]).toContain('No haze records');
    expect(report.review.status).toBe('not_reviewed');
    expect(report.provenance.model).toBeNull();
  });

  it('does not claim the haze caused a revenue drop', () => {
    const report = composeTask({
      kind: 'revenue_recovery',
      framing: frame('How can my Klang shop recover revenue lost to the haze?'),
      items: [],
      nearby: new Map(),
      refreshNote: null,
    });
    const text = JSON.stringify(report.blocks);
    expect(text).toContain('Haze readings alone do not prove the cause');
    expect(text).toContain('No damage figure or recovery plan was computed');
  });

  it('streams steps and blocks, then the result', async () => {
    const manager = new Manager();
    const tasks = new TaskService({
      manager,
      runtime: new Runtime(),
      freshItems: () => [],
      readingsNear: () => [],
      refresh: (_places, brief) => {
        expect(brief.objective.text).toBe('Plan the crew schedule for Klang');
        return Promise.resolve(null);
      },
    });
    const framing = frame('Plan the crew schedule for Klang');
    const link = tasks.start({ ...framing, kind: 'scheduling' });
    const events = await new Promise<TaskEvent[]>((resolve) => {
      const seen: TaskEvent[] = [];
      tasks.subscribe(link.taskId, (event) => {
        seen.push(event);
        if (event.type === 'result' || event.type === 'failed') resolve(seen);
      });
    });
    expect(events.map((e) => e.type)).toContain('block');
    expect(events.at(-1)?.type).toBe('result');
    expect(tasks.result(link.taskId)?.state).toBe('completed');
    expect(manager.assignments()[0]).toMatchObject({
      agent: 'hazeops',
      parentId: link.taskId,
      state: 'completed',
    });
  });

  it('records terminal failure without returning a completed report', async () => {
    const runtime = new Runtime();
    const tasks = new TaskService({
      manager: new Manager(),
      runtime,
      freshItems: () => [],
      readingsNear: () => [],
      refresh: () => Promise.reject(new Error('Source unavailable')),
    });
    const link = tasks.start({
      ...frame('Plan the crew schedule for Klang'),
      kind: 'scheduling',
    });
    await waitForTask(tasks, link.taskId);
    expect(tasks.result(link.taskId)).toBeNull();
    expect(tasks.isDone(link.taskId)).toBe(true);
    expect(tasks.status(link.taskId)).toEqual({
      taskId: link.taskId,
      state: 'failed',
      error: 'Source unavailable',
    });
    await vi.waitFor(() => expect(runtime.jobs()[0]?.state).toBe('failed'));
  });

  it('cancels a queued report immediately and never executes its refresh', async () => {
    const runtime = new Runtime();
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = runtime.admit('busy-a', 'busy', 1000, () => busy);
    const b = runtime.admit('busy-b', 'busy', 1000, () => busy);
    const refresh = vi.fn(() => Promise.resolve(null));
    const tasks = new TaskService({
      manager: new Manager(),
      runtime,
      freshItems: () => [],
      readingsNear: () => [],
      refresh,
    });
    const link = tasks.start({
      ...frame('Plan the crew schedule for Klang'),
      kind: 'scheduling',
    });
    expect(tasks.cancel(link.taskId)).toBe(true);
    expect(tasks.status(link.taskId)?.state).toBe('cancelled');
    expect(tasks.isDone(link.taskId)).toBe(true);
    expect(tasks.result(link.taskId)).toBeNull();
    release();
    await Promise.all([a.promise, b.promise]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('distinguishes a deadline from cancellation', async () => {
    class FastRuntime extends Runtime {
      override admit<T>(
        key: string,
        label: string,
        _deadlineMs: number,
        work: (signal: AbortSignal) => Promise<T>,
      ) {
        return super.admit(key, label, 20, work);
      }
    }
    const tasks = new TaskService({
      manager: new Manager(),
      runtime: new FastRuntime(),
      freshItems: () => [],
      readingsNear: () => [],
      refresh: (_places, _brief, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('aborted'),
              ),
            {
              once: true,
            },
          );
        }),
    });
    const link = tasks.start({
      ...frame('Plan the crew schedule for Klang'),
      kind: 'scheduling',
    });
    await waitForTask(tasks, link.taskId);
    expect(tasks.result(link.taskId)).toBeNull();
    expect(tasks.status(link.taskId)).toEqual({
      taskId: link.taskId,
      state: 'timed_out',
      error: 'The task ran out of time.',
    });
  });

  it('times out a report whose deadline expires in the queue without doing source work', async () => {
    class FastRuntime extends Runtime {
      override admit<T>(
        key: string,
        label: string,
        deadlineMs: number,
        work: (signal: AbortSignal) => Promise<T>,
      ) {
        return super.admit(
          key,
          label,
          key.startsWith('task:') ? 1 : deadlineMs,
          work,
        );
      }
    }
    const runtime = new FastRuntime();
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = runtime.admit('busy-a', 'busy', 1000, () => busy);
    const b = runtime.admit('busy-b', 'busy', 1000, () => busy);
    const refresh = vi.fn(() => Promise.resolve(null));
    const tasks = new TaskService({
      manager: new Manager(),
      runtime,
      freshItems: () => [],
      readingsNear: () => [],
      refresh,
    });
    const link = tasks.start({
      ...frame('Plan a crew schedule for Klang'),
      kind: 'scheduling',
    });
    // Advance the clock while the job remains queued, without a timing-sensitive sleep.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
    release();
    await Promise.all([a.promise, b.promise]);
    await waitForTask(tasks, link.taskId);
    clock.mockRestore();
    expect(tasks.status(link.taskId)?.state).toBe('timed_out');
    expect(tasks.isDone(link.taskId)).toBe(true);
    expect(tasks.result(link.taskId)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(runtime.jobs().find((j) => j.key.startsWith('task:'))?.state).toBe(
      'timed_out',
    );
  });
});
