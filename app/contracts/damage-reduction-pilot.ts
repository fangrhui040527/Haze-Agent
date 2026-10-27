import { z } from 'zod';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from './artifacts.js';
import { identifierSchema } from './common.js';

const text = z.string().trim().min(1).max(4096);
const refs = z.array(artifactRefSchema).max(16);
const timestamp = z.iso.datetime({ offset: true });
const decimal = z
  .string()
  .max(33)
  .regex(/^(?:0|(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/)
  .refine(
    (value) =>
      value.replace('.', '').replace(/^0+/, '').length <= 18 &&
      (value.split('.')[1]?.length ?? 0) <= 12,
  );
/** Date-only v1 windows use inclusive UTC calendar days. */
export const pilotDateWindowSchema = z
  .strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine(
    (value) => value.start <= value.end,
    'Observation window must be ordered.',
  );
export const pilotOperatingScopeSchema = z.strictObject({
  geography: text,
  population: text,
  period: pilotDateWindowSchema,
  recipient_groups: z.array(identifierSchema).max(32),
  schedule_ids: z.array(identifierSchema).max(32),
});
export const pilotRuleRefSchema = z.strictObject({
  id: identifierSchema,
  version: identifierSchema,
});
export const digitalRuleSchema = z.strictObject({
  ...pilotRuleRefSchema.shape,
  kind: z.enum(['exposure_alert', 'work_schedule']),
  owner: text.nullable(),
  approval: z.strictObject({
    status: z.enum(['proposed', 'approved']),
    approver: text.nullable(),
    approved_at: timestamp.nullable(),
    evidence: refs,
  }),
  trigger_inputs: z
    .array(z.strictObject({ name: identifierSchema, evidence: refs }))
    .max(16),
  trigger_rule: text.nullable(),
  permitted_actions: z.array(text).max(16),
  scope: pilotOperatingScopeSchema,
  safeguards: z.array(text).max(16),
  pause_disable_rule: text.nullable(),
});
export const pilotScientificReviewSchema = z.strictObject({
  reviewer: text,
  role: text,
  independent: z.boolean(),
  conflicts: z.enum(['none_declared', 'resolved', 'unresolved']),
  decision: z.enum(['supports_design', 'conditional', 'rejects_design']),
  reviewed_at: timestamp,
  evidence: refs,
  adopted_by: text.nullable(),
});
export const pilotFindingSchema = z.strictObject({
  topic: z.enum([
    'design_identification',
    'comparator',
    'baseline',
    'measurement',
    'outcome_latency',
    'precision_power',
    'attrition_clustering',
    'budget_timing',
  ]),
  status: z.enum(['usable', 'unavailable', 'unknown']),
  statement: text,
  evidence: refs,
});
export const pilotProtocolSpecSchema = z.strictObject({
  id: identifierSchema,
  version: identifierSchema,
  design_name: text.nullable(),
  primary_endpoint: text.nullable(),
  unit: text.nullable(),
  population: text.nullable(),
  comparator: text.nullable(),
  observation_window: pilotDateWindowSchema.nullable(),
  baseline_window: pilotDateWindowSchema.nullable(),
  analysis_method: z
    .strictObject({
      id: identifierSchema,
      version: identifierSchema,
      description: text,
      uncertainty_rule: z.enum([
        'point_estimate',
        'uncertainty_bound',
        'probability',
        'external_reviewed',
      ]),
      interpretation: text,
    })
    .nullable(),
  target_rule: z
    .strictObject({
      fraction: decimal.refine(
        (value) => value !== '0' && (value === '1' || value.startsWith('0.')),
      ),
      relation: z.enum(['at_least', 'greater_than']),
      assessment_rule: z.literal('point_estimate'),
    })
    .nullable(),
  missingness_rule: text.nullable(),
  deviation_rule: text.nullable(),
  stopping_criteria: z.array(text).max(16),
  delivery_checks: z.array(text).max(16),
  digital_rule: digitalRuleSchema.nullable(),
});
export const pilotInputSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.pilot-input.v1'),
  origin: z.enum(['synthetic', 'supplied']),
  scientific_owner: text.nullable(),
  intended_kind: z.enum([
    'damage_evaluation',
    'delivery',
    'exposure',
    'feasibility',
  ]),
  findings: z.array(pilotFindingSchema).max(8),
  calculations: refs,
  assumptions: z.array(text).max(16),
  design_review: pilotScientificReviewSchema.nullable(),
  protocol_spec: pilotProtocolSpecSchema,
});
const binding = {
  programme_id: z.uuid(),
  input_ref: artifactRefSchema,
  selection_ref: artifactRefSchema,
  assessment_ref: artifactRefSchema,
  plan_ref: artifactRefSchema,
  plan_review_ref: artifactRefSchema,
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
export const pilotFeasibilitySchema = z.strictObject({
  schema_version: z.literal('haze.reduction.pilot-feasibility.v1'),
  ...binding,
  origin: z.enum(['synthetic', 'supplied']),
  classification: z.enum([
    'damage_evaluation_capable',
    'conditional',
    'delivery_exposure_feasibility_only',
  ]),
  classification_basis: z.enum([
    'supplied_scientific_review_attestation',
    'engineering_completeness_only',
  ]),
  intended_kind: pilotInputSchema.shape.intended_kind,
  findings: z.array(pilotFindingSchema).max(8),
  calculations: refs,
  assumptions: z.array(text).max(16),
  scientific_review: pilotScientificReviewSchema.nullable(),
  prerequisites: z.array(text).max(48),
  limitations: z.array(text).max(16),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export const pilotProtocolSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.pilot-protocol.v1'),
  ...binding,
  origin: z.enum(['synthetic', 'supplied']),
  status: z.literal('draft'),
  specification: pilotProtocolSpecSchema,
  prerequisites: z.array(text).max(48),
  limitations: z.array(text).max(16),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export const pilotReviewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.pilot-review.v1'),
  programme_id: z.uuid(),
  input_ref: artifactRefSchema,
  reviewed_artifacts: z.array(artifactRefSchema).min(2).max(16),
  reviewer: z.strictObject({
    assignment_id: z.uuid(),
    revision: z.number().int().positive(),
  }),
  verdict: z.enum(['supported', 'rejected', 'needs_review']),
  checks: z
    .array(
      z.strictObject({
        code: identifierSchema,
        passed: z.boolean(),
        detail: text,
      }),
    )
    .max(32),
  findings: z.array(text).max(48),
  limitations: z.array(text).max(16),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export const pilotOutcomeAccessSchema = z.strictObject({
  collection: z.enum(['not_started', 'started', 'complete', 'unknown']),
  analysis: z.enum(['not_started', 'started', 'complete', 'unknown']),
  collection_started_at: timestamp.nullable(),
  analysis_started_at: timestamp.nullable(),
  attested_by: text,
  attested_at: timestamp,
  evidence: refs,
});
export const pilotRegistrationRecordSchema = z.strictObject({
  kind: z.literal('pilot_registration'),
  feasibility_ref: artifactRefSchema,
  protocol_ref: artifactRefSchema,
  review_ref: artifactRefSchema,
  outcome_access: pilotOutcomeAccessSchema,
  external_registration: z
    .strictObject({
      registered_at: timestamp,
      evidence: artifactRefSchema,
      registry: text,
    })
    .nullable(),
});
export const pilotAmendmentRecordSchema = z.strictObject({
  kind: z.literal('pilot_amendment'),
  registration_id: z.uuid(),
  amended_protocol_ref: artifactRefSchema,
  review_ref: artifactRefSchema,
  reason: text,
  affected_fields: z
    .array(
      z.enum([
        'target',
        'comparator',
        'population',
        'endpoint',
        'observation_window',
        'analysis',
        'missingness',
        'deviations',
        'stopping',
        'digital_rule',
        'operating_scope',
      ]),
    )
    .min(1)
    .max(11),
  outcomes_available: z.enum(['no', 'yes', 'unknown']),
  attested_by: text,
  attested_at: timestamp,
});
export const pilotDigitalActionRecordSchema = z.strictObject({
  kind: z.literal('digital_action'),
  action_id: identifierSchema,
  action_version: identifierSchema,
  permitted_action: text,
  registration_id: z.uuid().nullable(),
  rule: pilotRuleRefSchema,
  mode: z.enum(['simulated', 'imported_live']),
  status: z.enum(['proposed', 'submitted', 'confirmed', 'failed', 'unknown']),
  action_kind: z.enum(['exposure_alert', 'work_schedule']),
  occurred_at: timestamp,
  scope: pilotOperatingScopeSchema,
  trigger_refs: refs,
  receipt_ref: artifactRefSchema.nullable(),
  reconciles_record_id: z.uuid().nullable(),
  description: text,
});
export const pilotDeviationRecordSchema = z.strictObject({
  kind: z.literal('pilot_deviation'),
  registration_id: z.uuid().nullable(),
  action_record_ids: z.array(z.uuid()).max(16),
  category: identifierSchema,
  description: text,
  material: z.boolean(),
  status: z.enum(['open', 'resolved', 'unknown']),
  occurred_at: timestamp,
  evidence: refs,
  resolves_deviation_id: z.uuid().nullable(),
});
export const pilotDeliveryVerificationRecordSchema = z.strictObject({
  kind: z.literal('delivery_verification'),
  registration_id: z.uuid().nullable(),
  action_record_ids: z.array(z.uuid()).min(1).max(16),
  verification_ref: artifactRefSchema,
});
export const pilotRecordBodySchema = z.discriminatedUnion('kind', [
  pilotRegistrationRecordSchema,
  pilotAmendmentRecordSchema,
  pilotDigitalActionRecordSchema,
  pilotDeviationRecordSchema,
  pilotDeliveryVerificationRecordSchema,
]);
export const digitalServiceReceiptSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.service-receipt.v1'),
  origin: z.enum(['imported_service', 'human_report', 'synthetic']),
  service: text,
  receipt_id: identifierSchema,
  action_id: identifierSchema,
  action_version: identifierSchema,
  permitted_action: text,
  trigger_refs: refs,
  rule: pilotRuleRefSchema,
  action_kind: z.enum(['exposure_alert', 'work_schedule']),
  scope: pilotOperatingScopeSchema,
  occurred_at: timestamp,
  status: z.enum(['accepted', 'confirmed', 'failed', 'unknown']),
  confirmation_level: z.enum([
    'none',
    'provider_accepted',
    'alert_transmitted',
    'alert_received',
    'schedule_applied',
  ]),
  raw_receipt_ref: artifactRefSchema.nullable(),
});
export const pilotExternalRegistrationSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.external-registration.v1'),
  origin: z.enum(['supplied', 'synthetic']),
  registry: text,
  registered_at: timestamp,
  protocol_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: refs,
});
export const pilotDeliveryVerificationSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.delivery-verification.v1'),
  origin: z.enum(['supplied', 'synthetic']),
  verifier: z.strictObject({
    name: text,
    role: text,
    independent: z.boolean(),
    conflicts: z.enum(['none_declared', 'resolved', 'unresolved']),
    attested_at: timestamp,
  }),
  actions: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        action_id: identifierSchema,
        action_version: identifierSchema,
        permitted_action: text,
        trigger_refs: refs,
        rule: pilotRuleRefSchema,
        scope: pilotOperatingScopeSchema,
        verdict: z.enum(['verified', 'partial', 'failed', 'unknown']),
        confirmation_level:
          digitalServiceReceiptSchema.shape.confirmation_level,
        evidence: refs,
      }),
    )
    .min(1)
    .max(16),
  limitations: z.array(text).max(16),
});
export const reductionPilotTaskViewSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.pilot-task-view.v1'),
  task_id: z.uuid(),
  run_id: z.uuid(),
  objective_revision: z.number().int().positive(),
  state: z.enum(['pending', 'current', 'stale', 'unavailable']),
  feasibility: z
    .strictObject({
      artifact: artifactRefSchema,
      value: pilotFeasibilitySchema,
    })
    .nullable(),
  protocol: z
    .strictObject({ artifact: artifactRefSchema, value: pilotProtocolSchema })
    .nullable(),
  review: z
    .strictObject({ artifact: artifactRefSchema, value: pilotReviewSchema })
    .nullable(),
  reasons: z.array(text).max(48),
  live_delivery: z.literal('deferred'),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export const pilotDeliveryProjectionSchema = z.strictObject({
  feasibility: z
    .strictObject({
      classification: pilotFeasibilitySchema.shape.classification,
      origin: pilotFeasibilitySchema.shape.origin,
      current: z.boolean(),
      prerequisites: z.array(text).max(48),
    })
    .nullable(),
  registrations: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        protocol_ref: artifactRefSchema,
        effective_protocol_ref: artifactRefSchema,
        recorded_at: timestamp,
        timing: z.enum([
          'attested_before_outcomes',
          'external_prior_registration_attested',
          'late_or_outcome_aware',
          'unknown',
        ]),
        currency: z.enum(['current', 'stale']),
        analysis_status: z.enum([
          'original',
          'prospective_amended',
          'exploratory',
          'unknown',
        ]),
        reasons: z.array(text).max(32),
      }),
    )
    .max(32),
  amendments: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        registration_id: z.uuid(),
        status: z.enum([
          'prospective_amendment_attested',
          'exploratory',
          'stale',
        ]),
        reasons: z.array(text).max(32),
      }),
    )
    .max(32),
  actions: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        action_id: identifierSchema,
        origin: z.enum([
          'simulated',
          'imported_service',
          'human_report',
          'unknown',
        ]),
        effective_status: z.enum([
          'simulated',
          'proposed',
          'submitted',
          'confirmed',
          'failed',
          'unknown',
        ]),
        confirmation_level:
          digitalServiceReceiptSchema.shape.confirmation_level,
        recorded_delivery: z.boolean(),
        independent_verification: z.enum(['none', 'partial', 'verified']),
        currency: z.enum(['current', 'stale']),
        reasons: z.array(text).max(32),
      }),
    )
    .max(32),
  deviations: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        unresolved: z.boolean(),
        material: z.boolean(),
        reasons: z.array(text).max(16),
      }),
    )
    .max(32),
  verifications: z
    .array(
      z.strictObject({
        record_id: z.uuid(),
        status: z.enum(['verified', 'partial', 'unsupported', 'stale']),
        covered_action_record_ids: z.array(z.uuid()).max(16),
        reasons: z.array(text).max(32),
      }),
    )
    .max(32),
  reasons: z.array(text).max(48),
  live_delivery: z.literal('deferred'),
  scientific_qualification: z.literal('unqualified'),
  achieved_reduction: z.literal(false),
});
export type PilotInput = z.infer<typeof pilotInputSchema>;
export type PilotFeasibility = z.infer<typeof pilotFeasibilitySchema>;
export type PilotProtocol = z.infer<typeof pilotProtocolSchema>;
export type PilotReview = z.infer<typeof pilotReviewSchema>;
export type PilotRecordBody = z.infer<typeof pilotRecordBodySchema>;
export type DigitalServiceReceipt = z.infer<typeof digitalServiceReceiptSchema>;
export type PilotDeliveryVerification = z.infer<
  typeof pilotDeliveryVerificationSchema
