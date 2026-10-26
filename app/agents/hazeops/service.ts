import { randomUUID } from 'node:crypto';
import type { Location } from '../../contracts/haze-evidence.js';
import type { TaskIdentity } from '../../contracts/tasks.js';
import type { ExecutionMode } from '../../orchestration/ports.js';
import type { TaskStore } from '../../tasks/store.js';
import { collectOnce } from '../../capabilities/evidence-collection/collection.js';
import {
  firmsAdapter,
  firmsSpec,
} from '../../capabilities/evidence-collection/sources/firms.js';
import {
  openAqAdapter,
  openAqSpec,
} from '../../capabilities/evidence-collection/sources/openAq.js';
import {
  openMeteoAdapter,
  openMeteoSpec,
} from '../../capabilities/evidence-collection/sources/openMeteo.js';
import {
  zetarisAdapter,
  zetarisSpec,
} from '../../capabilities/evidence-collection/sources/zetaris.js';
import type {
  AdapterResult,
  CoverageReport,
  SourceAdapter,
  WatcherSpec,
} from '../../capabilities/evidence-collection/types.js';
import {
  loadDashboardConfig,
  type DashboardConfig,
} from '../../dashboard/config.js';
import { locationsFor } from '../../dashboard/locations.js';
import type { WriteSummary } from '../../world/haze-world.js';

export interface WatcherState {
  id: string;
  enabled: boolean;
  disabledReason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: 'ok' | 'unchanged' | 'failed' | 'skipped' | null;
  lastError: string | null;
  cursor: string | null;
  /** Collection watermark only; this does not indicate evidence acceptance. */
  acceptedThrough: string | null;
  nextDueAt: string | null;
  lastCoverage: CoverageReport | null;
  lastDurationMs: number | null;
  attempts: number;
  lastRequest: { assignmentId: string; objective: string; at: string } | null;
}

export interface WatcherRunReport {
  watcherId: string;
  outcome: 'ok' | 'unchanged' | 'failed' | 'skipped';
  summary: WriteSummary | null;
  error: string | null;
  durationMs: number;
}

export interface WatcherJobView {
  id: string;
  key: string;
  label: string;
  state:
    'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  admittedAt: string;
  deadlineAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  coalesced: number;
}

/** The shared World Model facade; source scheduling owns no second data store. */
export interface HazeOpsWorld {
  syncLocations(
    locations: readonly Location[],
    at: string,
  ): void | number | Promise<void | number>;
  syncSources(
    specs: readonly WatcherSpec[],
    at: string,
  ): void | number | Promise<void | number>;
  writeAdapterResult(
    result: AdapterResult,
    runId: string,
  ): WriteSummary | Promise<WriteSummary>;
}

export interface HazeOpsServiceOptions {
  store: TaskStore;
  world: HazeOpsWorld;
  identity: TaskIdentity;
  mode: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  config?: DashboardConfig;
  /** Explicit host injection for deterministic tests; never taken from HTTP input. */
  adapters?: readonly SourceAdapter[];
  locations?: readonly Location[];
  deadlineMs?: number;
  schedulerIntervalMs?: number;
}

interface Job {
  view: WatcherJobView;
  watcherId: string;
  controller: AbortController;
  promise: Promise<WatcherRunReport>;
  resolve: (value: WatcherRunReport) => void;
}

function emptyState(id: string): WatcherState {
  return {
    id,
    enabled: true,
    disabledReason: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastOutcome: null,
    lastError: null,
    cursor: null,
    acceptedThrough: null,
    nextDueAt: null,
    lastCoverage: null,
    lastDurationMs: null,
    attempts: 0,
    lastRequest: null,
  };
}

