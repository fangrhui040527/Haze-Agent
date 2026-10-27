import type { ArtifactRef } from '../../contracts/artifacts.js';
import {
  externalEvaluationInputSchema,
  scientificQualificationDossierSchema,
  type ExternalEvaluationInput,
  type ExternalEvaluationExpectedOutput,
  type ScientificQualificationDossier,
  type EvaluationMethodContext,
} from '../../contracts/damage-reduction-evaluation.js';

/** Frozen engineering expectations, fixed before the numerical implementation. */
export const FROZEN_EVALUATION_CASES = Object.freeze([
  {
    id: 'supported',
    baseline: '1000',
    intervention: '880',
    difference: '120',
    target_met: true,
  },
  {
    id: 'below-target',
    baseline: '1000',
    intervention: '950',
    difference: '50',
    target_met: false,
  },
  {
    id: 'threshold-equality',
    baseline: '1000',
    intervention: '900',
    difference: '100',
    target_met: true,
  },
  {
    id: 'missing-intervention',
    baseline: '1000',
    intervention: null,
    difference: null,
    target_met: null,
  },
  {
    id: 'zero-baseline',
    baseline: '0',
    intervention: '1',
    difference: '-1',
    target_met: null,
  },
  { id: 'unsupported-bound', criterion: 'uncertainty_bound', target_met: null },
  { id: 'unsupported-probability', criterion: 'probability', target_met: null },
] as const);
export interface EvaluationFixtureBindings {
  programme_id: string;
  target_sha256: string;
  scope_sha256: string;
  scope: ExternalEvaluationInput['scope'];
  registration_id: string;
  protocol_ref: ArtifactRef;
  amendment_record_ids?: string[];
  analysis_basis?:
    'original_registered' | 'prospectively_amended' | 'exploratory';
  action_record_ids: string[];
  deviation_record_ids?: string[];
  verification_record_ids?: string[];
  rules: { id: string; version: string }[];
  report_ref: ArtifactRef;
  data_ref: ArtifactRef;
  review_ref: ArtifactRef;
  expected_output_ref: ArtifactRef;
  target_fraction?: string;
  relation?: 'at_least' | 'greater_than';
  source_method?: { id: string; version: string };
  registered_design_name?: string;
}
export function syntheticExternalEvaluationInput(
  bindings: EvaluationFixtureBindings,
): ExternalEvaluationInput {
  return externalEvaluationInputSchema.parse({
    schema_version: 'haze.reduction.external-evaluation-input.v1',
    origin: 'synthetic',
    programme_id: bindings.programme_id,
    target_sha256: bindings.target_sha256,
    scope_sha256: bindings.scope_sha256,
    protocol: {
      analysis_basis: bindings.analysis_basis ?? 'original_registered',
      registration_id: bindings.registration_id,
      protocol_ref: bindings.protocol_ref,
      amendment_record_ids: bindings.amendment_record_ids ?? [],
    },
    delivery: {
      action_record_ids: bindings.action_record_ids,
      deviation_record_ids: bindings.deviation_record_ids ?? [],
      verification_record_ids: bindings.verification_record_ids ?? [],
      accounted_deviation_record_ids: bindings.deviation_record_ids ?? [],
      rules: bindings.rules,
    },
    source_method: bindings.source_method ?? {
      id: 'supplied-design-analysis',
      version: '1',
    },
    design: {
      id: 'synthetic-external-design',
      version: '1',
      identification: 'externally_reviewed_comparative',
      registered_name:
        bindings.registered_design_name ??
        'Externally specified synthetic comparative design',
      description:
        'Invented externally specified comparative design; no causal estimator or scientific readiness is established.',
      assumptions: [
        'Synthetic engineering example; no real programme or service effect.',
      ],
      requires_independent_delivery_verification: true,
    },
    scope: bindings.scope,
    comparative_estimates: { baseline: '1000', intervention: '880' },
    criterion: {
      kind: 'point_estimate',
      interpretation:
        'Compare supplied residual point estimates exactly; no uncertainty conclusion.',
      dependence_assumptions: [
        'Dependence is externally specified; no covariance or probability is calculated by Haze.',
      ],
    },
    registered_target: {
      fraction: bindings.target_fraction ?? '0.1',
      relation: bindings.relation ?? 'at_least',
    },
    report_refs: [bindings.report_ref],
    data_refs: [bindings.data_ref],
    external_review_refs: [bindings.review_ref],
    expected_output_refs: [bindings.expected_output_ref],
    authors: [
      {
        name: 'Synthetic external evaluation author',
        role: 'Invented evaluation author',
      },
    ],
    uncertainty_interpretation:
      'Point comparison only. Uncertainty and causal identification are not reproduced.',
    material_limitations: [
      'Entirely synthetic engineering fixture; cannot establish actual delivery, scientific qualification or achieved reduction.',
    ],
  });
}
export function syntheticEvaluationExpectedOutput(
  input: ExternalEvaluationInput,
): ExternalEvaluationExpectedOutput {
  return {
    schema_version: 'haze.reduction.external-expected-output.v1',
    origin: 'synthetic',
    programme_id: input.programme_id,
    target_sha256: input.target_sha256,
    scope_sha256: input.scope_sha256,
    source_method: input.source_method,
    design: { id: input.design.id, version: input.design.version },
    criterion: input.criterion.kind,
    baseline_damage: '1000',
    intervention_damage: '880',
    absolute_reduction: '120',
    relative_reduction: { numerator: '120', denominator: '1000' },
    target_met: true,
    prepared_by: 'Frozen independently expected engineering arithmetic example',
    evidence: input.report_refs,
  };
}
export function syntheticQualificationDossier(
  input: ExternalEvaluationInput,
  inputRef: ArtifactRef,
): ScientificQualificationDossier {
  return scientificQualificationDossierSchema.parse({
    schema_version: 'haze.reduction.scientific-qualification-dossier.v1',
    origin: 'synthetic',
    programme_id: input.programme_id,
    evaluation_input_ref: inputRef,
    target_sha256: input.target_sha256,
    scope_sha256: input.scope_sha256,
    source_method: input.source_method,
    design: input.design,
    scope: input.scope,
    protocol: input.protocol,
    delivery: input.delivery,
    criterion: input.criterion,
    intended_use: 'this_programme_damage_target_evaluation',
    reference_case: {
      name: 'Synthetic engineering reference fixture',
      description: 'No real scientific reference case is claimed.',
      evidence: input.report_refs,
    },
    scientific_owner: 'Synthetic scientific owner attestation',
    authors: input.authors,
    reviewer: {
      name: 'Synthetic independent scientific reviewer',
      role: 'Invented reviewer; credentials not authenticated',
      independent: true,
      conflicts: 'none_declared',
      reviewed_at: '2026-10-01T00:00:00Z',
    },
    applicability: {
      decision: 'conditional',
      statement: 'Engineering-only fixture; no operational applicability.',
      prerequisites: ['Supply a reviewed non-synthetic reference case.'],
      unresolved_material_objections: [],
    },
    decision: 'conditional',
    reasons: [
      'Imported flags and model agreement never grant scientific qualification.',
    ],
    report_refs: input.report_refs,
    data_refs: input.data_refs,
    external_review_refs: input.external_review_refs,
    expected_output_refs: input.expected_output_refs,
    evidence: input.external_review_refs,
    material_limitations: input.material_limitations,
    uncertainty_interpretation: input.uncertainty_interpretation,
  });
}
export function evaluationFixtureContext(
  input: ExternalEvaluationInput,
  inputRef: ArtifactRef,
  target: EvaluationMethodContext['target'],
  evidence: EvaluationMethodContext['evidence'],
): EvaluationMethodContext {
  return {
    programme_id: input.programme_id,
    input_ref: inputRef,
    dossier_ref: null,
    target,
    target_sha256: input.target_sha256,
    scope_sha256: input.scope_sha256,
    registration_id: input.protocol.registration_id,
    analysis_basis: input.protocol.analysis_basis,
    protocol_ref: input.protocol.protocol_ref,
    amendment_record_ids: input.protocol.amendment_record_ids,
    delivery: {
      action_record_ids: input.delivery.action_record_ids,
      confirmed_action_record_ids: input.delivery.action_record_ids,
      deviation_record_ids: input.delivery.deviation_record_ids,
      unresolved_material_deviation_record_ids: [],
      verification_record_ids: input.delivery.verification_record_ids,
      rules: input.delivery.rules,
    },
    evidence,
  };
}
