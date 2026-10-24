import { delay } from '../../shared/lib/delay.ts';
import type { DemoDataset } from '../../shared/types/dataset.ts';
import type {
  ConnectionStatus,
  ItemDetail,
} from '../../shared/types/domain.ts';
import {
  applyLiveItems,
  demoStore,
  loadDemoDataset,
} from '../../mock/demoStore.ts';
import {
  simulateEvents,
  type Scenario,
} from '../../mock/generator/simulate.ts';
import { mockSettings } from '../../mock/settings.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';

/** DataService backed by the fictional demo dataset, with simulated live events. */
export class MockDataService implements DataService {
  readonly label = 'Mock (fictional demo data)';
  private listeners = new Set<(update: LiveUpdate) => void>();
  private simulationCount = 0;

  async loadSnapshot(signal?: AbortSignal): Promise<DataSnapshot> {
    const settings = mockSettings.get();
    await delay(settings.latencyMs, signal);
    if (settings.failNextLoad) {
      mockSettings.set((s) => ({ ...s, failNextLoad: false }));
      throw new Error(
        'Simulated load failure (turned on from the Demo Data page).',
      );
    }
    return toSnapshot(await loadDemoDataset());
  }

  async getItem(id: string, signal?: AbortSignal): Promise<ItemDetail | null> {
    await delay(Math.min(400, mockSettings.get().latencyMs), signal);
    const dataset = await loadDemoDataset();
    const item = dataset.items.find((i) => i.id === id);
    if (!item) return null;
    const sourceById = new Map(dataset.sources.map((s) => [s.id, s]));
    return {
      item,
      location: dataset.locations.find((l) => l.id === item.locationId) ?? null,
      sources: [...new Set(item.sources.map((r) => r.sourceId))]
        .map((sid) => sourceById.get(sid))
        .filter((s) => s !== undefined),
      related: item.relatedIds
        .map((rid) => dataset.items.find((i) => i.id === rid))
        .filter((i) => i !== undefined),
    };
  }

  subscribe(
    onUpdate: (update: LiveUpdate) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): () => void {
    this.listeners.add(onUpdate);
    onStatus('live');

    // Dataset replaced (regenerate / import / reset) -> tell the UI to reload everything.
    let seenVersion = demoStore.get().version;
    const unsubscribeStore = demoStore.subscribe(() => {
      const { version, dataset } = demoStore.get();
      if (version !== seenVersion && dataset) {
        seenVersion = version;
        onUpdate({ kind: 'reset', snapshot: toSnapshot(dataset) });
      }
    });

    // Automatic simulated events, restarted whenever the settings change.
    let timer: ReturnType<typeof setInterval> | null = null;
    const restart = () => {
      if (timer) clearInterval(timer);
      timer = null;
      const { autoSimulate, intervalSec, scenario } = mockSettings.get();
      if (autoSimulate) {
        timer = setInterval(
          () => this.simulate(1, scenario),
          Math.max(2, intervalSec) * 1000,
        );
      }
    };
    restart();
    const unsubscribeSettings = mockSettings.subscribe(restart);

    return () => {
      this.listeners.delete(onUpdate);
      unsubscribeStore();
      unsubscribeSettings();
      if (timer) clearInterval(timer);
    };
  }

  /** Add `count` simulated events now (used by the timer and the Demo Data page). */
  simulate(count: number, scenario: Scenario): number {
    const dataset = demoStore.get().dataset;
    if (!dataset) return 0;
    const now = Date.now();
    const changed = simulateEvents(dataset, {
      count,
      scenario,
      now,
      seed: (now ^ (++this.simulationCount * 2654435761)) >>> 0,
    });
    if (changed.length === 0) return 0;
    applyLiveItems(changed);
    const update: LiveUpdate = {
      kind: 'upsert',
      items: changed,
      asOf: new Date(now).toISOString(),
    };
    this.listeners.forEach((listener) => listener(update));
    return changed.length;
  }

  /** The current in-memory dataset (used by the mock agents to answer questions). */
  currentDataset(): DemoDataset | null {
    return demoStore.get().dataset;
  }
}

function toSnapshot(dataset: DemoDataset): DataSnapshot {
  return {
    items: dataset.items,
    locations: dataset.locations,
    sources: dataset.sources,
    asOf: new Date().toISOString(),
    fictional: dataset.fictional,
  };
}
