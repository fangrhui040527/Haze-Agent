import type { EvidenceCheck, Source } from '../../contracts/haze-evidence.js';

/**
 * How a value was produced (Spec §4.1). Never mix these up: a forecast is not an
 * observation, and a regional model cell is not a point measurement.
 */
export type EvidenceSourceKind = 'observation' | 'forecast' | 'modeled';

/**
 * A pinned evidence record: a working subset of the spec's haze.evidence.v2
 * (Spec §4.1, §4.3). Fields that do not apply are null with a stated reason,
 * never invented values.
 */
export interface EvidenceRecord {
  schemaVersion: 'haze.evidence.v2-subset';
  evidenceId: string;
  revision: 1;
  upstream: { system: string; id: string };
  /** SHA-256 of the exact bytes retrieved. Establishes which material is used, not its truth. */
  rawSha256: string;
  /** Content-addressed file in the raw archive (outside the World Model). */
  rawRef: string;
  rawBytes: number;
  sourceId: string;
  sourceKind: EvidenceSourceKind;
  title: string;
  sourceOwner: string;
  locator: {
    kind: 'data';
    /** Request URL with any credential removed. */
    url: string;
    selection: string;
  };
  pollutant: 'pm25' | null;
  unit: 'µg/m³' | null;
  issuedAt: string | null;
  issuedAtReason: string | null;
  validInterval: { start: string; end: string } | null;
  retrievedAt: string;
  /** HazeOps prepares evidence; it cannot accept it (Spec §2). */
  acceptedAt: null;
  acceptedAtReason: string;
  nativeTemporalResolution: string;
  spatialSupport: string;
  licenceRef: string;
  permittedUses: string[];
  limitations: string[];
  disposition: 'pinned_unreviewed';
  /** Identity/integrity and coverage/alignment checks (Spec §4.2 layers 1–2). */
  checks: EvidenceCheck[];
}

export interface PinnedEvidence {
  record: EvidenceRecord;
  raw: Buffer;
}

export interface StationDraft {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  provider: string;
  isMonitor: boolean;
  sensorId: number;
  nearestLocationId: string;
  distanceKm: number;
}

/** One value to assert in the World Model. */
export interface FactDraft {
  about: { type: 'location' | 'station'; id: string };
  predicate: string;
  value: Record<string, unknown>;
  /** When the value was measured or is valid for (becomes the provenance time). */
  observedAt: string;
  evidenceId: string;
  /**
   * When set, the fact is not written again if the newest stored fact for the same
   * subject and predicate has the same key (for example "no hotspots" twice in a row).
   */
  dedupeKey?: string;
}

export interface CoverageReport {
  requested: number;
  covered: number;
  excluded: { id: string; reason: string }[];
  gaps: string[];
}

export interface AdapterResult {
  evidence: PinnedEvidence[];
  stations: StationDraft[];
  facts: FactDraft[];
  coverage: CoverageReport;
}

/** Spec §12: a watcher declares all of this before it is enabled. */
export interface WatcherSpec {
  id: string;
  source: Source;
  /** Names of the environment variables it needs (values are never logged). */
  requiresEnv: string[];
  query: string;
  placeSelector: string;
  timeSelector: string;
  cadenceSec: number;
  rateLimit: string;
  /** How old the newest value may be before items show as stale. */
  freshnessMinutes: number;
}

export interface AdapterContext {
  now: Date;
  signal: AbortSignal;
  runId: string;
}

export interface SourceAdapter {
  spec: WatcherSpec;
  run(context: AdapterContext): Promise<AdapterResult>;
}
