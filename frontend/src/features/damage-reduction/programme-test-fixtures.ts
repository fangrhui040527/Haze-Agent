import {
  DEFAULT_REDUCTION_PROGRAMME_BUDGET,
  type ReductionProgrammeAttempt,
  type ReductionProgrammeView,
} from '../../../../app/contracts/damage-reduction-programme.ts';
import { previewView } from './preview-test-fixtures.ts';
import {
  artifactRef,
  runId,
  taskId,
} from '../../services/agents/testFixtures.ts';

export const programmeId = '77777777-7777-4777-8777-777777777777';
export const attemptId = '88888888-8888-4888-8888-888888888888';
export function programmeView(): ReductionProgrammeView {
  const preview = previewView();
  return {
    schema_version: 'haze.reduction.programme.view.v1',
    programme: {
      schema_version: 'haze.reduction.programme.v1',
      id: programmeId,
      revision: 1,
      mode: 'fixture',
      title: 'Synthetic alert programme',
      accountable_owner: 'Local operator',
      scientific_owner: null,
      preview: {
        schema_version: 'haze.reduction.preview-request.v1',
        selection: preview.selection!.value,
        candidate: preview.plan!.value.candidate,
      },
      budget: { ...DEFAULT_REDUCTION_PROGRAMME_BUDGET },
      created_at: '2026-10-27T00:00:00Z',
      updated_at: '2026-10-27T00:00:00Z',
    },
    capacity: {
      remaining_model_calls: 400,
      remaining_tool_calls: 400,
      charged_model_calls: 0,
      charged_tool_calls: 0,
      reserved_model_calls: 0,
      reserved_tool_calls: 0,
      remaining_runs: 12,
      remaining_attempts: { assessment: 3, planning: 3 },
      active_attempt_id: null,
    },
    attempts: [],
    records: [],
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
}
export function programmeAttempt(
  phase: 'assessment' | 'planning' = 'assessment',
): ReductionProgrammeAttempt {
  return {
    schema_version: 'haze.reduction.programme.attempt.v1',
    id: attemptId,
    programme_id: programmeId,
    programme_revision: 2,
    phase,
    task_id: taskId,
    run_id: runId,
    objective_revision: 1,
    input_fingerprint: 'b'.repeat(64),
    selected_refs: [artifactRef],
    predecessor_attempt_id: null,
    assessment_attempt_id: phase === 'planning' ? attemptId : null,
    reservation: { model_calls: 40, tool_calls: 40 },
    created_at: '2026-10-27T00:01:00Z',
  };
}
