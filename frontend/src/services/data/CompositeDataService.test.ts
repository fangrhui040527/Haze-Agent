import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateDataset } from '../../mock/generator/generate.ts';
import type { ConnectionStatus } from '../../shared/types/domain.ts';
import { CompositeDataService } from './CompositeDataService.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';
import { setShowDemoWithReal } from './demoPreference.ts';

const dataset = generateDataset({
  seed: 4,
  itemCount: 10,
  now: new Date('2026-10-25T00:00:00Z'),
});
const item = dataset.items[0];
const snapshot = (ids: string[], fictional = false): DataSnapshot => ({
  items: ids.map((id) => ({ ...item, id })),
  locations: dataset.locations,
  sources: dataset.sources,
  fictional,
  asOf: '2026-10-25T00:00:00Z',
});

class FakeDataService implements DataService {
  label = 'fake';
  loadSnapshot: DataService['loadSnapshot'];
  getItem = () => Promise.resolve(null);
  update: (event: LiveUpdate) => void = () => {};
  status: (value: ConnectionStatus) => void = () => {};
  constructor(initial: DataSnapshot) {
    this.loadSnapshot = vi.fn(() => Promise.resolve(initial));
  }
  subscribe(
    update: (event: LiveUpdate) => void,
    status: (value: ConnectionStatus) => void,
  ) {
    this.update = update;
    this.status = status;
    status('live');
    return () => {};
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
afterEach(() => setShowDemoWithReal(false));

describe('CompositeDataService live replacements', () => {
  it('labels shared fixture observations as fictional', async () => {
    const service = new CompositeDataService(
      new FakeDataService(snapshot(['hz-fixture'], true)),
      new FakeDataService(snapshot(['demo-one'], true)),
    );
    await service.loadSnapshot();
    expect(service.label).toBe('Haze app (fictional fixture data)');
  });

  it('reconciles reconnect snapshots, removes vanished real items and keeps demo rows in mixed mode', async () => {
    setShowDemoWithReal(true);
    const real = new FakeDataService(snapshot(['hz-old', 'hz-stay']));
    const demo = new FakeDataService(snapshot(['demo-one'], true));
    const service = new CompositeDataService(real, demo);
    await service.loadSnapshot();
    const updates: LiveUpdate[] = [];
    const stop = service.subscribe(
      (event) => updates.push(event),
      () => {},
    );
    real.status('offline');
    real.update({ kind: 'reset', snapshot: snapshot(['hz-stay', 'hz-new']) });
    real.status('live');
    await settle();
    expect(updates).toHaveLength(1);
    const result = updates[0];
    expect(result.kind).toBe('reset');
    if (result.kind === 'reset') {
      expect(result.snapshot.items.map((row) => row.id)).toEqual([
        'hz-stay',
        'hz-new',
        'demo-one',
      ]);
      expect(result.snapshot.fictional).toBe(true);
    }
    expect(real.loadSnapshot).toHaveBeenCalledTimes(1);
    stop();
  });

  it('loads demo data when the last real row disappears', async () => {
    const real = new FakeDataService(snapshot(['hz-one']));
    const demo = new FakeDataService(snapshot(['demo-one'], true));
    const service = new CompositeDataService(real, demo);
    await service.loadSnapshot();
    const updates: LiveUpdate[] = [];
    const stop = service.subscribe(
      (event) => updates.push(event),
      () => {},
    );
    real.update({ kind: 'reset', snapshot: snapshot([]) });
    await settle();
    expect(updates).toEqual([
      { kind: 'reset', snapshot: snapshot(['demo-one'], true) },
    ]);
    expect(service.label).toMatch(/^Mock/);
    stop();
  });

  it('does not let a pending reset overwrite a newer streamed revision', async () => {
    const real = new FakeDataService(snapshot(['hz-one']));
    const service = new CompositeDataService(
      real,
      new FakeDataService(snapshot(['demo-one'], true)),
    );
    await service.loadSnapshot();
    const updates: LiveUpdate[] = [];
    const stop = service.subscribe(
      (event) => updates.push(event),
      () => {},
    );
    real.update({ kind: 'reset', snapshot: snapshot(['hz-one']) });
    real.update({
      kind: 'upsert',
      items: [{ ...item, id: 'hz-one', revision: 99 }],
      asOf: '2026-10-25T01:00:00Z',
    });
    await settle();
    expect(updates).toHaveLength(1);
    const result = updates[0];
    if (result.kind !== 'reset')
      throw new Error('Expected a replacement snapshot');
    expect(result.snapshot.items[0].revision).toBe(99);
    stop();
  });

  it('switches from demo to real after a stream snapshot without a second HTTP request', async () => {
    const real = new FakeDataService(snapshot([]));
    const service = new CompositeDataService(
      real,
      new FakeDataService(snapshot(['demo-one'], true)),
    );
    await service.loadSnapshot();
    const updates: LiveUpdate[] = [];
    const stop = service.subscribe(
      (event) => updates.push(event),
      () => {},
    );
    real.update({ kind: 'reset', snapshot: snapshot(['hz-one']) });
    await settle();
    expect(updates).toEqual([
      { kind: 'reset', snapshot: snapshot(['hz-one']) },
    ]);
    expect(real.loadSnapshot).toHaveBeenCalledTimes(1);
    stop();
  });

  it('suppresses a replacement that finishes after unsubscribe', async () => {
    const real = new FakeDataService(snapshot(['hz-one']));
    const service = new CompositeDataService(
      real,
      new FakeDataService(snapshot(['demo-one'], true)),
    );
    await service.loadSnapshot();
    const update = vi.fn();
    const stop = service.subscribe(update, () => {});
    real.update({ kind: 'reset', snapshot: snapshot(['hz-two']) });
    stop();
    await settle();
    expect(update).not.toHaveBeenCalled();
  });
});
