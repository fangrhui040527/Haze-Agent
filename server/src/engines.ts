import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from './config.ts';

/**
 * Opens the pinned Meterless engines through the repository's existing loader
 * (app/adapters/meterless/loader.ts, compiled to dist/). The loader verifies the
 * pinned revision and SHA-256 hashes; this server never opens unpinned copies.
 *
 * The loader's TypeScript port only lists a subset of the World Model API, so the
 * full surface this server relies on is declared below. Every method listed here
 * exists on the pinned reference implementation (revision 1742dec).
 */

export interface WmProvenance {
  kind: string;
  by?: string;
  /** Observation time. The World Model derives record timestamps from it. */
  at: string;
  url?: string;
  checksum?: string;
  runId?: string;
}

export interface WmEntity {
  type: string;
  id: string;
  attrs: Record<string, unknown>;
  source: WmProvenance;
  createdAt: string;
  updatedAt: string;
  name?: string;
  aliases: string[];
  state: 'emerging' | 'active' | 'archived';
}

export interface WmFact {
  id: string;
  about: string;
  predicate: string;
  value: unknown;
  confidence: number;
  context?: string;
  source: WmProvenance;
  assertedAt: string;
  supersededBy?: string;
}

export interface WmRelationship {
  id: string;
  from: string;
  type: string;
  to: string;
  attrs?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  source: WmProvenance;
  createdAt: string;
  supersededBy?: string;
}

export interface WmEvent {
  id: string;
  seq: number;
  kind: string;
  payload: unknown;
  at: string;
}

export interface WmAuditEntry {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  summary: string;
  eventId?: string;
  runId?: string;
}

export interface WmGraphView {
  entity(id: string): WmEntity | undefined;
  query(options: {
    type?: string;
    where?: (entity: WmEntity) => boolean;
  }): WmEntity[];
  neighborsOf(id: string, options?: { via?: string }): WmEntity[];
  incoming(id: string, options?: { via?: string }): WmEntity[];
}

export interface WmFactsView {
  about(id: string): WmFact[];
}

export interface WorldModelEngine {
  upsertEntity(input: {
    type: string;
    externalKey?: { system: string; id: string };
    name?: string;
    attrs?: Record<string, unknown>;
    source: WmProvenance;
    state?: WmEntity['state'];
  }): Promise<WmEntity>;
  relate(input: {
    from: string;
    type: string;
    to: string;
    attrs?: Record<string, unknown>;
    validFrom?: string;
    source: WmProvenance;
  }): Promise<WmRelationship>;
  assertFact(input: {
    about: string;
    predicate: string;
    value: unknown;
    confidence?: number;
    source: WmProvenance;
  }): Promise<WmFact>;
  view(name: 'graph'): WmGraphView;
  view(name: 'facts'): WmFactsView;
  events(): readonly WmEvent[];
  audit(): readonly WmAuditEntry[];
  subscribeEvents(listener: (event: WmEvent) => void): () => void;
}

export interface HmemRecord {
  id: string;
  content: string;
  type: string;
  tags: string[];
  timestamp: number;
  confidence: number;
  source: string;
  chatId?: string;
}

export interface HmemEngine {
  add(input: {
    content: string;
    type?: 'personal' | 'factual' | 'preference' | 'general';
    tags?: string[];
    confidence?: number;
    source: string;
    provenance?: {
      origin: 'chat_message' | 'model_response' | 'manual';
      learnedAt: number;
      label: string;
      refs?: string[];
    };
    chatId?: string;
  }): HmemRecord;
  query(
    text: string,
    options?: { topN?: number; threshold?: number; chatId?: string },
  ): {
    memories: { memory: HmemRecord; relevance: number }[];
    trace: { retrievalReason: string; strategy: string };
  };
  feedback(memoryId: string, kind: 'helpful' | 'not_helpful' | 'wrong'): void;
}

export interface EngineProvenanceSummary {
  component: string;
  repository: string;
  revision: string;
  sha256: string;
}

export interface OpenedEngines {
  world: WorldModelEngine;
  memory: HmemEngine;
  provenance: EngineProvenanceSummary[];
}

interface LoaderModule {
  loadPinnedEngines(): Promise<{
    HMEM: new (options: Record<string, unknown>) => unknown;
    WorldModel: new (options: Record<string, unknown>) => unknown;
    provenance: Record<
      string,
      { repository: string; revision: string; sha256: string }
    >;
  }>;
}

export const WORLD_NAMESPACE = 'haze';

export async function openEngines(stateDir: string): Promise<OpenedEngines> {
  const loaderUrl = pathToFileURL(
    join(REPOSITORY_ROOT, 'dist/adapters/meterless/loader.js'),
  ).href;
  let loader: LoaderModule;
  try {
    loader = (await import(loaderUrl)) as LoaderModule;
  } catch (error) {
    throw new Error(
      'Pinned engine loader not found. Run "npm run build" in the repository root first.',
      { cause: error },
    );
  }
  const loaded = await loader.loadPinnedEngines();

  const worldDirectory = join(stateDir, 'world');
  const memoryDirectory = join(stateDir, 'memory');
  mkdirSync(worldDirectory, { recursive: true });
  mkdirSync(memoryDirectory, { recursive: true });

  // most-recent-wins: the newest observation time decides which value lands on the
  // entity; older or rival facts are kept and marked superseded, never deleted.
  const world = new loaded.WorldModel({
    namespace: WORLD_NAMESPACE,
    storage: 'local',
    directory: worldDirectory,
    conflictPolicy: 'most-recent-wins',
  }) as WorldModelEngine;
  const memory = new loaded.HMEM({
    persistDir: memoryDirectory,
    actor: 'haze',
  }) as HmemEngine;

  return {
    world,
    memory,
    provenance: Object.entries(loaded.provenance).map(([component, p]) => ({
      component,
      repository: p.repository,
      revision: p.revision,
      sha256: p.sha256,
    })),
  };
}
