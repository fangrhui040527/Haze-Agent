import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectOnce } from '../../../dist/capabilities/evidence-collection/collection.js';
import type { HazeWorld, WriteSummary } from '../world/hazeWorld.ts';
import type { Brief } from '../manager/manager.ts';
import type { SourceAdapter, WatcherSpec, WatcherState } from './types.ts';

/**
 * HazeOps (Spec §2): bounded retrieval and preparation of provenance, coverage and
 * applicability questions. It pins evidence and writes facts; it never accepts
 * evidence, never marks anything verified, and never checks its own work.
 *
 * Each watcher persists the Spec §12 fields: last attempt/success, cursor,
 * accepted-through watermark and next due check. A failed source stays visibly
 * failed: an outage is never reported as "all clear".
 */

export interface WatcherRunReport {
  watcherId: string;
  outcome: 'ok' | 'unchanged' | 'failed' | 'skipped';
  summary: WriteSummary | null;
  error: string | null;
  durationMs: number;
}

export interface WatcherView {
  spec: WatcherSpec;
  state: WatcherState;
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
    lastRequest: null,
    attempts: 0,
  };
}

export class HazeOps {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly disabled = new Map<
    string,
    { spec: WatcherSpec; reason: string }
  >();
  private readonly states = new Map<string, WatcherState>();
  private readonly stateFile: string;
  private readonly world: HazeWorld;

  constructor(world: HazeWorld, stateFile: string) {
    this.world = world;
    this.stateFile = stateFile;
    if (existsSync(stateFile)) {
      const saved = JSON.parse(
        readFileSync(stateFile, 'utf8'),
      ) as WatcherState[];
      for (const state of saved) this.states.set(state.id, state);
    }
  }

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.spec.id, adapter);
    const state =
      this.states.get(adapter.spec.id) ?? emptyState(adapter.spec.id);
    state.enabled = true;
    state.disabledReason = null;
    this.states.set(adapter.spec.id, state);
  }

  /** A watcher that cannot run (missing key, sample mode). Shown, never silently dropped. */
  registerDisabled(spec: WatcherSpec, reason: string): void {
    this.disabled.set(spec.id, { spec, reason });
    const state = this.states.get(spec.id) ?? emptyState(spec.id);
    state.enabled = false;
    state.disabledReason = reason;
    this.states.set(spec.id, state);
  }

  specs(): WatcherSpec[] {
    return [
      ...[...this.adapters.values()].map((a) => a.spec),
      ...[...this.disabled.values()].map((d) => d.spec),
    ];
  }

  watchers(): WatcherView[] {
    return this.specs().map((spec) => ({
      spec,
      state: this.states.get(spec.id) ?? emptyState(spec.id),
    }));
  }

  lastRunMs(): Map<string, number> {
    return new Map(
      [...this.states.values()].map((s) => [s.id, s.lastDurationMs ?? 0]),
    );
  }

  dueWatchers(now: Date): string[] {
    return [...this.adapters.keys()].filter((id) => {
      const due = this.states.get(id)?.nextDueAt;
      return !due || due <= now.toISOString();
    });
  }

  /** Which watcher feeds a source (used to refresh one source on demand). */
  watcherForSource(sourceId: string): string | null {
    for (const adapter of this.adapters.values()) {
      if (adapter.spec.source.id === sourceId) return adapter.spec.id;
    }
    return null;
  }

  private save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(
      this.stateFile,
      JSON.stringify([...this.states.values()], null, 2),
    );
  }

  async runWatcher(
    id: string,
    signal: AbortSignal,
    runId: string,
    brief?: Brief,
  ): Promise<WatcherRunReport> {
    const adapter = this.adapters.get(id);
    const state = { ...emptyState(id), ...this.states.get(id) };
    if (!adapter) {
      return {
        watcherId: id,
        outcome: 'skipped',
        summary: null,
        error: this.disabled.get(id)?.reason ?? 'unknown watcher',
        durationMs: 0,
      };
    }
    const started = Date.now();
    const now = new Date();
    state.lastAttemptAt = now.toISOString();
    state.attempts += 1;
    if (brief) {
      state.lastRequest = {
        assignmentId: brief.assignmentId,
        objective: brief.objective.text,
        at: state.lastAttemptAt,
      };
    }
    try {
      const result = await collectOnce(adapter, { now, signal, runId });
      const cursor =
        result.evidence.map((e) => e.record.rawSha256).join('+') || null;
      const summary = await this.world.writeAdapterResult(result, runId);
      const unchanged =
        summary.evidenceWritten === 0 && summary.factsWritten === 0;
      state.lastOutcome = unchanged ? 'unchanged' : 'ok';
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      state.cursor = cursor ?? state.cursor;
      if (
        summary.newestObservation &&
        (!state.acceptedThrough ||
          summary.newestObservation > state.acceptedThrough)
      ) {
        state.acceptedThrough = summary.newestObservation;
      }
      state.lastCoverage = result.coverage;
      state.nextDueAt = new Date(
        Date.now() + adapter.spec.cadenceSec * 1000,
      ).toISOString();
      state.lastDurationMs = Date.now() - started;
      this.states.set(id, state);
      this.save();
      return {
        watcherId: id,
        outcome: state.lastOutcome,
        summary,
        error: null,
        durationMs: state.lastDurationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastOutcome = 'failed';
      state.lastError = message;
      // Retry sooner than the cadence, but never hammer a failing source.
      const retrySec = Math.min(adapter.spec.cadenceSec, 10 * 60);
      state.nextDueAt = new Date(Date.now() + retrySec * 1000).toISOString();
      state.lastDurationMs = Date.now() - started;
      this.states.set(id, state);
      this.save();
      return {
        watcherId: id,
        outcome: 'failed',
        summary: null,
        error: message,
        durationMs: state.lastDurationMs,
      };
    }
  }
}
