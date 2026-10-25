import type {
  AgentAnswer,
  AgentEvent,
  AgentId,
  AskRequest,
} from '../../../frontend/src/shared/types/agents.ts';
import type {
  HazeItem,
  Location,
} from '../../../frontend/src/shared/types/domain.ts';
import type { HazeOps } from '../hazeops/hazeops.ts';
import type { TaskLink } from '../../../frontend/src/shared/types/tasks.ts';
import type { Brief, Framing, Manager } from '../manager/manager.ts';
import type { Runtime } from '../runtime/runtime.ts';
import type { ChatMemory } from '../memory/memory.ts';
import { FALLBACK_LOCATION_ID } from '../locations.ts';
import {
  composeAnswer,
  NEARBY_SENSOR_KM,
  type NearbyReading,
} from './answer.ts';

/**
 * Chat runs. The Manager frames each question and records an assignment for every
 * agent that works on it; the Runtime runs it as one bounded job. Each step emits
 * AgentEvents for the chat, status line and pixel office. Only agents that really run emit
 * events: Manager, HazeOps, World Model and H-Mem. EvidenceCritic and WorkerShield are
 * not connected, so they emit nothing and the office shows them idle.
 */

const CHAT_RUN_DEADLINE_MS = 90_000;
const RETRIEVAL_BUDGET_MS = 45_000;
const WATCHER_DEADLINE_MS = 120_000;
const MIN_REFRESH_GAP_MS = 5 * 60_000;
const RUN_HISTORY = 100;

type Emittable = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'runId' | 'at'>
    : never
  : never;

export type RunMessage =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'answer'; answer: AgentAnswer };

interface Run {
  id: string;
  request: AskRequest;
  createdAt: number;
  messages: RunMessage[];
  done: boolean;
  jobId: string | null;
  memoryId: string | null;
  listeners: Set<(message: RunMessage) => void>;
}

export interface RunDependencies {
  hazeops: HazeOps;
  manager: Manager;
  runtime: Runtime;
  /** Separate bounded pool: coordinators must not occupy the slots their refreshes need. */
  watcherRuntime: Runtime;
  memory: ChatMemory;
  snapshot: () => { items: HazeItem[]; locations: Location[] };
  freshItems: () => HazeItem[];
  /** Opens a task report for a scheduling or revenue recovery request (tasks/tasks.ts). */
  startTask: (framing: Framing & { kind: TaskLink['kind'] }) => TaskLink;
  /** Sensor readings within `km` of a place, whichever city they are filed under. */
  readingsNear: (
    place: Location,
    km: number,
    items: HazeItem[],
  ) => NearbyReading[];
}

export class RunService {
  private readonly runs = new Map<string, Run>();
  private readonly deps: RunDependencies;

  constructor(deps: RunDependencies) {
    this.deps = deps;
  }

  start(request: AskRequest): string {
    const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const run: Run = {
      id,
      request,
      createdAt: Date.now(),
      messages: [],
      done: false,
      jobId: null,
      memoryId: null,
      listeners: new Set(),
    };
    this.runs.set(id, run);
    for (const old of [...this.runs.keys()].slice(
      0,
      Math.max(0, this.runs.size - RUN_HISTORY),
    )) {
      this.runs.delete(old);
    }
    const { jobId, promise } = this.deps.runtime.admit(
      `run:${id}`,
      `Chat run ${id}`,
      CHAT_RUN_DEADLINE_MS,
      (signal) => this.execute(run, signal),
    );
    run.jobId = jobId;
    void promise.catch((error: unknown) => {
      if (run.done) return;
      const message = error instanceof Error ? error.message : String(error);
      this.emit(run, {
        type: 'run_failed',
        agent: 'manager',
        error: message,
        retryable: true,
        message,
      });
      this.finish(run);
    });
    return id;
  }

  exists(id: string): boolean {
    return this.runs.has(id);
  }

  /** Replays earlier messages, then streams live ones. Returns an unsubscribe function. */
  subscribe(id: string, listener: (message: RunMessage) => void): () => void {
    const run = this.runs.get(id);
    if (!run) return () => {};
    for (const message of run.messages) listener(message);
    if (run.done) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  isDone(id: string): boolean {
    return this.runs.get(id)?.done ?? true;
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run?.jobId || run.done) return false;
    return this.deps.runtime.cancel(run.jobId);
  }

  memoryIdFor(id: string): string | null {
    return this.runs.get(id)?.memoryId ?? null;
  }

  private push(run: Run, message: RunMessage): void {
    run.messages.push(message);
    for (const listener of run.listeners) listener(message);
  }

  private emit(run: Run, event: Emittable): void {
    this.push(run, {
      kind: 'event',
      event: { ...event, runId: run.id, at: new Date().toISOString() },
    });
  }