>;
export type PilotDeliveryProjection = z.infer<
  typeof pilotDeliveryProjectionSchema
>;
export type ReductionPilotTaskView = z.infer<
  typeof reductionPilotTaskViewSchema
>;
export interface PilotDraftContext {
  evidence?: readonly Artifact[];
  candidate_kind?: 'exposure_alert' | 'work_schedule';
  expected_scientific_owner?: string | null;
  planning_objections?: readonly string[];
  planned_rules?: {
    owner: string | null;
    trigger: string | null;
    action: string | null;
    approval?: {
      status: 'proposed' | 'approved';
      approver: string | null;
      approved_at: string | null;
      evidence: ArtifactRef[];
    };
  };
  programme_id: string;
  input_ref: ArtifactRef;
  selection_ref: ArtifactRef;
  assessment_ref: ArtifactRef;
  plan_ref: ArtifactRef;
  plan_review_ref: ArtifactRef;
  target_sha256: string;
  scope_sha256: string;
  target: {
    target_fraction: string;
    relation: 'at_least' | 'greater_than';
    assessment_rule: 'point_estimate';
    comparator: string;
    intervention: string;
    scope: {
      endpoint: string;
      unit: string;
      population: string;
      geography: string;
      pollutant: string;
      period: { start: string; end: string };
      coverage: string;
      missingness: string;
      exclusions: string[];
    };
  };
}
export interface PilotCurrentDraft {
  attempt_id: string;
  feasibility: { artifact: ArtifactRef; value: PilotFeasibility };
  protocol: { artifact: ArtifactRef; value: PilotProtocol };
  review: { artifact: ArtifactRef; value: PilotReview };
}
export interface PilotRecordContext {
  identity: { principal: string; workspace: string };
  readArtifact(ref: ArtifactRef): Artifact;
  assertEvidenceCurrent(ref: ArtifactRef): void;
  now: string;
  current_draft: PilotCurrentDraft | null;
  current_lineage?: {
    selection_ref: ArtifactRef;
    assessment_ref: ArtifactRef;
    plan_ref: ArtifactRef;
    plan_review_ref: ArtifactRef;
  } | null;
}
export const pilotProgrammeProjectionSchema = pilotDeliveryProjectionSchema;
export const pilotTaskViewSchema = reductionPilotTaskViewSchema;
export type PilotProgrammeProjection = PilotDeliveryProjection;
export type PilotTaskView = ReductionPilotTaskView;

