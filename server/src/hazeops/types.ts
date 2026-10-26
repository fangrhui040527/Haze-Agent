import type { CoverageReport } from '../../../dist/capabilities/evidence-collection/types.js';
export type {
  EvidenceSourceKind,
  EvidenceRecord,
  PinnedEvidence,
  StationDraft,
  FactDraft,
  CoverageReport,
  AdapterResult,
  WatcherSpec,
  AdapterContext,
  SourceAdapter,
} from '../../../dist/capabilities/evidence-collection/types.js';

export interface WatcherState {
  id: string;
  enabled: boolean;
  disabledReason: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: 'ok' | 'unchanged' | 'failed' | 'skipped' | null;
  lastError: string | null;
  /** SHA-256 of the last accepted raw material (duplicate detection). */
  cursor: string | null;
  /** Newest observation time written to the World Model. */
  acceptedThrough: string | null;
  nextDueAt: string | null;
  lastCoverage: CoverageReport | null;
  lastDurationMs: number | null;
  attempts: number;
  /** The last chat request this watcher ran for, word for word (null for scheduled runs). */
  lastRequest: {
    assignmentId: string;
    objective: string;
    at: string;
  } | null;
}
