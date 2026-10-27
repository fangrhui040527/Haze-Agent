import type {
  EvaluationTaskView,
  ProgrammeEvaluationProjection,
} from '../../../../app/contracts/damage-reduction-evaluation.ts';
import {
  syntheticExternalEvaluationInput,
  syntheticQualificationDossier,
} from '../../../../app/capabilities/damage-reduction-programmes/evaluation-fixtures.ts';
import {
  artifactRef,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';
import {
  programmeId,
  attemptId,
  programmeView,
} from './programme-test-fixtures.ts';

export function evaluationInput() {
  const programme = programmeView().programme;
  return syntheticExternalEvaluationInput({
    programme_id: programmeId,
    target_sha256: 'a'.repeat(64),
    scope_sha256: programme.preview.selection.scope_sha256,
    scope: programme.preview.selection.target.scope,
    registration_id: attemptId,
    protocol_ref: artifactRef,
    action_record_ids: [],
    rules: [{ id: 'fixture-rule', version: '7' }],
    report_ref: artifactRef,
    data_ref: artifactRef,
    review_ref: artifactRef,
    expected_output_ref: artifactRef,
  });
}
export const evaluationDossier = () =>
  syntheticQualificationDossier(evaluationInput(), artifactRef);
export function evaluationTask(): EvaluationTaskView {
  const input = evaluationInput();
  return {
    task_id: taskId,
    run_id: runId,
    objective_revision: 1,
    state: 'current',
    result: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.external-evaluation.v1',
        programme_id: programmeId,
        input_ref: artifactRef,
        dossier_ref: artifactRef,
        method_id: 'reduction.external-residual-comparison.v1',
        method_version: '1',
        source_method: input.source_method,
        design: input.design,
        target_sha256: input.target_sha256,
        scope_sha256: input.scope_sha256,
        protocol: input.protocol,
        delivery: input.delivery,
        scope: input.scope,
        criterion: input.criterion,
        registered_target: input.registered_target,
        original_estimates: input.comparative_estimates,
        status: 'supported',
        reasons: ['Synthetic package has no actual delivery.'],
        origin: 'synthetic',
        baseline_damage: '1000',
        intervention_damage: '880',
        absolute_reduction: '120',
        relative_reduction: { numerator: '120', denominator: '1000' },
        target_met: true,
        reproduced: [
          'Exact residual subtraction and threshold cross-multiplication.',
        ],
        inspected: ['Declared comparative design and exact source versions.'],
        externally_calculated: [
          'Causal estimator and uncertainty calculation.',
        ],
        uncertainty_interpretation: input.uncertainty_interpretation,
        material_limitations: input.material_limitations,
        limitations: ['Engineering arithmetic only.'],
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    learning: {
      artifact: { ...artifactRef, version: 2 },
      value: {
        schema_version: 'haze.reduction.evaluation-learning.v1',
        programme_id: programmeId,
        input_ref: artifactRef,
        target_sha256: input.target_sha256,
        scope_sha256: input.scope_sha256,
        protocol_ref: artifactRef,
        origin: 'synthetic',
        outcome: 'point_estimate_meets',
        lessons: ['The invented quantities meet the numerical criterion only.'],
        next_requirements: [
          'Supply a non-synthetic reviewed programme evaluation trace.',
        ],
        evidence: [artifactRef],
        publication: 'not_published',
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    review: {
      artifact: { ...artifactRef, version: 3 },
      value: {
        schema_version: 'haze.reduction.evaluation-review.v1',
        programme_id: programmeId,
        input_ref: artifactRef,
        dossier_ref: artifactRef,
        reviewed_artifacts: [artifactRef, { ...artifactRef, version: 2 }],
        reviewer: { assignment_id: runId, revision: 1 },
        verdict: 'supported',
        checks: [
          {
            code: 'exact-comparison',
            passed: true,
            detail: 'Independently reconstructed point comparison.',
          },
        ],
        findings: [],
        qualification_check: {
          status: 'incomplete',
          reasons: ['No non-synthetic dossier or actual delivery.'],
        },
        reproduced: ['Exact threshold only.'],
        limitations: ['No scientific qualification.'],
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    reasons: [],
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
}
export function evaluationProjection(): ProgrammeEvaluationProjection {
  return {
    current: evaluationTask(),
    qualification: {
      status: 'unqualified',
      record_id: null,
      dossier_ref: null,
      adopted_by: null,
      human_attestation: true,
      reasons: ['No qualified human adoption.'],
    },
    claim: {
      eligible: false,
      label: 'point_estimate_meets_target',
      point_estimate: 'meets',
      reasons: [
        'Synthetic engineering sources cannot establish an evaluated effect.',
      ],
      reproduction_limits: ['Causal estimation and uncertainty are external.'],
    },
    qualifications: [],
    objections: [],
    reasons: [],
    operational_release: 'gated_pending_non_synthetic_trace',
    achieved_reduction: false,
  };
}
