import type {
  PilotInput,
  PilotTaskView,
  PilotDeliveryProjection,
} from '../../../../app/contracts/damage-reduction-pilot.ts';
import {
  artifactRef,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';
import { programmeId } from './programme-test-fixtures.ts';

export function pilotInput(): PilotInput {
  return {
    schema_version: 'haze.reduction.pilot-input.v1',
    origin: 'synthetic',
    scientific_owner: null,
    intended_kind: 'feasibility',
    findings: [
      {
        topic: 'precision_power',
        status: 'unavailable',
        statement:
          'Design-specific precision calculations have not been supplied.',
        evidence: [],
      },
    ],
    calculations: [],
    assumptions: ['Engineering fixture only.'],
    design_review: null,
    protocol_spec: {
      id: 'fixture-protocol',
      version: '1',
      design_name: null,
      primary_endpoint: null,
      unit: null,
      population: null,
      comparator: null,
      baseline_window: null,
      observation_window: null,
      analysis_method: null,
      target_rule: null,
      missingness_rule: null,
      deviation_rule: null,
      stopping_criteria: [],
      delivery_checks: [],
      digital_rule: {
        id: 'fixture-alert',
        version: '2',
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
        permitted_actions: ['Synthetic alert only'],
        scope: {
          geography: 'Synthetic district',
          population: 'Synthetic workers',
          period: { start: '2026-01-01', end: '2026-12-31' },
          recipient_groups: ['fixture-group'],
          schedule_ids: [],
        },
        safeguards: ['No live adapter'],
        pause_disable_rule: null,
      },
    },
  };
}
export function pilotTaskView(): PilotTaskView {
  const input = pilotInput();
  const binding = {
    programme_id: programmeId,
    input_ref: artifactRef,
    selection_ref: artifactRef,
    assessment_ref: artifactRef,
    plan_ref: artifactRef,
    plan_review_ref: artifactRef,
    target_sha256: 'a'.repeat(64),
    scope_sha256: 'b'.repeat(64),
  };
  return {
    schema_version: 'haze.reduction.pilot-task-view.v1',
    task_id: taskId,
    run_id: runId,
    objective_revision: 1,
    state: 'current',
    feasibility: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.pilot-feasibility.v1',
        ...binding,
        origin: 'synthetic',
        classification: 'delivery_exposure_feasibility_only',
        classification_basis: 'engineering_completeness_only',
        intended_kind: 'feasibility',
        findings: input.findings,
        calculations: [],
        assumptions: input.assumptions,
        scientific_review: null,
        prerequisites: ['Supply design-specific power and scientific review.'],
        limitations: [
          'Engineering completeness cannot establish scientific feasibility.',
        ],
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    protocol: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.pilot-protocol.v1',
        ...binding,
        origin: 'synthetic',
        status: 'draft',
        specification: input.protocol_spec,
        prerequisites: ['Human approval is missing.'],
        limitations: ['Fixture only.'],
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    review: {
      artifact: artifactRef,
      value: {
        schema_version: 'haze.reduction.pilot-review.v1',
        programme_id: programmeId,
        input_ref: artifactRef,
        reviewed_artifacts: [artifactRef, { ...artifactRef, version: 2 }],
        reviewer: { assignment_id: runId, revision: 1 },
        verdict: 'supported',
        checks: [],
        findings: [
          'Limited classification is consistent with missing scientific inputs.',
        ],
        limitations: ['Not scientific qualification.'],
        scientific_qualification: 'unqualified',
        achieved_reduction: false,
      },
    },
    reasons: [],
    live_delivery: 'deferred',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
}
export function pilotProjection(): PilotDeliveryProjection {
  return {
    feasibility: null,
    registrations: [],
    amendments: [],
    actions: [],
    deviations: [],
    verifications: [],
    reasons: [],
    live_delivery: 'deferred',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
}