/** Abort even if a source ignores its signal; late results never reach ingestion. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Recurring deterministic HazeOps collection, owned by the application runtime. */
export class HazeOpsService {
  readonly config: DashboardConfig;
  readonly locations: readonly Location[];
  readonly ready: Promise<void>;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly specifications = new Map<string, WatcherSpec>();
  private readonly states = new Map<string, WatcherState>();
  private readonly active = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: HazeOpsServiceOptions) {
    this.config = options.config ?? loadDashboardConfig(options.env);
    this.locations = options.locations ?? locationsFor(this.config.coverage);
    options.store.db.exec(`
      CREATE TABLE IF NOT EXISTS hazeops_watchers (
        principal TEXT NOT NULL,workspace TEXT NOT NULL,mode TEXT NOT NULL,
        watcher_id TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(principal,workspace,mode,watcher_id));
      CREATE TABLE IF NOT EXISTS hazeops_watcher_jobs (
        id TEXT PRIMARY KEY,principal TEXT NOT NULL,workspace TEXT NOT NULL,
        mode TEXT NOT NULL,admitted_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hazeops_jobs_scope ON
        hazeops_watcher_jobs(principal,workspace,mode,admitted_at);
      CREATE TABLE IF NOT EXISTS hazeops_controls (
        principal TEXT NOT NULL,workspace TEXT NOT NULL,mode TEXT NOT NULL,
        operation_key TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(principal,workspace,mode,operation_key));
    `);
    for (const row of options.store.db
      .prepare(
        'SELECT body FROM hazeops_watchers WHERE principal=? AND workspace=? AND mode=?',
      )
      .all(...this.scope()) as { body: string }[]) {
      const state = JSON.parse(row.body) as WatcherState;
      this.states.set(state.id, state);
    }
    // A process restart fences the old execution; the next due scan is a new run.
    for (const job of this.jobs()) {
      if (job.state !== 'queued' && job.state !== 'running') continue;
      job.state = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error =
        'Collection owner restarted before completion; no completion was assumed.';
      this.saveJob(job);
    }
    if (options.adapters) {
      for (const adapter of options.adapters) {
        if (this.config.sampleMode && options.mode === 'live')
          this.registerDisabled(
            adapter.spec,
            'SAMPLE_MODE=true disables network sources',
          );
        else this.register(adapter);
      }
    } else this.registerConfigured();
    const at = new Date().toISOString();
    const locations = this.locations;
    this.ready = (async () => {
      await options.world.syncLocations(locations, at);
      await options.world.syncSources(this.specs(), at);
    })();
  }

  private scope(): [string, string, ExecutionMode] {
    return [
      this.options.identity.principal,
      this.options.identity.workspace,
      this.options.mode,
    ];
  }

  private registerConfigured(): void {
    const config = this.config;
    const disabled = config.sampleMode
      ? 'SAMPLE_MODE=true disables network sources'
      : this.options.mode !== 'live'
        ? `${this.options.mode} mode disables recurring live sources`
        : null;
    const choices: {
      spec: WatcherSpec;
      reason: string | null;
      create: () => SourceAdapter;
    }[] = [
      {
        spec: openMeteoSpec(this.locations),
        reason: disabled,
        create: () => openMeteoAdapter(this.locations),
      },
      {
        spec: openAqSpec(),
        reason:
          disabled ?? (config.keys.openAq ? null : 'OPEN_AQ_KEY is not set'),
        create: () => openAqAdapter(this.locations, config.keys.openAq!),
      },
      {
        spec: firmsSpec(),
        reason:
          disabled ?? (config.keys.firms ? null : 'FIRMS_MAP_KEY is not set'),
        create: () => firmsAdapter(this.locations, config.keys.firms!),
      },
      {
        spec: zetarisSpec(config.zetarisQueries),
        reason:
          disabled ??
          (config.keys.zetarisUsername && config.keys.zetarisPassword
            ? null
            : 'ZETARIS_USERNAME / ZETARIS_PASSWORD are not set'),
        create: () =>
          zetarisAdapter(this.locations, {
            baseUrl: config.zetarisBaseUrl,
            username: config.keys.zetarisUsername!,
            password: config.keys.zetarisPassword!,
            queries: [...config.zetarisQueries],
          }),
      },
    ];
    for (const choice of choices) {
      if (choice.reason) this.registerDisabled(choice.spec, choice.reason);
      else this.register(choice.create());
    }
  }

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.spec.id, adapter);
    this.specifications.set(adapter.spec.id, adapter.spec);
    this.saveState({
      ...(this.states.get(adapter.spec.id) ?? emptyState(adapter.spec.id)),
      enabled: true,
      disabledReason: null,
    });
  }

  registerDisabled(spec: WatcherSpec, reason: string): void {
    this.adapters.delete(spec.id);
    this.specifications.set(spec.id, spec);
    this.saveState({
      ...(this.states.get(spec.id) ?? emptyState(spec.id)),
      enabled: false,
      disabledReason: reason,
    });
  }

  specs(): WatcherSpec[] {
    return [...this.specifications.values()];
  }
  watchers(): { spec: WatcherSpec; state: WatcherState }[] {
    return this.specs().map((spec) => ({
      spec,
      state: structuredClone(this.states.get(spec.id)!),
    }));
  }
  lastRunMs(): Map<string, number> {
    return new Map(
      this.watchers().map(({ spec, state }) => [
        spec.source.id,
        state.lastDurationMs ?? 0,
      ]),
    );
  }
  dueWatchers(now = new Date()): string[] {
    return [...this.adapters.keys()].filter((id) => {
      const due = this.states.get(id)?.nextDueAt;
      return !this.active.has(id) && (!due || due <= now.toISOString());
    });
  }
  watcherForSource(sourceId: string): string | null {
    return this.specs().find((spec) => spec.source.id === sourceId)?.id ?? null;
  }
  jobs(): WatcherJobView[] {
    return (
      this.options.store.db
        .prepare(
          'SELECT body FROM hazeops_watcher_jobs WHERE principal=? AND workspace=? AND mode=? ORDER BY admitted_at DESC,id DESC LIMIT 50',
        )
        .all(...this.scope()) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as WatcherJobView);
  }

  private saveState(state: WatcherState): void {
    this.options.store.db
      .prepare(
        'INSERT INTO hazeops_watchers(principal,workspace,mode,watcher_id,body) VALUES(?,?,?,?,?) ON CONFLICT(principal,workspace,mode,watcher_id) DO UPDATE SET body=excluded.body',
      )
      .run(...this.scope(), state.id, JSON.stringify(state));
    this.states.set(state.id, state);
  }
  private saveJob(view: WatcherJobView): void {
    this.options.store.db
      .prepare(
        'INSERT INTO hazeops_watcher_jobs(id,principal,workspace,mode,admitted_at,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(view.id, ...this.scope(), view.admittedAt, JSON.stringify(view));
  }

  /** Returns admitted watcher IDs; a repeated operator key replays its receipt. */
  tick(operationKey?: string): string[] {
    if (operationKey) {
      const prior = this.options.store.db
        .prepare(
          'SELECT body FROM hazeops_controls WHERE principal=? AND workspace=? AND mode=? AND operation_key=?',
        )
        .get(...this.scope(), operationKey) as { body: string } | undefined;
      if (prior) return JSON.parse(prior.body) as string[];
    }
    if (this.closed) return [];
    const ids = this.dueWatchers();
    const jobs = ids.map((id): Job => {
      const at = new Date();
      let resolve!: (report: WatcherRunReport) => void;
      const promise = new Promise<WatcherRunReport>((done) => {
        resolve = done;
      });
      return {
        watcherId: id,
        controller: new AbortController(),
        promise,
        resolve,
        view: {
          id: `watcher-${randomUUID()}`,
          key: `watcher:${id}`,
          label: `HazeOps ${id}`,
          state: 'queued',
          admittedAt: at.toISOString(),
          deadlineAt: new Date(
            at.getTime() + (this.options.deadlineMs ?? 120_000),
          ).toISOString(),
          startedAt: null,
          finishedAt: null,
          error: null,
          coalesced: 0,
        },
      };
    });
    // Persist admission and its control receipt before any source can execute.
    const db = this.options.store.db;
    db.exec('SAVEPOINT hazeops_admission');
    try {
      for (const job of jobs) this.saveJob(job.view);
      if (operationKey)
        db.prepare(
          'INSERT INTO hazeops_controls(principal,workspace,mode,operation_key,body) VALUES(?,?,?,?,?)',
        ).run(...this.scope(), operationKey, JSON.stringify(ids));
      db.exec('RELEASE SAVEPOINT hazeops_admission');
    } catch (error) {
      db.exec(
        'ROLLBACK TO SAVEPOINT hazeops_admission; RELEASE SAVEPOINT hazeops_admission',
      );
      throw error;
    }
    for (const job of jobs) {
      this.active.set(job.watcherId, job);
      this.queue.push(job);
    }
    this.pump();
    return ids;
  }

  start(): void {
    if (
      this.started ||
      this.closed ||
      !this.config.schedulerEnabled ||
      this.options.mode !== 'live'
    )
      return;
    this.started = true;
    void this.ready
      .then(() => {
        if (this.closed) return;
        this.tick();
        this.timer = setInterval(
          () => this.tick(),
          this.options.schedulerIntervalMs ?? 30_000,
        );
        this.timer.unref();
      })
      .catch(() => {
        /* The owner observes ready; failed initialization never polls. */
      });
  }

  private pump(): void {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.execute(job).catch((error: unknown) => {
        // Storage failures must settle callers as well as source failures.
        job.resolve({
          watcherId: job.watcherId,
          outcome: 'failed',
          summary: null,
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
        });
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const remaining = Date.parse(job.view.deadlineAt) - Date.now();
    const deadline =
      remaining > 0
        ? AbortSignal.timeout(remaining)
        : AbortSignal.abort(
            new Error('Collection deadline expired while queued.'),
          );
    const signal = AbortSignal.any([job.controller.signal, deadline]);
    let report: WatcherRunReport;
    const started = Date.now();
    try {
      await this.ready;
      signal.throwIfAborted();
      job.view.state = 'running';
      job.view.startedAt = new Date().toISOString();
      this.saveJob(job.view);
      const state = structuredClone(this.states.get(job.watcherId)!);
      state.lastAttemptAt = job.view.startedAt;
      state.attempts++;
      this.saveState(state);
      const adapter = this.adapters.get(job.watcherId)!;
      const result = await abortable(
        collectOnce(adapter, {
          now: new Date(),
          signal,
          runId: job.view.id,
        }),
        signal,
      );
      signal.throwIfAborted();
      const summary = await this.options.world.writeAdapterResult(
        result,
        job.view.id,
      );
      const finishedAt = new Date().toISOString();
      state.lastOutcome =
        summary.evidenceWritten === 0 && summary.factsWritten === 0
          ? 'unchanged'
          : 'ok';
      state.lastSuccessAt = finishedAt;
      state.lastError = null;
      state.cursor =
        result.evidence.map((value) => value.record.rawSha256).join('+') ||
        state.cursor;
      if (
        summary.newestObservation &&
        (!state.acceptedThrough ||
          summary.newestObservation > state.acceptedThrough)
      )
        state.acceptedThrough = summary.newestObservation;
      state.lastCoverage = result.coverage;
      state.nextDueAt = new Date(
        Date.now() + adapter.spec.cadenceSec * 1000,
      ).toISOString();
      state.lastDurationMs = Date.now() - started;
      this.saveState(state);
      job.view.state = 'completed';
      report = {
        watcherId: job.watcherId,
        outcome: state.lastOutcome,
        summary,
        error: null,
        durationMs: state.lastDurationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = structuredClone(this.states.get(job.watcherId)!);
      state.lastOutcome = 'failed';
      state.lastError = message;
      state.lastDurationMs = Date.now() - started;
      state.nextDueAt = new Date(
        Date.now() +
          Math.min(this.specifications.get(job.watcherId)!.cadenceSec, 600) *
            1000,
      ).toISOString();
      this.saveState(state);
      job.view.state = deadline.aborted
        ? 'timed_out'
        : job.controller.signal.aborted
          ? 'cancelled'
          : 'failed';
      job.view.error = message;
      report = {
        watcherId: job.watcherId,
        outcome: 'failed',
        summary: null,
        error: message,
        durationMs: state.lastDurationMs,
      };
    } finally {
      job.view.finishedAt = new Date().toISOString();
      try {
        this.saveJob(job.view);
      } finally {
        this.active.delete(job.watcherId);
        this.running--;
        this.pump();
      }
    }
    job.resolve(report);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.active.values()].map((job) => job.promise));
  }

  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.closed = true;
      if (this.timer) clearInterval(this.timer);
      for (const job of this.active.values())
        job.controller.abort(new Error('HazeOps service closed.'));
      await this.idle();
      await this.ready.catch(() => undefined);
    })());
  }
}
