import type {
  HazeItem,
  Location,
} from '../../../frontend/src/shared/types/domain.ts';
import type {
  TaskEvent,
  TaskKind,
  TaskLink,
  TaskResult,
  TaskState,
  TaskStep,
} from '../../../frontend/src/shared/types/tasks.ts';
import type { Brief, Framing, Manager } from '../manager/manager.ts';
import { NEARBY_SENSOR_KM, type NearbyReading } from '../runs/answer.ts';
import type { Runtime } from '../runtime/runtime.ts';
import { composeTask, taskTitle } from './compose.ts';

/**
 * Task reports (v0.14 §7 and §16). The Manager opens one for a scheduling or revenue
 * recovery request. Each task is one Runtime job; its steps and report blocks are
 * streamed as TaskEvents so the screen can show the report being written.
 */

const TASK_DEADLINE_MS = 120_000;
const TASK_HISTORY = 50;

interface Task {
  id: string;
  kind: TaskKind;
  framing: Framing;
  events: TaskEvent[];
  result: TaskResult | null;
  state: TaskState;
  error: string | null;
  done: boolean;
  jobId: string | null;
  listeners: Set<(event: TaskEvent) => void>;
}

export interface TaskDependencies {
  manager: Manager;
  runtime: Runtime;
  freshItems: () => HazeItem[];
  readingsNear: (
    place: Location,
    km: number,
    items: HazeItem[],
  ) => NearbyReading[];
  /** HazeOps refresh of stale sources for the brief's places (runs/runs.ts). */
  refresh: (
    places: Location[],
    brief: Brief,
    signal: AbortSignal,
  ) => Promise<string | null>;
}

export class TaskService {
  private readonly tasks = new Map<string, Task>();
  private readonly deps: TaskDependencies;

  constructor(deps: TaskDependencies) {
    this.deps = deps;
  }

  /** Starts a task for a framing whose kind is a task kind. */
  start(framing: Framing & { kind: TaskKind }): TaskLink {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const task: Task = {
      id,
      kind: framing.kind,
      framing,
      events: [],
      result: null,
      state: 'running',
      error: null,
      done: false,
      jobId: null,
      listeners: new Set(),
    };
    this.tasks.set(id, task);
    for (const old of [...this.tasks.keys()].slice(
      0,
      Math.max(0, this.tasks.size - TASK_HISTORY),
    )) {
      this.tasks.delete(old);
    }
    const { jobId, promise } = this.deps.runtime.admit(
      `task:${id}`,
      `Task ${id} (${framing.kind})`,
      TASK_DEADLINE_MS,
      (signal) => this.execute(task, signal),
    );
    task.jobId = jobId;
    // A job whose deadline elapsed in the queue never calls execute().
    void promise.catch((error: unknown) => {
      const timedOut =
        error instanceof DOMException && error.name === 'TimeoutError';
      this.fail(
        task,
        timedOut ? 'timed_out' : 'failed',
        timedOut
          ? 'The task ran out of time.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    });
    return {
      taskId: id,
      kind: framing.kind,
      title: taskTitle(framing.kind, framing),
    };
  }

  exists(id: string): boolean {
    return this.tasks.has(id);
  }

  result(id: string): TaskResult | null {
    return this.tasks.get(id)?.result ?? null;
  }

  /** Terminal errors are status records, never fabricated successful reports. */
  status(
    id: string,
  ): { taskId: string; state: TaskState; error: string | null } | null {
    const task = this.tasks.get(id);
    return task
      ? { taskId: task.id, state: task.state, error: task.error }
      : null;
  }

  isDone(id: string): boolean {
    return this.tasks.get(id)?.done ?? true;
  }

  /** Replays earlier events, then streams live ones. Returns an unsubscribe function. */
  subscribe(id: string, listener: (event: TaskEvent) => void): () => void {
    const task = this.tasks.get(id);
    if (!task) return () => {};
    for (const event of task.events) listener(event);
    if (task.done) return () => {};
    task.listeners.add(listener);
    return () => task.listeners.delete(listener);
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task?.jobId || task.done) return false;
    if (!this.deps.runtime.cancel(task.jobId)) return false;
    this.fail(task, 'cancelled', 'The task was cancelled.');
    return true;
  }

  private fail(
    task: Task,
    state: 'failed' | 'cancelled' | 'timed_out',
    error: string,
  ): void {
    if (task.done) return;
    task.state = state;
    task.error = error;
    this.push(task, { type: 'failed', error });
    task.done = true;
    task.listeners.clear();
  }

  private push(task: Task, event: TaskEvent): void {
    task.events.push(event);
    for (const listener of task.listeners) listener(event);
  }

  private step(task: Task, step: TaskStep): void {
    this.push(task, { type: 'step', step });
  }

  private async execute(task: Task, signal: AbortSignal): Promise<void> {
    if (task.done) return;
    const { framing } = task;
    const { places } = framing;
    const names = places.map((p) => p.name).join(' and ') || 'the request';
    const check = () => {
      if (signal.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('aborted');
    };
    try {
      check();
      this.step(task, {
        id: 'frame',
        agent: 'manager',
        label: 'Manager read your request',
        state: 'done',
      });

      this.step(task, {
        id: 'refresh',
        agent: 'hazeops',
        label: `HazeOps is checking the data for ${names}`,
        state: 'running',
      });
      const brief = this.deps.manager.assign(
        framing,
        task.id,
        'hazeops',
        `Fresh records for ${names}`,
      );
      let refreshNote: string | null;
      try {
        refreshNote = await this.deps.refresh(places, brief, signal);
        this.deps.manager.finish(
          brief.assignmentId,
          'completed',
          refreshNote ?? 'records fresh enough',
        );
      } catch (error) {
        this.deps.manager.finish(brief.assignmentId, 'failed', String(error));
        throw error;
      }
      this.step(task, {
        id: 'refresh',
        agent: 'hazeops',
        label: refreshNote ?? 'HazeOps: records are fresh enough',
        state: 'done',
      });
      check();

      this.step(task, {
        id: 'read',
        agent: 'worldmodel',
        label: 'World Model is reading the records',
        state: 'running',
      });
      const items = this.deps.freshItems();
      const nearby = new Map(
        places.map((p) => [
          p.id,
          this.deps.readingsNear(p, NEARBY_SENSOR_KM, items),
        ]),
      );
      this.step(task, {
        id: 'read',
        agent: 'worldmodel',
        label: 'World Model returned the records',
        state: 'done',
      });
      check();

      this.step(task, {
        id: 'write',
        agent: 'manager',
        label: 'Manager is writing the report',
        state: 'running',
      });
      const composed = composeTask({
        kind: task.kind,
        framing,
        items,
        nearby,
        refreshNote,
      });
      for (const block of composed.blocks) {
        this.push(task, { type: 'block', block });
      }
      this.step(task, {
        id: 'write',
        agent: 'manager',
        label: 'Report ready',
        state: 'done',
      });
      task.result = { ...composed, taskId: task.id, state: 'completed' };
      task.state = 'completed';
      this.push(task, { type: 'result', result: task.result });
    } catch (error) {
      const timedOut =
        signal.reason instanceof DOMException &&
        signal.reason.name === 'TimeoutError';
      const state = signal.aborted
        ? timedOut
          ? 'timed_out'
          : 'cancelled'
        : 'failed';
      const message = signal.aborted
        ? timedOut
          ? 'The task ran out of time.'
          : 'The task was cancelled.'
        : error instanceof Error
          ? error.message
          : String(error);
      this.fail(task, state, message);
      throw error;
    } finally {
      task.done = true;
      task.listeners.clear();
    }
  }
}
