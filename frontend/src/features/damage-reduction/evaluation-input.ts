import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import {
  externalEvaluationInputSchema,
  scientificQualificationDossierSchema,
  evaluationRecordBodySchema,
  type EvaluationRecordBody,
} from '../../../../app/contracts/damage-reduction-evaluation.ts';

const original = (source: Artifact): unknown =>
  typeof source.content === 'string'
    ? JSON.parse(source.content)
    : source.content;
export const readEvaluationInput = (source: Artifact) =>
  externalEvaluationInputSchema.parse(original(source));
export const readEvaluationDossier = (source: Artifact) =>
  scientificQualificationDossierSchema.parse(original(source));
export const EVALUATION_RECORD_TYPES = [
  {
    kind: 'evaluation_qualification',
    label: 'Scientific qualification adoption or withdrawal',
    guidance:
      'Bind the exact external result, technical review and scientific dossier. Record an actual human adoption or withdrawal and its time. Imported approval flags and local structure validation cannot grant scientific qualification. Identify a superseded record when revising a prior decision.',
  },
  {
    kind: 'evaluation_objection',
    label: 'Evaluation objection or resolution',
    guidance:
      'Retain material and minor objections against the exact result. A resolution identifies the original objection and exact supporting evidence; a status flag cannot erase an unresolved material objection.',
  },
] as const;
export type EvaluationRecordKind =
  (typeof EVALUATION_RECORD_TYPES)[number]['kind'];
export function parseEvaluationRecord(
  text: string,
  selectedKind: string,
): EvaluationRecordBody {
  if (new TextEncoder().encode(text).byteLength > 65536)
    throw new Error(
      'Keep one typed record within 64 KiB; import larger supporting evidence as artifacts.',
    );
  const value: unknown = JSON.parse(text);
  const record = evaluationRecordBodySchema.parse(value);
  if (record.kind !== selectedKind)
    throw new Error(
      'The JSON record kind must match the selected record type.',
    );
  return record;
}
export function evaluationRecordTemplate(
  kind: string,
  refs: {
    result: ArtifactRef | null;
    review: ArtifactRef | null;
    dossier: ArtifactRef | null;
  },
): unknown {
  const missing = {
    id: '<exact artifact UUID>',
    version: 1,
    sha256: '<64-character SHA-256>',
  };
  if (kind === 'evaluation_qualification')
    return {
      kind,
      decision: 'unqualified',
      result_ref: refs.result ?? missing,
      technical_review_ref: refs.review ?? missing,
      dossier_ref: refs.dossier ?? missing,
      adopted_by: '',
      attested_at: '',
      reason: '',
      supersedes_record_id: null,
    };
  if (kind === 'evaluation_objection')
    return {
      kind,
      result_ref: refs.result ?? missing,
      severity: 'material',
      status: 'open',
      description: '',
      evidence: [],
      resolves_record_id: null,
    };
  throw new Error('Choose a supported evaluation record kind.');
}
