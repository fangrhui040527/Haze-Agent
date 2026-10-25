import { describe, expect, it, vi } from 'vitest';
import type { HazeOps } from '../src/hazeops/hazeops.ts';
import { Manager } from '../src/manager/manager.ts';
import type { ChatMemory } from '../src/memory/memory.ts';
import { RunService } from '../src/runs/runs.ts';
import { Runtime } from '../src/runtime/runtime.ts';
import { TaskService } from '../src/tasks/tasks.ts';
import { KLANG } from './helpers.ts';

describe('coordinator refresh scheduling', () => {
  it('refreshes while both report slots are occupied, coalescing the same watcher', async () => {
    const runtime = new Runtime();
    const watcherRuntime = new Runtime();
    let release!: () => void;
    const fetched = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runWatcher = vi.fn(async () => {
      await fetched;
      return { outcome: 'ok' };
    });
    const hazeops = {
      watcherForSource: () => 'test-watcher',
      watchers: () => [
        { spec: { id: 'test-watcher' }, state: { lastAttemptAt: null } },
      ],
      runWatcher,
    } as unknown as HazeOps;
    const manager = new Manager();
    const runs = new RunService({
      runtime,
      watcherRuntime,
      hazeops,
      manager,
      memory: {} as ChatMemory,
      snapshot: () => ({ items: [], locations: [KLANG] }),
      freshItems: () => [],
      readingsNear: () => [],
      startTask: () => {
        throw new Error('not used');
      },
    });
    const tasks = new TaskService({
      runtime,
      manager,
      freshItems: () => [],
      readingsNear: () => [],
      refresh: (places, brief, signal) =>
        runs.refreshIfStale(places, brief, signal),
    });
    const framing = manager.frame(
      { question: 'Plan a crew schedule for Klang', focusItemId: null },
      [KLANG],
    );
    const a = tasks.start({ ...framing, kind: 'scheduling' });
    const b = tasks.start({ ...framing, kind: 'scheduling' });
    // Before resolving any source work, both parents and their child watcher are running.
    expect(runtime.jobs().filter((j) => j.state === 'running')).toHaveLength(2);
    expect(watcherRuntime.jobs()).toMatchObject([
      { state: 'running', coalesced: 1 },
    ]);
    expect(runWatcher).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => {
      expect(tasks.result(a.taskId)?.state).toBe('completed');
      expect(tasks.result(b.taskId)?.state).toBe('completed');
    });
    expect(JSON.stringify(tasks.result(a.taskId))).not.toContain(
      'did not finish within',
    );
  });
});
