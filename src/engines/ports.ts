/** Haze's narrow ports for the pinned upstream facades. Engine behavior stays upstream. */
export type MiningEvent =
  | 'chat_message'
  | 'user_correction'
  | 'file_save'
  | 'file_open'
  | 'file_edit'
  | 'model_response'
  | 'plan_completion';

export interface MemoryRecord {
  id: string;
  content: string;
  confidence: number;
  source: string;
  provenance: { origin: string; learnedAt: number; label: string };
  tags: string[];
}

export interface MemoryAuditEntry {
  memoryId: string;
  action: string;
  actor: string;
  timestamp: number;
  previousState?: Partial<MemoryRecord>;
  newState?: Partial<MemoryRecord>;
  details?: Record<string, unknown>;
}

export interface MemoryQuery {
  memories: { memory: MemoryRecord; relevance: number }[];
  context: string;
  trace: {
    retrievalReason: string;
    strategy: 'minimal' | 'personal' | 'comprehensive';
    scores: Record<string, number>;
  };
}

export interface MemoryEngine {
  mine(
    event: MiningEvent,
    text: string,
    options?: { chatId?: string },
  ): Promise<MemoryRecord[]>;
  query(
    text: string,
    options?: { topN?: number; threshold?: number; chatId?: string },
  ): MemoryQuery;
  feedback(id: string, kind: 'helpful' | 'not_helpful' | 'wrong'): void;
  ledger: {
    all(): readonly MemoryAuditEntry[];
    history(id: string): MemoryAuditEntry[];
  };
}

export interface WorldProvenance {
  kind: string;
  at: string | Date;
  by?: string;
  url?: string;
  checksum?: string;
  runId?: string;
}

export interface WorldEntity {
  id: string;
  type: string;
  name?: string;
  attrs: Record<string, unknown>;
  aliases: string[];
  schemaVersion: number;
  source: Omit<WorldProvenance, 'at'> & { at: string };
}

export interface EntityInput {
  type: string;
  name?: string;
  externalKey?: { system: string; id: string };
  attrs?: Record<string, unknown>;
  source: WorldProvenance;
}

export interface Observation {
  externalId: string;
  type?: string;
  title: string;
  text?: string;
  at: string;
  source: WorldProvenance;
  entities?: { type: string; name: string }[];
}

export interface IngestReport {
  runId: string;
  processed: number;
  skippedUnchanged: number;
  clusters: number;
  eventsAppended: number;
  changed: boolean;
}

export interface WorldEvent {
  id: string;
  seq: number;
  kind: string;
  payload: unknown;
  schemaVersion: number;
  at: string;
}

export interface WorldAuditEntry {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  summary: string;
}

export interface WorldEngine {
  upsertEntity(input: EntityInput): Promise<WorldEntity>;
  ingest(observations: Observation[]): Promise<IngestReport>;
  view(name: 'graph'): {
    entity(id: string): WorldEntity | undefined;
    query(options: { type?: string }): WorldEntity[];
  };
  events(): readonly WorldEvent[];
  audit(): readonly WorldAuditEntry[];
  stateShapeCanonical(): string;
}

export interface WorldUtilities {
  entityIdFromName(type: string, name: string): string;
  externalId(type: string, system: string, id: string): string;
  nameSimilarity(left: string, right: string): number;
  decide(similarity: number): 'auto-merge' | 'review' | 'new';
}

export interface EngineProvenance {
  repository: string;
  revision: string;
  sha256: string;
  /** Actual local compiled entrypoint, never an upstream download URL. */
  entrypoint: string;
  /** SHA-256 of the compiled entrypoint that was verified before import. */
  entrypointSha256: string;
  loadedSource: string;
}
