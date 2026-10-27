import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  HazeOpsService,
  type HazeOpsWorld,
} from '../../app/agents/hazeops/service.js';
import { loadDashboardConfig } from '../../app/dashboard/config.js';
import { locationsFor } from '../../app/dashboard/locations.js';
import type {
  AdapterResult,
  SourceAdapter,
} from '../../app/capabilities/evidence-collection/types.js';

const identity = { principal: 'watcher-test', workspace: 'watcher-workspace' };
const services: HazeOpsService[] = [];
const stores: TaskStore[] = [];
const directories: string[] = [];
const result: AdapterResult = {
  evidence: [],
  stations: [],
  facts: [],
  coverage: {
    requested: 1,
    covered: 0,
    excluded: [],
    gaps: ['Explicit empty test source.'],
  },
};

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close();
  for (const store of stores.splice(0).reverse())
    if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    const rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Unsafe test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function store(): TaskStore {
  const directory = mkdtempSync(join(tmpdir(), 'hazeops-shared-'));
  directories.push(directory);
  const value = new TaskStore(directory, { recover: false });
  stores.push(value);
  return value;
}

function world() {
  return {
    syncLocations: vi.fn(() => undefined),
    syncSources: vi.fn(() => undefined),
    writeAdapterResult: vi.fn(() => ({
      evidenceWritten: 0,
      factsWritten: 0,
      factsSkipped: 0,
      stationsWritten: 0,
      newestObservation: null,
    })),
  } satisfies HazeOpsWorld;
}

function adapter(id: string, run: SourceAdapter['run']): SourceAdapter {
  return {
    spec: {
      id,
      source: {
        id: `source-${id}`,
        name: `Synthetic ${id}`,
        kind: 'forecast_model',
        evidenceKind: 'modeled',
        organisation: 'Local test',
        cadence: 'hourly',
        licenceNote: 'Synthetic',
        reliabilityNote: 'Synthetic',
        url: 'https://example.invalid',
      },
      requiresEnv: [],
      query: 'Synthetic only',
      placeSelector: 'Synthetic',
      timeSelector: 'Synthetic',
      cadenceSec: 3600,
      rateLimit: 'No network',
      freshnessMinutes: 120,
    },
    run,
  };
}

function service(options: ConstructorParameters<typeof HazeOpsService>[0]) {
  const value = new HazeOpsService(options);
  services.push(value);
  return value;
}