/** Browser-safe, visibly synthetic draft input; it supplies no scientific findings. */
export function syntheticPilotInputExample(
  target: PilotDraftContext['target'],
  kind: 'exposure_alert' | 'work_schedule' = 'exposure_alert',
): PilotInput {
  return pilotInputSchema.parse({
    schema_version: 'haze.reduction.pilot-input.v1',
    origin: 'synthetic',
    scientific_owner: null,
    intended_kind: 'damage_evaluation',
    findings: [
      'design_identification',
      'comparator',
      'baseline',
      'measurement',
      'outcome_latency',
      'precision_power',
      'attrition_clustering',
      'budget_timing',
    ].map((topic) => ({
      topic,
      status: 'unknown',
      statement: `Synthetic draft: scientific ${topic} evidence is outstanding.`,
      evidence: [],
    })),
    calculations: [],
    assumptions: [
      'Synthetic engineering example only; no scientific or live readiness.',
    ],
    design_review: null,
    protocol_spec: {
      id: 'synthetic-pilot-protocol',
      version: '1',
      design_name: null,
      primary_endpoint: target.scope.endpoint,
      unit: target.scope.unit,
      population: target.scope.population,
      comparator: target.comparator,
      observation_window: target.scope.period,
      baseline_window: null,
      analysis_method: null,
      target_rule: {
        fraction: target.target_fraction,
        relation: target.relation,
        assessment_rule: 'point_estimate',
      },
      missingness_rule: null,
      deviation_rule: null,
      stopping_criteria: [],
      delivery_checks: [],
      digital_rule: {
        id: 'synthetic-digital-rule',
        version: '1',
        kind,
        owner: null,
        approval: {
          status: 'proposed',
          approver: null,
          approved_at: null,
          evidence: [],
        },
        trigger_inputs: [],
        trigger_rule: null,
        permitted_actions: ['Simulated proposed digital action only.'],
        scope: {
          geography: target.scope.geography,
          population: target.scope.population,
          period: target.scope.period,
          recipient_groups:
            kind === 'exposure_alert' ? ['synthetic-group'] : [],
          schedule_ids: kind === 'work_schedule' ? ['synthetic-schedule'] : [],
        },
        safeguards: ['Synthetic disabled service; no live action.'],
        pause_disable_rule: 'Keep the synthetic service disabled.',
      },
    },
  });
}
