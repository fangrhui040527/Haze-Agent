import {
  createStore,
  readLocal,
  removeLocal,
  writeLocal,
} from '../shared/lib/store.ts';
import type { DemoDataset } from '../shared/types/dataset.ts';
import type { HazeItem } from '../shared/types/domain.ts';
import { generateDataset } from './generator/generate.ts';
import type { Coverage } from './generator/locations.ts';
import { rebaseDataset } from './generator/rebase.ts';
import { validateDataset } from './generator/validate.ts';

/**
 * Holds the demo dataset in the browser.
 *
 * Load order: 1) a dataset saved in this browser (after Regenerate/Import),
 *             2) otherwise the committed seed file public/demo-data/demo-data.seed.json.
 * Simulated live events are kept in memory only; Export to keep them.
 */

export type DatasetOrigin =
  'none' | 'seed' | 'saved' | 'generated' | 'imported';

export interface DemoState {
  dataset: DemoDataset | null;
  origin: DatasetOrigin;
  /** Increases when the dataset is replaced (not when live events are added). */
  version: number;
  /** Number of simulated events added since the last replace. */
  liveEvents: number;
  saveWarning: string | null;
}

const STORAGE_KEY = 'haze.demo.dataset.v1';
const LEGACY_STORAGE_KEY = 'hazewatch.demo.dataset.v1';
export const SEED_URL = `${import.meta.env.BASE_URL}demo-data/demo-data.seed.json`;

export const demoStore = createStore<DemoState>({
  dataset: null,
  origin: 'none',
  version: 0,
  liveEvents: 0,
  saveWarning: null,
});

let loading: Promise<DemoDataset> | null = null;

async function fetchSeed(): Promise<DemoDataset> {
  const response = await fetch(SEED_URL);
  if (!response.ok)
    throw new Error(
      `Could not load demo seed file (${response.status}). Run "npm run data:generate".`,
    );
  const result = validateDataset(await response.json());
  if (!result.ok)
    throw new Error(`Demo seed file is invalid: ${result.errors[0]}`);
  return result.dataset;
}

function replace(
  dataset: DemoDataset,
  origin: DatasetOrigin,
  persist: boolean,
): void {
  let saveWarning: string | null = null;
  if (persist && !writeLocal(STORAGE_KEY, dataset)) {
    saveWarning =
      'Browser storage is full or blocked, so this dataset will be lost on reload. Use Export to keep it.';
  }
  demoStore.set((s) => ({
    dataset,
    origin,
    version: s.version + 1,
    liveEvents: 0,
    saveWarning,
  }));
}

/** Load the dataset once (later calls reuse it). Times are shifted so the newest item is "just now". */
export function loadDemoDataset(): Promise<DemoDataset> {
  const current = demoStore.get().dataset;
  if (current) return Promise.resolve(current);
  loading ??= (async () => {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
      const saved = readLocal<unknown>(key, null);
      if (saved === null) continue;
      const result = validateDataset(saved);
      if (result.ok) {
        // Only remove the old copy after the renamed key is safely persisted.
        // If storage is full, the original remains available on the next load.
        const migrating = key === LEGACY_STORAGE_KEY;
        replace(rebaseDataset(result.dataset, Date.now()), 'saved', migrating);
        if (migrating && !demoStore.get().saveWarning) removeLocal(key);
        return demoStore.get().dataset as DemoDataset;
      }
    }
    replace(rebaseDataset(await fetchSeed(), Date.now()), 'seed', false);
    return demoStore.get().dataset as DemoDataset;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export function regenerateDataset(
  seed: number,
  itemCount: number,
  coverage: Coverage = 'asean',
): void {
  replace(
    generateDataset({ seed, itemCount, now: new Date(), coverage }),
    'generated',
    true,
  );
}

export function importDataset(dataset: DemoDataset): void {
  replace(rebaseDataset(dataset, Date.now()), 'imported', true);
}

export async function resetToSeed(): Promise<void> {
  const seed = await fetchSeed();
  removeLocal(STORAGE_KEY);
  removeLocal(LEGACY_STORAGE_KEY);
  replace(rebaseDataset(seed, Date.now()), 'seed', false);
}

/** Merge simulated items (new or revised) into the in-memory dataset. */
export function applyLiveItems(changed: HazeItem[]): void {
  demoStore.set((s) => {
    if (!s.dataset) return s;
    const byId = new Map(changed.map((i) => [i.id, i]));
    const kept = s.dataset.items.filter((i) => !byId.has(i.id));
    return {
      ...s,
      dataset: { ...s.dataset, items: [...changed, ...kept] },
      liveEvents: s.liveEvents + changed.length,
    };
  });
}
