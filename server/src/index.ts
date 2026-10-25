import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type {
  HazeItem,
  Location,
} from '../../frontend/src/shared/types/domain.ts';
import type { NearbyReading } from './runs/answer.ts';
import { createApp } from './api/app.ts';
import { loadConfig, REPOSITORY_ROOT } from './config.ts';
import { openEngines } from './engines.ts';
import { firmsAdapter, firmsSpec } from './hazeops/adapters/firms.ts';
import { openAqAdapter, openAqSpec } from './hazeops/adapters/openAq.ts';
import {
  openMeteoAdapter,
  openMeteoSpec,
} from './hazeops/adapters/openMeteo.ts';
import {
  loadPinnedQueries,
  zetarisAdapter,
  zetarisSpec,
} from './hazeops/adapters/zetaris.ts';
import { HazeOps } from './hazeops/hazeops.ts';
import { distanceKm, locationsFor } from './locations.ts';
import { Manager } from './manager/manager.ts';
import { ChatMemory } from './memory/memory.ts';
import { Runtime } from './runtime/runtime.ts';
import { RunService } from './runs/runs.ts';
import { TaskService } from './tasks/tasks.ts';
import { HazeWorld, localId } from './world/hazeWorld.ts';
import {
  projectItems,
  projectLocations,
  projectSources,
} from './world/projection.ts';

const SCHEDULER_INTERVAL_MS = 30_000;
const WATCHER_DEADLINE_MS = 120_000;
const STATUS_RECHECK_MS = 5 * 60_000;
const CHANGE_DEBOUNCE_MS = 750;

const config = loadConfig();
const engines = await openEngines(config.stateDir);
const world = new HazeWorld(engines.world, config.stateDir);
const locations = locationsFor(config.coverage);
const hazeops = new HazeOps(
  world,
  join(config.stateDir, 'hazeops', 'watchers.json'),
);

// Register every watcher; one that cannot run is shown as disabled with its reason.
const offline = config.sampleMode
  ? 'SAMPLE_MODE=true disables network sources'
  : null;
if (offline) hazeops.registerDisabled(openMeteoSpec(locations), offline);
else hazeops.register(openMeteoAdapter(locations));

if (offline) hazeops.registerDisabled(openAqSpec(), offline);
else if (config.keys.openAq)
  hazeops.register(openAqAdapter(locations, config.keys.openAq));
else hazeops.registerDisabled(openAqSpec(), 'OPEN_AQ_KEY is not set');

if (offline) hazeops.registerDisabled(firmsSpec(), offline);
else if (config.keys.firms)
  hazeops.register(firmsAdapter(locations, config.keys.firms));
else hazeops.registerDisabled(firmsSpec(), 'FIRMS_MAP_KEY is not set');

const queries = loadPinnedQueries(
  join(REPOSITORY_ROOT, 'server/config/zetaris-queries.json'),
);
if (offline) hazeops.registerDisabled(zetarisSpec(queries), offline);
else if (config.keys.zetarisUsername && config.keys.zetarisPassword) {
  hazeops.register(
    zetarisAdapter(locations, {
      baseUrl: config.zetarisBaseUrl,
      username: config.keys.zetarisUsername,
      password: config.keys.zetarisPassword,
      queries,
    }),
  );
} else
  hazeops.registerDisabled(
    zetarisSpec(queries),
    'ZETARIS_USERNAME / ZETARIS_PASSWORD are not set',
  );

const configAt = new Date().toISOString();
await world.syncLocations(locations, configAt);
await world.syncSources(hazeops.specs(), configAt);

const runtime = new Runtime();
const manager = new Manager();
const memory = new ChatMemory(engines.memory);

const snapshot = () => {
  const items = projectItems({
    world,
    specsBySource: new Map(hazeops.specs().map((s) => [s.source.id, s])),
    lastRunMs: hazeops.lastRunMs(),
    now: new Date(),
  });
  return {
    items,
    locations: projectLocations(world),
    sources: projectSources(hazeops.specs()),
  };
};