  private finish(run: Run): void {
    run.done = true;
    run.listeners.clear();
  }

  private async execute(run: Run, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let current: AgentId = 'manager';
    const check = () => {
      if (signal.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('aborted');
    };
    try {
      this.emit(run, {
        type: 'run_started',
        message: 'Manager received your question.',
      });
      this.emit(run, {
        type: 'agent_thinking',
        agent: 'manager',
        message: 'Manager is reading your question…',
      });

      const { items: snapshotItems, locations } = this.deps.snapshot();
      const focus = run.request.focusItemId
        ? snapshotItems.find((i) => i.id === run.request.focusItemId)
        : undefined;
      const framing = this.deps.manager.frame(run.request, locations, {
        focusLocationId: focus?.locationId,
        fallbackLocationId: FALLBACK_LOCATION_ID,
      });
      const { places, defaulted, intent } = framing;
      const names =
        places.map((p) => p.name).join(' and ') || 'the configured locations';

      if (framing.kind !== 'general') {
        this.openTask(run, { ...framing, kind: framing.kind }, started);
        return;
      }

      this.emit(run, {
        type: 'agent_moving',
        agent: 'manager',
        to: 'office',
        message: 'Manager is briefing the team…',
      });
      check();

      // HazeOps: make sure the records for these places are fresh enough.
      current = 'hazeops';
      this.emit(run, {
        type: 'handoff',
        from: 'manager',
        to: ['hazeops'],
        payloadLabel: 'task',
        message: `HazeOps is checking how fresh the data for ${names} is…`,
      });
      this.emit(run, {
        type: 'agent_working',
        agent: 'hazeops',
        message: `HazeOps is checking how fresh the data for ${names} is…`,
      });
      const brief = this.deps.manager.assign(
        framing,
        run.id,
        'hazeops',
        `Fresh records for ${names}`,
      );
      const refreshNote = await this.refreshIfStale(
        places,
        brief,
        signal,
      ).catch((error: unknown) => {
        this.deps.manager.finish(brief.assignmentId, 'failed', String(error));
        throw error;
      });
      this.deps.manager.finish(
        brief.assignmentId,
        'completed',
        refreshNote ?? 'records fresh enough',
      );
      check();
      this.emit(run, {
        type: 'agent_completed',
        agent: 'hazeops',
        message:
          refreshNote ??
          'HazeOps: records are fresh enough; nothing re-fetched.',
      });

      // World Model and H-Mem: read records and similar earlier questions.
      current = 'worldmodel';
      this.emit(run, {
        type: 'handoff',
        from: 'hazeops',
        to: ['worldmodel', 'hmem'],
        payloadLabel: 'records',
        message: 'World Model and H-Mem are looking up records…',
      });
      const items = this.deps.freshItems();
      const placeIds = new Set(places.map((p) => p.id));
      const nearby = new Map(
        places.map((p) => [
          p.id,
          this.deps.readingsNear(p, NEARBY_SENSOR_KM, items),
        ]),
      );
      const relevantIds = new Set([
        ...items.filter((i) => placeIds.has(i.locationId)).map((i) => i.id),
        ...[...nearby.values()].flat().map((n) => n.item.id),
      ]);
      const relevant = items.filter((i) => relevantIds.has(i.id));
      this.emit(run, {
        type: 'agent_working',
        agent: 'worldmodel',
        message: `World Model is reading ${relevant.length} record(s) for ${names}…`,
      });
      this.emit(run, {
        type: 'agent_working',
        agent: 'hmem',
        message: 'H-Mem is looking for similar earlier questions…',
      });
      current = 'hmem';
      const recalled = this.deps.memory.recall(run.request.question);
      this.emit(run, {
        type: 'agent_completed',
        agent: 'worldmodel',
        message: `World Model returned ${relevant.length} record(s).`,
      });
      this.emit(run, {
        type: 'agent_completed',
        agent: 'hmem',
        message: recalled.length
          ? `H-Mem recalled ${recalled.length} earlier exchange(s).`
          : 'H-Mem found nothing similar.',
      });
      check();

      current = 'manager';
      this.emit(run, {
        type: 'handoff',
        from: 'worldmodel',
        to: ['manager'],
        payloadLabel: 'records',
        message: 'Manager is preparing the answer…',
      });
      this.emit(run, {
        type: 'agent_working',
        agent: 'manager',
        message:
          'Manager is filling in the answer template (no AI model connected)…',
      });
      const composed = composeAnswer({
        question: run.request.question,
        intent,
        places,
        defaulted,
        items,
        nearby,
        recalled,
        refreshNote,
      });
      run.memoryId = this.deps.memory.remember({
        runId: run.id,
        question: run.request.question,
        answerSummary: composed.summary,
        locationIds: places.map((p) => p.id),
        citedItemIds: composed.citations
          .map((c) => c.itemId)
          .filter((v): v is string => !!v),
      });
      this.emit(run, {
        type: 'agent_moving',
        agent: 'manager',
        to: 'reception',
        message: 'Manager is bringing the answer back…',
      });
      this.emit(run, { type: 'run_completed', message: 'Answer ready.' });
      this.push(run, {
        kind: 'answer',
        answer: {
          runId: run.id,
          paragraphs: composed.paragraphs,
          citations: composed.citations,
          source: 'template',
          fictional: false,
          durationMs: Date.now() - started,
        },
      });
    } catch (error) {
      if (
        signal.aborted &&
        !(
          signal.reason instanceof DOMException &&
          signal.reason.name === 'TimeoutError'
        )
      ) {
        this.emit(run, { type: 'run_cancelled', message: 'Cancelled.' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.emit(run, {
          type: 'run_failed',
          agent: current,
          error: message,
          retryable: true,
          message: `${current} failed: ${message}`,
        });
      }
    } finally {
      this.finish(run);
    }
  }

  /** Hands the request to a task report and answers the chat with a link to it. */
  private openTask(
    run: Run,
    framing: Framing & { kind: TaskLink['kind'] },
    started: number,
  ): void {
    const task = this.deps.startTask(framing);
    const paragraph = `This needs a full report, so I opened one: ${task.title}. You can watch it being written.`;
    run.memoryId = this.deps.memory.remember({
      runId: run.id,
      question: run.request.question,
      answerSummary: paragraph,
      locationIds: framing.places.map((p) => p.id),
      citedItemIds: [],
    });
    this.emit(run, {
      type: 'handoff',
      from: 'manager',
      to: ['manager'],
      payloadLabel: 'task',
      message: `Manager opened a ${framing.kind === 'scheduling' ? 'scheduling' : 'revenue recovery'} report.`,
    });
    this.emit(run, { type: 'run_completed', message: 'Report opened.' });
    this.push(run, {
      kind: 'answer',
      answer: {
        runId: run.id,
        paragraphs: [paragraph],
        citations: [],
        source: 'template',
        fictional: false,
        durationMs: Date.now() - started,
        task,
      },
    });
  }

  /** Re-fetch a stale source for the asked places, within the retrieval budget. */
  async refreshIfStale(
    places: Location[],
    brief: Brief,
    signal: AbortSignal,
  ): Promise<string | null> {
    signal.throwIfAborted();
    const ids = new Set(places.map((p) => p.id));
    const items = this.deps.freshItems().filter((i) => ids.has(i.locationId));
    const staleSources = new Set(
      items
        .filter((i) => i.status === 'stale')
        .flatMap((i) => i.sources.map((s) => s.sourceId)),
    );
    if (items.length === 0) staleSources.add('src-openmeteo-cams');
    const watcherIds = [...staleSources]
      .map((sourceId) => this.deps.hazeops.watcherForSource(sourceId))
      .filter((id): id is string => id !== null)
      .filter((id) => {
        const last = this.deps.hazeops.watchers().find((w) => w.spec.id === id)
          ?.state.lastAttemptAt;
        return !last || Date.now() - Date.parse(last) > MIN_REFRESH_GAP_MS;
      });
    if (watcherIds.length === 0) return null;

    const jobs = watcherIds.map(
      (id) =>
        this.deps.watcherRuntime.admit(
          `watcher:${id}`,
          `HazeOps ${id} (chat refresh)`,
          WATCHER_DEADLINE_MS,
          (jobSignal) =>
            this.deps.hazeops.runWatcher(
              id,
              jobSignal,
              `chat-refresh-${Date.now().toString(36)}`,
              brief,
            ),
        ).promise,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<'timeout'>((resolve, reject) => {
      timer = setTimeout(() => resolve('timeout'), RETRIEVAL_BUDGET_MS);
      onAbort = () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('aborted'),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    let outcome:
      PromiseSettledResult<Awaited<(typeof jobs)[number]>>[] | 'timeout';
    try {
      outcome = await Promise.race([Promise.allSettled(jobs), budget]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (outcome === 'timeout') {
      return `HazeOps started a refresh of ${watcherIds.join(', ')} but it did not finish within ${RETRIEVAL_BUDGET_MS / 1000} s; this answer uses the records already stored.`;
    }
    const failed = outcome.filter(
      (r) =>
        r.status === 'rejected' ||
        (r.status === 'fulfilled' && r.value.outcome === 'failed'),
    ).length;
    return failed > 0
      ? `HazeOps tried to refresh ${watcherIds.join(', ')}; ${failed} source(s) failed, so some records may be stale.`
      : `HazeOps refreshed ${watcherIds.join(', ')} for this question.`;
  }
}
