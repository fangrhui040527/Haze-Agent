import type {
  TaskEvent,
  TaskRecord,
  TaskResult,
} from '../../../../app/contracts/tasks.ts';
export const taskId = '11111111-1111-4111-8111-111111111111';
export const runId = '22222222-2222-4222-8222-222222222222';
export const artifactId = '33333333-3333-4333-8333-333333333333';
export const at = '2026-10-25T00:00:00Z';
export const artifactRef = {
  id: artifactId,
  version: 1,
  sha256: 'a'.repeat(64),
};
export const taskPath = `/api/tasks/${taskId}`;
export const admitted = {
  task_id: taskId,
  status_url: taskPath,
  events_url: `${taskPath}/events`,
  reused: false,
};
export const request = {
  question: 'Explain the supplied evidence.',
  focusItemId: null,
  idempotencyKey: 'fixture-admission',
};
export function fixtureResult(): TaskResult {
  return {
    schema_version: 'haze.task.result.v3',
    answer: 'The source supports a limited explanation. [E1]',
    completion: 'partial',
    work_products: [artifactRef],
    sources: [
      {
        id: 'E1',
        artifact: artifactRef,
        label: 'Exact source',
        url: `/api/artifacts/${artifactId}`,
      },
    ],
    covered_scope: { topic: 'evidence' },
    uncertainty: ['Observations are unavailable.'],
    review: {
      status: 'needs_review',
      scope: 'Exact source validation.',
      limitations: ['Fixture verification only.'],
    },
    currency: 'current',
    next_requirements: ['Provide direct observations.'],
    provenance: {
      mode: 'fixture',
      model_calls: 1,
      tool_calls: 1,
      capabilities: [{ id: 'evidence-synthesis', version: '1' }],
      receipts: [],
    },
  };
}
export function fixtureTask(): TaskRecord {
  const limits = {
    deadline: '2099-01-01T00:00:00Z',
    max_model_calls: 6,
    max_tool_calls: 6,
    max_assignments: 6,
    max_artifacts: 16,
    max_model_input_bytes: 16384,
    max_model_output_tokens: 1200,
    reserved_model_calls: 2,
  };
  const usage = { model_calls: 1, tool_calls: 1, artifacts: 1, assignments: 0 };
  return {
    schema_version: 'haze.task.v3',
    id: taskId,
    current_run_id: runId,
    objective_revision: 1,
    generation: 1,
    state_revision: 2,
    original_request: {
      schema_version: 'haze.task.request.v3',
      objective: request.question,
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    },
    identity: { principal: 'fixture', workspace: 'fixture' },
    permissions: { tools: [], effects: [] },
    mode: 'fixture',
    status: 'completed',
    created_at: at,
    updated_at: at,
    limits,
    usage,
    runs: [
      {
        id: runId,
        task_id: taskId,
        objective_revision: 1,
        generation: 1,
        state_revision: 2,
        status: 'completed',
        limits,
        usage,
        created_at: at,
        updated_at: at,
      },
    ],
    assignments: [],
    questions: [],
    corrections: [],
    artifacts: [],
    result: fixtureResult(),
  };
}
export function receipt(
  cursor: number,
  type: string,
  actor: TaskEvent['actor'] = 'Runtime',
): TaskEvent {
  return {
    schema_version: 'haze.task.event.v3',
    cursor,
    task_id: taskId,
    run_id: runId,
    objective_revision: 1,
    generation: 1,
    at,
    type,
    actor,
    message: `Actual ${type}`,
  };
}
export const expectation = {
  expected_objective_revision: 1,
  expected_run_id: runId,
  expected_generation: 1,
  expected_state_revision: 2,
};
export const controlReceipt = {
  schema_version: 'haze.task.control.receipt.v3',
  operation_id: artifactId,
  task_id: taskId,
  run_id: runId,
  requested: 'pause',
  confirmed: 'paused',
  objective_revision: 1,
  generation: 2,
  state_revision: 3,
  at,
  remote_termination_confirmed: false,
};
