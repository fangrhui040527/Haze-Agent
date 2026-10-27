import type { ArtifactRef } from '../../contracts/artifacts.js';
import {
  pilotInputSchema,
  type DigitalServiceReceipt,
  type PilotCurrentDraft,
  type PilotInput,
  type PilotRecordBody,
} from '../../contracts/damage-reduction-pilot.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../damage-reduction-planning/fixtures.js';

export const FROZEN_PILOT_CASES = Object.freeze([
  { id: 'missing-scientific-inputs', classification: 'conditional' },
  {
    id: 'unusable-comparator',
    classification: 'delivery_exposure_feasibility_only',
  },
  {
    id: 'inadequate-precision',
    classification: 'delivery_exposure_feasibility_only',
  },
  { id: 'synthetic-complete', classification: 'conditional' },
  { id: 'late-registration', timing: 'late_or_outcome_aware' },
  { id: 'outcome-aware-amendment', analysis: 'exploratory' },
  { id: 'simulation-with-receipt', recorded_delivery: false },
  { id: 'human-report', recorded_delivery: false },
  { id: 'provider-acceptance', effective_status: 'submitted' },
  { id: 'unknown-replay', effective_status: 'unknown' },
] as const);

/** Invented engineering content only. The UI must retain its synthetic origin. */
export function syntheticPilotInput(): PilotInput {
  const target = SYNTHETIC_REDUCTION_TARGET;
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
      statement: `Synthetic engineering fixture: scientific ${topic} evidence is outstanding.`,
      evidence: [],
    })),
    calculations: [],
    assumptions: [
      'Entirely synthetic engineering data; no scientific or operational readiness.',
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
        id: 'synthetic-alert-rule',
        version: '1',
        kind: 'exposure_alert',
        owner: null,
        approval: {
          status: 'proposed',
          approver: null,
          approved_at: null,
          evidence: [],
        },
        trigger_inputs: [],
        trigger_rule: null,
        permitted_actions: ['Simulated proposed exposure alert only.'],
        scope: {
          geography: target.scope.geography,
          population: target.scope.population,
          period: target.scope.period,
          recipient_groups: ['synthetic-workers'],
          schedule_ids: [],
        },
        safeguards: ['Synthetic disabled service; no recipients contacted.'],
        pause_disable_rule:
          'Keep the synthetic service disabled; no live adapter is configured.',
      },
    },
  });
}

/** A structurally complete supplied-attestation example, still invented test data. */
export function suppliedCompletePilotInput(evidence: ArtifactRef): PilotInput {
  const input = syntheticPilotInput();
  input.origin = 'supplied';
  input.scientific_owner = 'Fixture scientific owner';
  input.findings = input.findings.map((finding) => ({
    ...finding,
    status: 'usable',
    statement: `Supplied test declaration for ${finding.topic}; independent scientific validity is not established by this fixture.`,
    evidence: [evidence],
  }));
  input.calculations = [evidence];
  input.design_review = {
    reviewer: 'Fixture independent design reviewer',
    role: 'Supplied scientific review attestation',
    independent: true,
    conflicts: 'none_declared',
    decision: 'supports_design',
    reviewed_at: '2026-10-01T00:00:00Z',
    evidence: [evidence],
    adopted_by: 'Fixture local operator',
  };
  input.protocol_spec.design_name =
    'Externally specified synthetic comparative design';
  input.protocol_spec.baseline_window = {
    start: '2026-12-01',
    end: '2026-12-31',
  };
  input.protocol_spec.analysis_method = {
    id: 'supplied-design-analysis',
    version: '1',
    description:
      'Supplied design-specific calculation; Haze does not reproduce its scientific estimator.',
    uncertainty_rule: 'point_estimate',
    interpretation:
      'Use the registered point-estimate criterion only; uncertainty is supplied separately.',
  };
  input.protocol_spec.missingness_rule =
    'Retain missing observations; do not substitute estimates without a registered amendment.';
  input.protocol_spec.deviation_rule =
    'Append all material departures and preserve the original analysis.';
  input.protocol_spec.stopping_criteria = [
    'Disable the service if the supplied safeguard is breached.',
  ];
  input.protocol_spec.delivery_checks = [
    'Inspect the exact service receipt and independent verification required by the design.',
  ];
  const rule = input.protocol_spec.digital_rule!;
  rule.owner = 'Fixture rule owner';
  rule.trigger_rule = 'Only the supplied scoped trigger can propose an alert.';
  rule.trigger_inputs = [{ name: 'supplied-trigger', evidence: [evidence] }];
  rule.approval = {
    status: 'approved',
    approver: 'Fixture human rule approver',
    approved_at: '2026-10-01T00:00:00Z',
    evidence: [evidence],
  };
  return input;
}
export function syntheticPilotRegistration(
  draft: PilotCurrentDraft,
  now = new Date().toISOString(),
): PilotRecordBody {
  return {
    kind: 'pilot_registration',
    feasibility_ref: draft.feasibility.artifact,
    protocol_ref: draft.protocol.artifact,
    review_ref: draft.review.artifact,
    outcome_access: {
      collection: 'not_started',
      analysis: 'not_started',
      collection_started_at: null,
      analysis_started_at: null,
      attested_by: 'Synthetic local operator attestation',
      attested_at: now,
      evidence: [],
    },
    external_registration: null,
  };
}
export function syntheticDigitalActionRecord(
  registrationId: string | null = null,
): Extract<PilotRecordBody, { kind: 'digital_action' }> {
  const rule = syntheticPilotInput().protocol_spec.digital_rule!;
  return {
    kind: 'digital_action',
    action_id: 'synthetic-action-1',
    action_version: '1',
    permitted_action: rule.permitted_actions[0]!,
    registration_id: registrationId,
    rule: { id: rule.id, version: rule.version },
    mode: 'simulated',
    status: 'proposed',
    action_kind: rule.kind,
    occurred_at: '2027-01-02T12:00:00Z',
    scope: rule.scope,
    trigger_refs: [],
    receipt_ref: null,
    reconciles_record_id: null,
    description:
      'Synthetic simulated alert proposal; no recipient is contacted.',
  };
}
export function syntheticActionReceipt(
  action: Extract<
    PilotRecordBody,
    { kind: 'digital_action' }
  > = syntheticDigitalActionRecord(),
): DigitalServiceReceipt {
  return {
    schema_version: 'haze.reduction.service-receipt.v1',
    origin: 'synthetic',
    service: 'Synthetic service fixture; no live adapter',
    receipt_id: `${action.action_id}-receipt`,
    action_id: action.action_id,
    action_version: action.action_version,
    permitted_action: action.permitted_action,
    trigger_refs: action.trigger_refs,
    rule: action.rule,
    action_kind: action.action_kind,
    scope: action.scope,
    occurred_at: action.occurred_at,
    status: 'confirmed',
    confirmation_level:
      action.action_kind === 'exposure_alert'
        ? 'alert_transmitted'
        : 'schedule_applied',
    raw_receipt_ref: null,
  };
}
