import { z } from 'zod';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import {
  pilotInputSchema,
  pilotRecordBodySchema,
  type PilotInput,
  type PilotRecordBody,
  type PilotTaskView,
} from '../../../../app/contracts/damage-reduction-pilot.ts';
import type { ReductionProgrammeSnapshot } from '../../../../app/contracts/damage-reduction-programme.ts';

export const PILOT_RECORD_TYPES = [
  {
    kind: 'pilot_registration',
    label: 'Immutable protocol registration',
    guidance:
      'Bind exact reviewed feasibility, protocol and review references. Attest actual outcome-collection and analysis access. Haze records the append time; importing a record later cannot create earlier prespecification.',
  },
  {
    kind: 'pilot_amendment',
    label: 'Protocol amendment',
    guidance:
      'Name the original registration, new reviewed protocol and affected fields. Disclose whether outcomes were already available. The original registered analysis remains retained; outcome-aware amendments may be exploratory.',
  },
  {
    kind: 'digital_action',
    label: 'Digital-action event',
    guidance:
      'Record a simulation or an imported external event with its exact rule version, scope and timestamp. Reference actual service receipts for confirmation. This form sends no alert and applies no schedule.',
  },
  {
    kind: 'pilot_deviation',
    label: 'Pilot or delivery deviation',
    guidance:
      'Retain departures, affected action records, materiality and supporting evidence. A resolved flag alone cannot erase an earlier material deviation.',
  },
  {
    kind: 'delivery_verification',
    label: 'Independent delivery verification',
    guidance:
      'Reference a supplied verification artifact covering the exact action records. Its verifier, independence, conflicts, confirmation levels and limitations remain explicit. Partial verification is not complete delivery verification.',
  },
] as const;
export type PilotRecordKind = (typeof PILOT_RECORD_TYPES)[number]['kind'];

export function readPilotInputSource(source: Artifact): PilotInput {
  const value: unknown =
    typeof source.content === 'string'
      ? JSON.parse(source.content)
      : source.content;
  return pilotInputSchema.parse(value);
}

export function parsePilotRecord(
  text: string,
  selectedKind: PilotRecordKind,
): PilotRecordBody {
  if (new TextEncoder().encode(text).byteLength > 65_536)
    throw new Error(
      'Keep one typed record within 64 KiB. Import larger supporting payloads as artifacts and reference their exact versions.',
    );
  const value: unknown = JSON.parse(text);
  const record = pilotRecordBodySchema.parse(value);
  if (record.kind !== selectedKind)
    throw new Error(
      'The JSON record kind must match the selected record type.',
    );
  return record;
}

export function pilotValidationMessage(cause: unknown): string {
  if (cause instanceof z.ZodError)
    return cause.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'record'}: ${issue.message}`)
      .join(' · ');
  return cause instanceof Error
    ? cause.message.slice(0, 4096)
    : 'The typed record could not be validated.';
}

/** Editable guidance only: blank required attestations prevent accidental submission. */
export function pilotRecordTemplate(
  kind: PilotRecordKind,
  programme: ReductionProgrammeSnapshot,
  draft: PilotTaskView | null = null,
): unknown {
  const ref = {
    id: '<exact artifact UUID>',
    version: 1,
    sha256: '<64-character SHA-256>',
  };
  const specification = draft?.protocol?.value.specification;
  const rule = specification?.digital_rule;
  const scope = rule?.scope ?? {
    geography: programme.preview.selection.target.scope.geography,
    population: programme.preview.selection.target.scope.population,
    period: programme.preview.selection.target.scope.period,
    recipient_groups: [],
    schedule_ids: [],
  };
  switch (kind) {
    case 'pilot_registration':
      return {
        kind,
        feasibility_ref: draft?.feasibility?.artifact ?? ref,
        protocol_ref: draft?.protocol?.artifact ?? ref,
        review_ref: draft?.review?.artifact ?? ref,
        outcome_access: {
          collection: 'unknown',
          analysis: 'unknown',
          collection_started_at: null,
          analysis_started_at: null,
          attested_by: '',
          attested_at: '',
          evidence: [],
        },
        external_registration: null,
      };
    case 'pilot_amendment':
      return {
        kind,
        registration_id: '',
        amended_protocol_ref: draft?.protocol?.artifact ?? ref,
        review_ref: draft?.review?.artifact ?? ref,
        reason: '',
        affected_fields: [],
        outcomes_available: 'unknown',
        attested_by: '',
        attested_at: '',
      };
    case 'digital_action':
      return {
        kind,
        action_id: '',
        action_version: '',
        permitted_action: rule?.permitted_actions[0] ?? '',
        registration_id: null,
        rule: {
          id: rule?.id ?? '<agreed rule identifier>',
          version: rule?.version ?? '<agreed rule version>',
        },
        mode: 'simulated',
        status: 'proposed',
        action_kind: rule?.kind ?? programme.preview.candidate.kind,
        occurred_at: '',
        scope,
        trigger_refs: [],
        receipt_ref: null,
        reconciles_record_id: null,
        description: '',
      };
    case 'pilot_deviation':
      return {
        kind,
        registration_id: null,
        action_record_ids: [],
        category: '',
        description: '',
        material: true,
        status: 'unknown',
        occurred_at: '',
        evidence: [],
        resolves_deviation_id: null,
      };
    case 'delivery_verification':
      return {
        kind,
        registration_id: null,
        action_record_ids: [],
        verification_ref: ref,
      };
  }
}
