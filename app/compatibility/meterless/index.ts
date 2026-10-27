import { resolve } from 'node:path';
import { loadPinnedEngines } from './loader.js';
import type { EntityInput, MiningEvent, Observation } from './ports.js';

export type * from './ports.js';

export interface HazeEngineOptions {
  memoryDirectory: string;
  worldDirectory: string;
  namespace: string;
  clock?: () => number;
}

/** Instantiate the build-vendored engines; all storage, ranking and folds stay upstream. */
export async function openHazeEngines(options: HazeEngineOptions) {
  if (!options.memoryDirectory.trim() || !options.worldDirectory.trim()) {
    throw new Error(
      'Haze engines require explicit memoryDirectory and worldDirectory',
    );
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(options.namespace)) {
    throw new Error(
      'World Model namespace must contain only letters, digits, underscores or hyphens',
    );
  }
  const loaded = await loadPinnedEngines();
  const memory = new loaded.HMEM({
    persistDir: resolve(options.memoryDirectory),
    actor: 'haze',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const world = new loaded.WorldModel({
    storage: 'local',
    directory: resolve(options.worldDirectory),
    namespace: options.namespace,
    ...(options.clock ? { clock: () => new Date(options.clock!()) } : {}),
  });

  return {
    provenance: loaded.provenance,
    memory: {
      mine: (event: MiningEvent, text: string, opts?: { chatId?: string }) =>
        memory.mine(event, text, opts),
      query: (
        text: string,
        opts?: { topN?: number; threshold?: number; chatId?: string },
      ) => memory.query(text, opts),
      feedback: (id: string, kind: 'helpful' | 'not_helpful' | 'wrong') =>
        memory.feedback(id, kind),
      audit: () => memory.ledger.all(),
      history: (id: string) => memory.ledger.history(id),
    },
    world: {
      entityId: (type: string, name: string) =>
        loaded.utilities.entityIdFromName(type, name),
      externalId: (type: string, system: string, id: string) =>
        loaded.utilities.externalId(type, system, id),
      nameSimilarity: (left: string, right: string) =>
        loaded.utilities.nameSimilarity(left, right),
      resolutionDecision: (similarity: number) =>
        loaded.utilities.decide(similarity),
      upsertEntity: (input: EntityInput) => world.upsertEntity(input),
      ingest: (observations: Observation[]) => world.ingest(observations),
      entity: (id: string) => world.view('graph').entity(id),
      entities: (opts: { type?: string } = {}) =>
        world.view('graph').query(opts),
      events: () => world.events(),
      audit: () => world.audit(),
      projectionCanonical: () => world.stateShapeCanonical(),
    },
  };
}
