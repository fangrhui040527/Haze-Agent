import type { EvidenceCheck } from '../../../frontend/src/shared/types/domain.ts';
import {
  hashCheck,
  licenceCheck,
  pendingReviewChecks,
  provenanceCheck,
} from './checks.ts';
import { sha256 } from './http.ts';
import type { EvidenceRecord, PinnedEvidence } from './types.ts';

type EvidenceInput = Omit<
  EvidenceRecord,
  | 'schemaVersion'
  | 'evidenceId'
  | 'revision'
  | 'rawSha256'
  | 'rawRef'
  | 'rawBytes'
  | 'acceptedAt'
  | 'acceptedAtReason'
  | 'disposition'
  | 'checks'
> & {
  raw: Buffer;
  /** Coverage/alignment checks specific to this material. */
  coverageChecks: EvidenceCheck[];
};

/** Pin raw material as an immutable evidence record, identified by its content hash. */
export function pinEvidence(input: EvidenceInput): PinnedEvidence {
  const { raw, coverageChecks, ...rest } = input;
  const hash = sha256(raw);
  const record: EvidenceRecord = {
    schemaVersion: 'haze.evidence.v2-subset',
    evidenceId: `${input.sourceId}:${hash.slice(0, 16)}`,
    revision: 1,
    rawSha256: hash,
    rawRef: `raw/${hash}.json`,
    rawBytes: raw.length,
    ...rest,
    acceptedAt: null,
    acceptedAtReason:
      'Not accepted: HazeOps retrieves and prepares evidence but cannot accept it; acceptance needs an evidence steward (Spec §2).',
    disposition: 'pinned_unreviewed',
    checks: [
      hashCheck(hash, raw.length),
      licenceCheck(input.licenceRef),
      provenanceCheck(
        `${input.upstream.system}:${input.upstream.id}`,
        input.retrievedAt,
      ),
      ...coverageChecks,
      ...pendingReviewChecks(),
    ],
  };
  return { record, raw };
}

/** Combine several raw responses into one archived document with per-part hashes. */
export function bundleRaw(
  parts: { label: string; status: number; sha256: string; body: unknown }[],
): Buffer {
  return Buffer.from(
    JSON.stringify({ format: 'haze.raw-bundle.v1', parts }, null, 0),
  );
}
