import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openMeteoAdapter,
  openMeteoSpec,
} from '../../dist/capabilities/evidence-collection/sources/openMeteo.js';
import {
  freshnessCheck,
  normaliseUnit,
  valuesCheck,
} from '../../dist/capabilities/evidence-collection/checks.js';
import { HazeOps } from '../src/hazeops/hazeops.ts';
import { entityId } from '../src/world/hazeWorld.ts';
import { KLANG, memoryWorld, modeledResult } from './helpers.ts';

describe('checks', () => {
  it('normalises the Greek mu Open-Meteo sends', () => {
    expect(normaliseUnit('μg/m³')).toBe('µg/m³');
    expect(normaliseUnit('ppm')).toBeNull();
  });

  it('keeps missing values missing and rejects negative ones', () => {
    expect(valuesCheck([1, null, 3]).result).toBe('warn');
    expect(valuesCheck([1, -2]).result).toBe('fail');
    expect(valuesCheck([1, 2]).result).toBe('pass');
  });

  it('applies the freshness rule', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    expect(freshnessCheck('2026-10-24T11:00:00Z', now, 180).result).toBe(
      'pass',
    );
    expect(freshnessCheck('2026-10-24T06:00:00Z', now, 180).result).toBe(
      'fail',
    );
  });
});

describe('Open-Meteo adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns the response into a modeled reading and a forecast, with pinned evidence', async () => {
    const time = Array.from({ length: 72 }, (_, h) =>
      new Date(Date.UTC(2026, 9, 23, h)).toISOString().slice(0, 16),
    );
    const pm25 = time.map((_, h) => (h < 32 ? 40 : 20));
    const body = {
      latitude: 3,
      longitude: 101.4,
      hourly_units: { pm2_5: 'μg/m³' },
      hourly: { time, pm2_5: pm25, pm10: pm25 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      ),
    );

    const result = await openMeteoAdapter([KLANG]).run({
      now: new Date('2026-10-24T08:20:00Z'),
      signal: new AbortController().signal,
      runId: 'test',
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.record).toMatchObject({
      sourceKind: 'modeled',
      unit: 'µg/m³',
      acceptedAt: null,
    });
    const reading = result.facts.find((f) => f.predicate === 'pm25_modeled');
    expect(reading).toMatchObject({
      observedAt: '2026-10-24T08:00:00Z',
      value: { value: 20 },
    });
    const forecast = result.facts.find(
      (f) => f.predicate === 'pm25_forecast_24h',
    );
    expect(forecast?.value).toMatchObject({
      direction: 'improving',
      maxPm25: 20,
    });
  });
});

describe('HazeOps watcher lifecycle', () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function stateFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'haze-watcher-test-'));
    directories.push(directory);
    return join(directory, 'watchers.json');
  }

  it('writes shared collection results, persists scheduling state and deduplicates repeated material', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-26T08:00:00.000Z');
    vi.setSystemTime(now);
    const world = await memoryWorld();
    await world.syncLocations([KLANG], now.toISOString());
    const result = modeledResult(32.9, now.toISOString());
    const spec = openMeteoSpec([KLANG]);
    const run = vi.fn(() => Promise.resolve(result));
    const path = stateFile();
    const hazeops = new HazeOps(world, path);
    hazeops.register({ spec, run });

    expect(hazeops.dueWatchers(now)).toEqual([spec.id]);
    const signal = new AbortController().signal;
    const first = await hazeops.runWatcher(spec.id, signal, 'scheduled-1');
    expect(first).toMatchObject({
      outcome: 'ok',
      summary: { evidenceWritten: 1, factsWritten: 1 },
    });
    expect(run).toHaveBeenCalledWith({
      now,
      signal,
      runId: 'scheduled-1',
    });
    expect(
      world.factHistory(entityId('location', KLANG.id), 'pm25_modeled'),
    ).toHaveLength(1);
    const nextDueAt = new Date(
      now.getTime() + spec.cadenceSec * 1000,
    ).toISOString();
    const persisted: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted).toMatchObject([
      {
        id: spec.id,
        lastOutcome: 'ok',
        lastSuccessAt: now.toISOString(),
        acceptedThrough: now.toISOString(),
        nextDueAt,
        lastCoverage: result.coverage,
        cursor: result.evidence[0]?.record.rawSha256,
        attempts: 1,
      },
    ]);

    const restored = new HazeOps(world, path);
    restored.register({ spec, run });
    expect(restored.dueWatchers(now)).toEqual([]);
    expect(restored.dueWatchers(new Date(nextDueAt))).toEqual([spec.id]);
    const eventCount = world.world.events().length;
    const again = await restored.runWatcher(
      spec.id,
      new AbortController().signal,
      'scheduled-2',
    );
    expect(again).toMatchObject({
      outcome: 'unchanged',
      summary: { evidenceWritten: 0, factsWritten: 0, factsSkipped: 1 },
    });
    expect(world.world.events()).toHaveLength(eventCount);
    expect(restored.watchers()[0]?.state.attempts).toBe(2);
  });

  it('does not write collected evidence when cancellation arrives before the storage boundary', async () => {
    const world = await memoryWorld();
    const controller = new AbortController();
    const result = modeledResult(32.9, '2026-10-26T08:00:00.000Z');
    const hazeops = new HazeOps(world, stateFile());
    const spec = openMeteoSpec([KLANG]);
    hazeops.register({
      spec,
      run() {
        controller.abort(new Error('collection cancelled'));
        return Promise.resolve(result);
      },
    });
    const eventCount = world.world.events().length;

    const report = await hazeops.runWatcher(
      spec.id,
      controller.signal,
      'cancelled-run',
    );
    expect(report).toMatchObject({
      outcome: 'failed',
      summary: null,
      error: 'collection cancelled',
    });
    expect(world.world.events()).toHaveLength(eventCount);
    expect(world.evidence(result.evidence[0]!.record.evidenceId)).toBeNull();
    expect(hazeops.watchers()[0]?.state).toMatchObject({
      lastOutcome: 'failed',
      lastSuccessAt: null,
      acceptedThrough: null,
      lastError: 'collection cancelled',
    });
  });
});
