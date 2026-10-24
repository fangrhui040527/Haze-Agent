import type { DemoDataset } from '../../shared/types/dataset.ts';
import type {
  CategoryId,
  HazeItem,
  ItemStatus,
} from '../../shared/types/domain.ts';
import {
  createContext,
  makeItem,
  type GenContext,
  type ItemOverrides,
} from './generate.ts';
import {
  LOCATION_SEEDS,
  type LocationProfile,
  type LocationSeed,
} from './locations.ts';
import { SOURCE_SEEDS, type SourceSeed } from './sources.ts';

export type Scenario = 'normal' | 'spike' | 'outage' | 'conflict' | 'calm';

export const SCENARIOS: { id: Scenario; label: string; description: string }[] =
  [
    {
      id: 'normal',
      label: 'Normal',
      description: 'A mix of new items and revisions.',
    },
    {
      id: 'spike',
      label: 'Haze spike',
      description: 'Readings jump in haze-prone places; advisories follow.',
    },
    {
      id: 'outage',
      label: 'Source outage',
      description: 'Stations go offline; stale and missing data.',
    },
    {
      id: 'conflict',
      label: 'Conflicting reports',
      description: 'Sources disagree with each other.',
    },
    {
      id: 'calm',
      label: 'Calm day',
      description: 'Air improves; low readings and easing forecasts.',
    },
  ];

const DEFAULT_PROFILE: LocationProfile = {
  basePm25: 30,
  fireLand: null,
  driver: 'local sources (no demo profile for this place)',
  districts: ['Centre'],
};

/** Rebuild generator seeds from a (possibly imported or edited) dataset. */
function seedsFromDataset(dataset: DemoDataset): {
  locations: LocationSeed[];
  sources: SourceSeed[];
} {
  const profileById = new Map(
    LOCATION_SEEDS.map((l) => [l.location.id, l.profile]),
  );
  const scopeById = new Map(SOURCE_SEEDS.map((s) => [s.source.id, s.scope]));
  return {
    locations: dataset.locations.map((location) => ({
      location,
      profile: profileById.get(location.id) ?? DEFAULT_PROFILE,
    })),
    sources: dataset.sources.map((source) => ({
      source,
      scope: scopeById.get(source.id) ?? 'global',
    })),
  };
}

function overridesFor(ctx: GenContext, scenario: Scenario): ItemOverrides {
  const base: ItemOverrides = { ageHours: 0 };
  switch (scenario) {
    case 'spike': {
      const hazy = ctx.locations.filter((l) => l.profile.basePm25 >= 60);
      return {
        ...base,
        location: hazy.length > 0 ? ctx.rng.pick(hazy) : undefined,
        category: ctx.rng.weighted<CategoryId>([
          ['reading', 5],
          ['hotspot', 3],
          ['advisory', 2],
          ['disruption', 2],
        ]),
        pm25Multiplier: ctx.rng.float(1.8, 2.8),
        status: ctx.rng.weighted<ItemStatus>([
          ['verified', 3],
          ['partial', 2],
        ]),
        tags: ['simulated', 'spike'],
      };
    }
    case 'outage':
      return ctx.rng.chance(0.5)
        ? {
            ...base,
            category: 'sensor_issue',
            status: 'stale',
            tags: ['simulated', 'outage'],
          }
        : {
            ...base,
            category: 'reading',
            pm25: null,
            status: 'unverified',
            tags: ['simulated', 'outage'],
          };
    case 'conflict':
      return {
        ...base,
        category: ctx.rng.pick<CategoryId>(['reading', 'news', 'hotspot']),
        status: 'conflicting',
        tags: ['simulated', 'conflict'],
      };
    case 'calm':
      return ctx.rng.chance(0.6)
        ? {
            ...base,
            category: 'reading',
            pm25Multiplier: ctx.rng.float(0.15, 0.4),
            status: 'verified',
            tags: ['simulated', 'calm'],
          }
        : {
            ...base,
            category: 'forecast',
            pm25Multiplier: 0.4,
            forecastDirection: 'improving',
            status: 'verified',
            tags: ['simulated', 'calm'],
          };
    case 'normal':
      return { ...base, tags: ['simulated'] };
  }
}

/** Make a new revision of an existing item: same id, revision + 1, fresh values. */
function revise(
  ctx: GenContext,
  previous: HazeItem,
  scenario: Scenario,
): HazeItem {
  const location = ctx.locations.find(
    (l) => l.location.id === previous.locationId,
  );
  const next = makeItem(ctx, {
    ...overridesFor(ctx, scenario),
    location,
    category: previous.category,
  });
  return {
    ...next,
    id: previous.id,
    revision: previous.revision + 1,
    relatedIds: previous.relatedIds,
    timeline: [
      ...previous.timeline,
      ...next.timeline.map((t) =>
        t.label.startsWith('Stored by World Model')
          ? {
              ...t,
              label: `Stored by World Model (revision ${previous.revision + 1}; revision ${previous.revision} superseded)`,
            }
          : t,
      ),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    tags: [...new Set([...previous.tags, 'revised'])],
  };
}

export interface SimulateOptions {
  count: number;
  scenario: Scenario;
  now: number;
  seed: number;
}

/**
 * Create `count` live events: new items or revisions of existing items.
 * Returns only the changed items; the caller merges them into the dataset.
 */
export function simulateEvents(
  dataset: DemoDataset,
  { count, scenario, now, seed }: SimulateOptions,
): HazeItem[] {
  const { locations, sources } = seedsFromDataset(dataset);
  if (locations.length === 0 || sources.length === 0) return [];
  const ctx = createContext(
    seed,
    now,
    locations,
    sources,
    `sim-${now.toString(36)}`,
  );
  const revisable = dataset.items.filter((i) => i.status !== 'retracted');
  const changed = new Map<string, HazeItem>();

  for (let i = 0; i < count; i++) {
    const shouldRevise =
      scenario !== 'outage' && revisable.length > 0 && ctx.rng.chance(0.4);
    if (shouldRevise) {
      const target = ctx.rng.pick(revisable.slice(0, 60));
      const current = changed.get(target.id) ?? target;
      changed.set(target.id, revise(ctx, current, scenario));
    } else {
      const item = makeItem(ctx, overridesFor(ctx, scenario));
      changed.set(item.id, item);
    }
  }
  return [...changed.values()];
}