describe('shared application HazeOps service', () => {
  it('reports scheduler execution separately from configured collectors', async () => {
    const database = store();
    const live = service({
      store: database,
      world: world(),
      identity,
      mode: 'live',
      env: {},
      adapters: [],
      locations: [],
    });
    await live.ready;
    expect(live.status().scheduler).toBe('stopped');
    live.start();
    await vi.waitFor(() => expect(live.status().scheduler).toBe('running'));
    await live.close();
    expect(live.status().scheduler).toBe('stopped');
    const disabled = service({
      store: database,
      world: world(),
      identity,
      mode: 'live',
      env: { HAZEOPS_SCHEDULER: 'off' },
      adapters: [],
      locations: [],
    });
    disabled.start();
    expect(disabled.status()).toEqual({
      scheduler: 'disabled',
      reason: 'HAZEOPS_SCHEDULER=off',
    });
  });

  it('bounds collection to two jobs, coalesces scans and durably replays operator receipts', async () => {
    const database = store();
    const sink = world();
    const releases = new Map<string, () => void>();
    let running = 0;
    let maximum = 0;
    const calls: string[] = [];
    const adapters = ['one', 'two', 'three'].map((id) =>
      adapter(id, async () => {
        calls.push(id);
        running++;
        maximum = Math.max(maximum, running);
        await new Promise<void>((done) => releases.set(id, done));
        running--;
        return result;
      }),
    );
    const first = service({
      store: database,
      world: sink,
      identity,
      mode: 'fixture',
      adapters,
    });
    await first.ready;
    expect(first.tick('operator-tick')).toEqual(['one', 'two', 'three']);
    expect(first.tick('operator-tick')).toEqual(['one', 'two', 'three']);
    expect(first.tick()).toEqual([]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(maximum).toBe(2);
    releases.get('one')!();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    releases.get('two')!();
    releases.get('three')!();
    await first.idle();
    expect(maximum).toBe(2);
    expect(sink.writeAdapterResult).toHaveBeenCalledTimes(3);
    expect(
      first
        .watchers()
        .every(
          ({ state }) =>
            state.attempts === 1 && state.lastOutcome === 'unchanged',
        ),
    ).toBe(true);
    expect(first.jobs().every((job) => job.state === 'completed')).toBe(true);
    await first.close();

    const reopened = service({
      store: database,
      world: sink,
      identity,
      mode: 'fixture',
      adapters,
    });
    await reopened.ready;
    expect(reopened.tick('operator-tick')).toEqual(['one', 'two', 'three']);
    expect(reopened.tick()).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(reopened.watchers()[0]!.state.attempts).toBe(1);

    const isolated = service({
      store: database,
      world: world(),
      identity: { ...identity, principal: 'other-user' },
      mode: 'fixture',
      adapters,
    });
    await isolated.ready;
    expect(isolated.jobs()).toEqual([]);
    expect(isolated.watchers()[0]!.state.attempts).toBe(0);
  });

  it('cancels queued and late source work before it can reach shared ingestion', async () => {
    const database = store();
    const sink = world();
    let finish!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>((done) => {
        finish = done;
      });
      return result;
    });
    const value = service({
      store: database,
      world: sink,
      identity,
      mode: 'fixture',
      adapters: [adapter('one', run)],
    });
    await value.ready;
    value.tick();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const closing = value.close();
    finish();
    await closing;
    expect(sink.writeAdapterResult).not.toHaveBeenCalled();
    expect(value.jobs()[0]!.state).toBe('cancelled');
    expect(value.tick()).toEqual([]);
  });

  it('does not start automatic polling in fixture or replay mode', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve(result));
    for (const mode of ['fixture', 'replay'] as const) {
      const value = service({
        store: store(),
        world: world(),
        identity,
        mode,
        adapters: [adapter(mode, run)],
      });
      await value.ready;
      value.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).not.toHaveBeenCalled();
      value.tick();
      await value.idle();
      expect(run).toHaveBeenCalledTimes(1);
      run.mockClear();
    }
  });

  it('enforces a deadline when a source ignores cancellation', async () => {
    let finish!: (result: AdapterResult) => void;
    const sink = world();
    const value = service({
      store: store(),
      world: sink,
      identity,
      mode: 'fixture',
      deadlineMs: 20,
      adapters: [
        adapter(
          'unresponsive',
          () =>
            new Promise((done) => {
              finish = done;
            }),
        ),
      ],
    });
    await value.ready;
    value.tick();
    await value.idle();
    expect(value.jobs()[0]!.state).toBe('timed_out');
    expect(sink.writeAdapterResult).not.toHaveBeenCalled();
    finish(result);
    await Promise.resolve();
    expect(sink.writeAdapterResult).not.toHaveBeenCalled();
  });

  it('shows disabled configured sources and shares the migrated real location registry', async () => {
    const config = loadDashboardConfig({ SAMPLE_MODE: 'true' });
    expect(config.coverage).toBe('asean');
    expect(locationsFor('malaysia')).toHaveLength(75);
    expect(locationsFor('asean')[0]!.id).toBe('klang');
    expect(locationsFor('worldwide').length).toBeGreaterThan(
      locationsFor('asean').length,
    );
    const value = service({
      store: store(),
      world: world(),
      identity,
      mode: 'live',
      config,
    });
    await value.ready;
    expect(value.watchers()).toHaveLength(4);
    expect(
      value
        .watchers()
        .every(
          ({ state }) =>
            !state.enabled && state.disabledReason?.includes('SAMPLE_MODE'),
        ),
    ).toBe(true);
    expect(value.tick('disabled')).toEqual([]);
    expect(() => loadDashboardConfig({ HAZEOPS_COVERAGE: 'invalid' })).toThrow(
      'HAZEOPS_COVERAGE',
    );
  });
});