// Live table updates: recompute after World Model writes and push only changed rows.
const itemListeners = new Set<(items: HazeItem[]) => void>();
const lastSent = new Map<string, string>();
const keyOf = (i: HazeItem) =>
  `${i.revision}|${i.status}|${i.observedAt}|${i.updatedAt}`;
for (const item of snapshot().items) lastSent.set(item.id, keyOf(item));
let pending: ReturnType<typeof setTimeout> | null = null;
const publishChanges = () => {
  pending = null;
  const changed = snapshot().items.filter(
    (item) => lastSent.get(item.id) !== keyOf(item),
  );
  for (const item of changed) lastSent.set(item.id, keyOf(item));
  if (changed.length > 0)
    for (const listener of itemListeners) listener(changed);
};
world.onFact(() => {
  pending ??= setTimeout(publishChanges, CHANGE_DEBOUNCE_MS);
});
setInterval(publishChanges, STATUS_RECHECK_MS).unref(); // fresh -> stale transitions

const readingsNear = (
  place: Location,
  km: number,
  items: HazeItem[],
): NearbyReading[] => {
  const byId = new Map(items.map((i) => [i.id, i]));
  return world
    .entities('station')
    .map((station) => ({
      station,
      km: distanceKm(place, {
        lat: Number(station.attrs.lat),
        lon: Number(station.attrs.lon),
      }),
      item: byId.get(`hz-observed-${localId(station.id)}`),
    }))
    .filter(
      (s): s is typeof s & { item: HazeItem } =>
        s.km <= km && s.item !== undefined,
    )
    .map((s) => ({
      item: s.item,
      stationName: s.station.name ?? localId(s.station.id),
      km: s.km,
    }));
};

const runs: RunService = new RunService({
  hazeops,
  manager,
  runtime,
  memory,
  snapshot,
  freshItems: () => snapshot().items,
  readingsNear,
  startTask: (framing) => tasks.start(framing),
});
const tasks = new TaskService({
  manager,
  runtime,
  freshItems: () => snapshot().items,
  readingsNear,
  refresh: (places, brief, signal) =>
    runs.refreshIfStale(places, brief, signal),
});

const tick = (): string[] => {
  const due = hazeops.dueWatchers(new Date());
  for (const id of due) {
    runtime.admit(
      `watcher:${id}`,
      `HazeOps ${id}`,
      WATCHER_DEADLINE_MS,
      (signal) =>
        hazeops
          .runWatcher(id, signal, `tick-${Date.now().toString(36)}`)
          .then((report) => {
            const s = report.summary;
            console.log(
              `[hazeops] ${id}: ${report.outcome}${s ? ` (evidence +${s.evidenceWritten}, facts +${s.factsWritten}, skipped ${s.factsSkipped})` : ''}${report.error ? ` - ${report.error}` : ''} in ${report.durationMs} ms`,
            );
            return report;
          }),
    );
  }
  return due;
};

const app = createApp({
  world,
  hazeops,
  manager,
  runtime,
  runs,
  tasks,
  memory,
  provenance: engines.provenance,
  snapshot,
  onItemsChanged: (listener) => {
    itemListeners.add(listener);
    return () => itemListeners.delete(listener);
  },
  tick,
  config: {
    coverage: config.coverage,
    sampleMode: config.sampleMode,
    operatorToken: config.operatorToken,
  },
  startedAt: configAt,
});

const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) => {
    console.log(
      `[haze] API on http://${info.address}:${info.port} (coverage: ${config.coverage}, ${locations.length} places)`,
    );
    for (const { spec, state } of hazeops.watchers()) {
      console.log(
        `[hazeops] watcher ${spec.id}: ${state.enabled ? 'enabled' : `disabled (${state.disabledReason})`}`,
      );
    }
  },
);

if (config.schedulerEnabled) {
  tick();
  setInterval(tick, SCHEDULER_INTERVAL_MS).unref();
}

const shutdown = () => {
  console.log('[haze] shutting down');
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
