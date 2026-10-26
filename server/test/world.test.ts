import { describe, expect, it } from 'vitest';
import { openMeteoSpec } from '../../dist/capabilities/evidence-collection/sources/openMeteo.js';
import { entityId } from '../src/world/hazeWorld.ts';
import { projectItems } from '../src/world/projection.ts';
import { KLANG, memoryWorld, modeledResult } from './helpers.ts';

const spec = openMeteoSpec([KLANG]);
const context = (
  world: Awaited<ReturnType<typeof memoryWorld>>,
  now: string,
) => ({
  world,
  specsBySource: new Map([[spec.source.id, spec]]),
  lastRunMs: new Map<string, number>(),
  now: new Date(now),
});

describe('HazeWorld writes', () => {
  it('pins evidence and asserts a fact', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    const summary = await world.writeAdapterResult(
      modeledResult(32.9, '2026-10-24T08:00:00Z'),
      'run-1',
    );
    expect(summary).toMatchObject({ evidenceWritten: 1, factsWritten: 1 });
    const history = world.factHistory(
      entityId('location', 'klang'),
      'pm25_modeled',
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.source.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is idempotent: re-writing identical material changes nothing', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    const result = modeledResult(32.9, '2026-10-24T08:00:00Z');
    await world.writeAdapterResult(result, 'run-1');
    const events = world.world.events().length;
    const again = await world.writeAdapterResult(result, 'run-2');
    expect(again).toMatchObject({
      evidenceWritten: 0,
      factsWritten: 0,
      factsSkipped: 1,
    });
    expect(world.world.events().length).toBe(events);
  });

  it('skips the same observation re-fetched in different raw bytes', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    await world.writeAdapterResult(
      modeledResult(32.9, '2026-10-24T08:00:00Z', 'bytes-a'),
      'run-1',
    );
    const again = await world.writeAdapterResult(
      modeledResult(32.9, '2026-10-24T08:00:00Z', 'bytes-b'),
      'run-2',
    );
    expect(again.factsWritten).toBe(0);
    expect(again.evidenceWritten).toBe(1); // the new bytes are still pinned
  });

  it('does not rewrite unchanged locations', async () => {
    const world = await memoryWorld();
    expect(await world.syncLocations([KLANG], '2026-10-24T00:00:00Z')).toBe(1);
    expect(await world.syncLocations([KLANG], '2026-10-24T01:00:00Z')).toBe(0);
  });
});

describe('projection', () => {
  it('shows a checked but not independently verified reading as "partial"', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    await world.writeAdapterResult(
      modeledResult(32.9, '2026-10-24T08:00:00Z'),
      'run-1',
    );
    const [item] = projectItems(context(world, '2026-10-24T09:00:00Z'));
    expect(item).toMatchObject({
      id: 'hz-modeled-klang',
      status: 'partial',
      fictional: false,
      locationId: 'klang',
    });
    expect(
      item?.checks.find((c) => c.id === 'review.independent')?.result,
    ).toBe('pending');
    expect(item?.measurements[0]).toMatchObject({
      pollutant: 'pm25',
      value: 32.9,
    });
  });

  it('marks old values stale instead of hiding them', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    await world.writeAdapterResult(
      modeledResult(32.9, '2026-10-24T08:00:00Z'),
      'run-1',
    );
    const [item] = projectItems(context(world, '2026-10-25T08:00:00Z'));
    expect(item?.status).toBe('stale');
  });

  it('keeps history: a newer value becomes revision 2 with a trend', async () => {
    const world = await memoryWorld();
    await world.syncLocations([KLANG], '2026-10-24T00:00:00Z');
    await world.writeAdapterResult(
      modeledResult(30, '2026-10-24T08:00:00Z'),
      'run-1',
    );
    await world.writeAdapterResult(
      modeledResult(45, '2026-10-24T11:00:00Z'),
      'run-2',
    );
    const [item] = projectItems(context(world, '2026-10-24T11:30:00Z'));
    expect(item?.revision).toBe(2);
    expect(item?.timeline).toHaveLength(2);
    expect(item?.measurements[0]?.value).toBe(45);
  });
});
