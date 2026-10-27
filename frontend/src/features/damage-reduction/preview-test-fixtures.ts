import type { AgentRun } from '../dashboard/useAgentRun.ts';
import type { ReductionPreviewView } from '../../../../app/contracts/damage-reduction-view.ts';
import { syntheticReductionCandidate } from '../../../../app/capabilities/damage-reduction-planning/planning-fixtures.ts';
import { SYNTHETIC_REDUCTION_TARGET } from '../../../../app/capabilities/damage-reduction-planning/fixtures.ts';
import {
  artifactRef,
  fixtureTask,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';

export function previewRun(): AgentRun {
  return {
    events: [],
    status: 'completed',
    statusText: 'Saved preview ready.',
    startedAt: null,
    serviceLabel: 'Fixture',
    ask: () =>
      Promise.reject(new Error('A rendering fixture cannot execute tasks.')),
    cancel() {},
    reset() {},
    task: {
      id: taskId,
      schemaVersion: 'haze.task.v3',
      taskUrl: `/api/tasks/${taskId}`,
      status: 'completed',
      record: fixtureTask(),
    },
    operationPending: false,
    operationError: null,
    receipt: null,
    control: () => Promise.resolve(),
    update: () => Promise.resolve(),
    importSource: () => Promise.reject(new Error('No fixture upload.')),
    capabilities: [],
    capabilitiesError: null,
    latestAnswer: null,
  };
}

export function previewView(): ReductionPreviewView {
  const candidate = syntheticReductionCandidate();
  const selection = {
    schema_version: 'haze.reduction.input-selection.v1' as const,
    target: SYNTHETIC_REDUCTION_TARGET,
    scope_sha256: 'a'.repeat(64),
    method_id: 'reduction.imported-residual-comparison.v1' as const,
    method_version: '1' as const,
    sources: [
      { artifact: artifactRef, row_ids: ['baseline-1', 'intervention-1'] },
    ],
  };
  return {
    schema_version: 'haze.reduction.preview-view.v1',
    task_id: taskId,
    run_id: runId,
    objective_revision: 1,
    state: 'current',
    plan_eligibility: 'conditional',
    reasons: [],
    source_refs: [artifactRef],
    selection: { artifact: artifactRef, value: selection },
    assessment: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.assessment.v1',
        selection_ref: artifactRef,
        method_id: 'reduction.imported-residual-comparison.v1',
        method_version: '1',
        status: 'supported',
        reasons: [],
        origin: 'synthetic',
        baseline_damage: '1000',
        intervention_damage: '880',
        absolute_reduction: '120',
        relative_reduction: { numerator: '120', denominator: '1000' },
        target_met: true,
        scientific_qualification: 'unqualified',
        limitations: ['Synthetic point estimates only.'],
      },
    },
    arithmetic_review: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.review.v1',
        verdict: 'supported',
        reviewed_artifacts: [artifactRef],
        reviewer: { assignment_id: runId, revision: 1 },
        checks: [],
        findings: [],
        limitations: ['Arithmetic only.'],
        claim_eligibility: 'arithmetic_checked_scenario',
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    claims: {
      schema_version: 'haze.reduction.claim-eligibility.v1',
      selection_ref: artifactRef,
      assessment_ref: artifactRef,
      review_ref: artifactRef,
      claim_eligibility: 'arithmetic_checked_scenario',
      point_estimate_label: 'meets',
      origin: 'synthetic',
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
      reasons: [],
      checked_at: '2026-10-27T00:00:00Z',
    },
    plan: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.conditional-plan.v1',
        method_id: 'reduction.conditional-plan.v1',
        method_version: '1',
        target: SYNTHETIC_REDUCTION_TARGET,
        selection_ref: artifactRef,
        assessment_ref: artifactRef,
        arithmetic_review_ref: artifactRef,
        candidate,
        candidate_sha256: 'a'.repeat(64),
        source_refs: [artifactRef],
        state: 'conditional',
        assessment_status: 'supported',
        point_estimate_label: 'meets',
        origin: 'synthetic',
        scientific_qualification: 'unqualified',
        delivery_status: 'not_delivered',
        achieved_reduction: false,
        affected_scope: SYNTHETIC_REDUCTION_TARGET.scope,
        rules: {
          owner: null,
          trigger: null,
          action: null,
          approval: candidate.approval,
        },
        recommendations: [
          {
            id: 'recommendation-1',
            action: 'qualify_applicability',
            description:
              'Obtain the scoped scientific applicability review before any operational decision.',
            evidence: [artifactRef],
            prerequisite_ids: ['qualification'],
          },
        ],
        prerequisites: [
          {
            id: 'qualification',
            description:
              'Named non-synthetic reference case and applicability dossier',
            reason: 'scientific_applicability',
            evidence: [],
          },
        ],
        objections: [],
        limitations: ['This preview does not deliver actions.'],
      },
    },
    plan_review: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.plan-review.v1',
        verdict: 'supported',
        reviewed_artifacts: [artifactRef],
        reviewer: { assignment_id: runId, revision: 1 },
        checks: [],
        findings: [],
        limitations: ['Independent plan structure review only.'],
        planning_state: 'conditional',
        scientific_qualification: 'unqualified',
        delivery_status: 'not_delivered',
        achieved_reduction: false,
      },
    },
  };
}
