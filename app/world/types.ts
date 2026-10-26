/** Dashboard-compatible views over Haze's authoritative SQLite records. */
export type { AdapterResult } from '../capabilities/evidence-collection/types.js';
export interface WmProvenance {
  kind: string;
  by?: string;
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
  source: WmProvenance;
  assertedAt: string;
  context?: string;
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

export interface WriteSummary {
  evidenceWritten: number;
  factsWritten: number;
  factsSkipped: number;
  stationsWritten: number;
  newestObservation: string | null;
}
