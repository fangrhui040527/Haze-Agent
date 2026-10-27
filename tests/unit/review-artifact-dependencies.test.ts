import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import {
  assignmentSchema,
  taskRecordSchema,
  type Assignment,
} from '../../app/contracts/tasks.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  assessArtifactReviews,
  validateArtifactClosure,
} from '../../app/orchestration/runtime.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import { draftConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning.js';
import { independentlyCheckConditionalPlan } from '../../app/capabilities/damage-reduction-planning/planning-checker.js';

const now = '2026-10-27T00:00:00Z';
const identity = { principal: 'test-operator', workspace: 'test-workspace' };

/** Genuine registered method/review outputs with exact task assignment lineage. */
function lineage() {
  const registry = createExecutionRegistry({ mode: 'fixture' });
  const taskId = randomUUID();
  const runId = randomUUID();
  const assignments: Assignment[] = [];
  const artifactList: Artifact[] = [];
  const assignment = (definitionId: string, inputs: ArtifactRef[] = []) => {
    const definition = registry.definitions.get(definitionId)!;
    const value = assignmentSchema.parse({
      id: randomUUID(),
      task_id: taskId,
      run_id: runId,
      role: definition.agent,
      definition_id: definition.id,
      definition_version: definition.version,
      agent_version: registry.agents.get(definition.agent)!.version,
      capability_version: registry.capabilities.get(definition.capability)!.card
        .version,
      capability: definition.capability,
      revision: 1,
      objective_revision: 1,
      generation: 1,
      acknowledged_revision: 1,
      brief: 'Reproduce a bounded conditional planning preview.',
      dependencies: [],
      inputs,
      tools: definition.tools,
      status: 'completed',
      deadline: '2026-10-27T00:05:00Z',
      max_model_calls: 8,
      usage: { model_calls: 0, tool_calls: 0 },
      outputs: [],
      assumptions: [],
      gaps: [],
      support: 'supported',
      usability: 'usable',
    });
    assignments.push(value);
    return value;
  };
  const save = (
    kind: string,
    content: unknown,
    producer?: Assignment,
    dependencies: ArtifactRef[] = [],
  ) => {
    const value = artifactSchema.parse({
      schema_version: 'haze.artifact.v3',
      id: randomUUID(),
      version: 1,
      sha256: contractHash(content),
      identity,
      task_id: taskId,
      run_id: runId,
      objective_revision: 1,
      generation: 1,
      ...(producer
        ? { assignment_id: producer.id, assignment_revision: producer.revision }
        : {}),
      kind,
      producer: producer
        ? { kind: 'assignment', id: producer.id }
        : { kind: 'user', id: identity.principal },
      created_at: now,
      dependencies,
      content,
      required_tools: [],
      evidence_origin: 'synthetic_fixture',
    });
    artifactList.push(value);
    producer?.outputs.push(exactReductionRef(value));
    return value;
  };
  const original = save('artifact.import', syntheticResidualImport());
  const selectionData = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
    {
      artifact: exactReductionRef(original),
      row_ids: ['baseline-1', 'intervention-1'],
    },
  ]);
  const selection = save(
    'reduction.input-selection',
    selectionData,
    assignment('reduction.select', [exactReductionRef(original)]),
    [exactReductionRef(original)],
  );
  const assessmentData = assessReduction(
    selectionData,
    [original],
    exactReductionRef(selection),
  );
  const assessmentProducer = assignment('reduction.assess', [
    exactReductionRef(original),
    exactReductionRef(selection),
  ]);
  const assessment = save(
    'reduction.assessment',
    assessmentData,
    assessmentProducer,
    [exactReductionRef(original), exactReductionRef(selection)],
  );
  const arithmeticReviewer = assignment('reduction.check', [
    exactReductionRef(original),
    exactReductionRef(selection),
    exactReductionRef(assessment),
  ]);
  const arithmeticData = independentlyCheckReduction(
    selectionData,
    [original],
    exactReductionRef(selection),
    assessmentData,
    exactReductionRef(assessment),
    { assignment_id: arithmeticReviewer.id, revision: 1 },
    assessmentProducer.id,
  );
  const arithmeticReview = save(
    'reduction.review',
    arithmeticData,
    arithmeticReviewer,
    [
      exactReductionRef(original),
      exactReductionRef(selection),
      exactReductionRef(assessment),
    ],
  );
  const request = {
    schema_version: 'haze.reduction.preview-request.v1' as const,
    selection: selectionData,
    candidate: syntheticReductionCandidate(),
  };
  const planningInput = {
    request,
    selection,
    assessment,
    arithmeticReview,
    sources: [original],
  };
  const planProducer = assignment(
    'reduction.plan',
    [original, selection, assessment, arithmeticReview].map(exactReductionRef),
  );
  const plan = save(
    'reduction.conditional-plan',
    draftConditionalPlan(planningInput),
    planProducer,
    [original, selection, assessment, arithmeticReview].map(exactReductionRef),
  );
  const planReviewer = assignment(
    'reduction.plan-check',
    [original, selection, assessment, arithmeticReview, plan].map(
      exactReductionRef,
    ),
  );
  const planReview = save(
    'reduction.plan-review',
    independentlyCheckConditionalPlan({
      ...planningInput,
      plan,
      reviewer: { assignment_id: planReviewer.id, revision: 1 },
    }),
    planReviewer,
    [original, selection, assessment, arithmeticReview, plan].map(
      exactReductionRef,
    ),
  );
  const usage = {
    model_calls: 0,
    tool_calls: 0,
    artifacts: artifactList.length,
    assignments: assignments.length,
  };
  const limits = {
    deadline: '2026-10-27T00:05:00Z',
    max_model_calls: 40,
    max_tool_calls: 40,
    max_artifacts: 64,
    max_assignments: 16,
    max_model_input_bytes: 24576,
    max_model_output_tokens: 1200,
    reserved_model_calls: 2,
  };
  const task = taskRecordSchema.parse({
    schema_version: 'haze.task.v3',
    id: taskId,
    original_request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Prepare a conditional damage reduction planning preview.',
      scope: request,
      context_refs: [exactReductionRef(original)],
    },
    objective_revision: 1,
    current_run_id: runId,
    generation: 1,
    state_revision: 1,
    identity,
    permissions: { tools: [...registry.tools.keys()], effects: [] },
    mode: 'fixture',
    status: 'completed',
    created_at: now,
    updated_at: now,
    limits,
    usage,
    runs: [
      {
        id: runId,
        task_id: taskId,
        objective_revision: 1,
        generation: 1,
        state_revision: 1,
        status: 'completed',
        limits,
        usage,
        created_at: now,
        updated_at: now,
      },
    ],
    assignments,
    corrections: [],
    questions: [],
    artifacts: artifactList.map((item) => ({
      artifact: exactReductionRef(item),
      task_id: taskId,
      objective_revision: 1,
      current: true,
      reason: 'Fixture exact current assignment lineage.',
      checked_by: 'Runtime',
      checked_at: now,
    })),
  });
  const read = (reference: ArtifactRef) =>
    artifactList.find((item) => item.id === reference.id)!;
  const validate = (selected: ArtifactRef[] = [exactReductionRef(plan)]) =>
    validateArtifactClosure(task, registry, artifactList, selected, read);
  return {
    registry,
    task,
    artifacts: artifactList,
    original,
    selection,
    assessment,
    assessmentData,
    selectionData,
    arithmeticReviewer,
    arithmeticReview,
    plan,
    planReview,
    save,
    validate,
  };
}

describe('registered independent reviews inside final artifact dependency closure', () => {
  it('retains external-candidate provenance separately from source closure and requires the exact registered review', () => {
    const value = lineage();
    const candidate = { id: randomUUID(), version: 1, sha256: 'c'.repeat(64) };
    value.plan.external_candidates = [candidate];
    expect(
      assessArtifactReviews(value.task, value.registry, value.artifacts),
    ).toContainEqual(
      expect.objectContaining({
        artifact: exactReductionRef(value.plan),
        verdict: 'supported',
      }),
    );
    const closure = value.validate();
    expect(
      closure.find((artifact) => artifact.id === value.plan.id)
        ?.external_candidates,
    ).toEqual([candidate]);
    expect(closure.some((artifact) => artifact.id === candidate.id)).toBe(
      false,
    );
    expect(value.plan.dependencies).not.toContainEqual(candidate);
    value.task.assignments.find(
      (item) => item.id === value.planReview.assignment_id,
    )!.status = 'waiting';
    expect(() => value.validate()).toThrow(
      expect.objectContaining({ code: 'independent_review_required' }),
    );
  });
  it('fails closed for a candidate-derived artifact kind with no registered independent review contract', () => {
    const value = lineage();
    value.plan.kind = 'unregistered.candidate-derived-note';
    value.plan.external_candidates = [
      { id: randomUUID(), version: 1, sha256: 'd'.repeat(64) },
    ];
    expect(
      assessArtifactReviews(value.task, value.registry, value.artifacts),
    ).toContainEqual(
      expect.objectContaining({
        artifact: exactReductionRef(value.plan),
        verdict: 'needs_review',
      }),
    );
    expect(() => value.validate()).toThrow(
      expect.objectContaining({ code: 'independent_review_required' }),
    );
  });
  it('bounds optional candidate provenance without adding legacy defaults or accepting malformed references', () => {
    const value = lineage();
    expect(
      artifactSchema.parse(value.plan).external_candidates,
    ).toBeUndefined();
    const candidate = { id: randomUUID(), version: 1, sha256: 'e'.repeat(64) };
    expect(
      artifactSchema.safeParse({
        ...value.plan,
        external_candidates: [candidate],
      }).success,
    ).toBe(true);
    expect(
      artifactSchema.safeParse({
        ...value.plan,
        external_candidates: Array.from({ length: 5 }, () => candidate),
      }).success,
    ).toBe(false);
    expect(
      artifactSchema.safeParse({
        ...value.plan,
        external_candidates: [{ ...candidate, sha256: 'not-an-exact-hash' }],
      }).success,
    ).toBe(false);
  });
  it('allows the exact supported registered arithmetic review as a plan dependency', () => {
    const value = lineage();
    expect(
      assessArtifactReviews(value.task, value.registry, value.artifacts),
    ).toContainEqual(
      expect.objectContaining({
        artifact: exactReductionRef(value.assessment),
        verdict: 'supported',
        reviewer_assignment_id: value.arithmeticReviewer.id,
        review_artifact: exactReductionRef(value.arithmeticReview),
      }),
    );
    expect(value.validate().map((item) => item.id)).toEqual(
      expect.arrayContaining([
        value.original.id,
        value.selection.id,
        value.assessment.id,
        value.arithmeticReview.id,
        value.plan.id,
      ]),
    );
  });
  it.each(['review-only', 'plan-and-review'] as const)(
    'denies direct review work-product selection: %s',
    (selection) => {
      const value = lineage();
      const selected =
        selection === 'review-only'
          ? [exactReductionRef(value.arithmeticReview)]
          : [
              exactReductionRef(value.plan),
              exactReductionRef(value.arithmeticReview),
            ];
      expect(() => value.validate(selected)).toThrow(
        expect.objectContaining({ code: 'unsupported_final_reference' }),
      );
    },
  );
  it('denies an arbitrary artifact from the same critic assignment', () => {
    const value = lineage();
    const note = value.save(
      'assignment.summary',
      { text: 'A critic summary is not a registered supported review.' },
      value.arithmeticReviewer,
    );
    value.task.artifacts.push({
      artifact: exactReductionRef(note),
      task_id: value.task.id,
      objective_revision: 1,
      current: true,
      reason: 'Current arbitrary critic note.',
      checked_by: 'Runtime',
      checked_at: now,
    });
    value.plan.dependencies.push(exactReductionRef(note));
    expect(() => value.validate()).toThrow(
      expect.objectContaining({ code: 'unsupported_final_reference' }),
    );
  });
  it.each(['applicability', 'assignment', 'input-version'] as const)(
    'denies a stale arithmetic review through %s',
    (staleness) => {
      const value = lineage();
      if (staleness === 'applicability')
        value.task.artifacts.find(
          (item) => item.artifact.id === value.arithmeticReview.id,
        )!.current = false;
      if (staleness === 'assignment')
        value.task.assignments.find(
          (item) => item.id === value.arithmeticReviewer.id,
        )!.status = 'stale';
      if (staleness === 'input-version')
        value.task.assignments.find(
          (item) => item.id === value.arithmeticReviewer.id,
        )!.inputs = value.arithmeticReviewer.inputs.map((item) =>
          item.id === value.assessment.id
            ? { ...item, version: item.version + 1 }
            : item,
        );
      expect(() => value.validate()).toThrow();
      expect(
        assessArtifactReviews(value.task, value.registry, value.artifacts),
      ).toContainEqual(
        expect.objectContaining({
          artifact: exactReductionRef(value.assessment),
          verdict: 'needs_review',
        }),
      );
    },
  );
  it('denies a genuine independent rejection as an arithmetic review dependency', () => {
    const value = lineage();
    const rejected = independentlyCheckReduction(
      value.selectionData,
      [value.original],
      exactReductionRef(value.selection),
      { ...value.assessmentData, target_met: false },
      exactReductionRef(value.assessment),
      { assignment_id: value.arithmeticReviewer.id, revision: 1 },
      value.assessment.assignment_id,
    );
    expect(rejected.verdict).toBe('rejected');
    value.arithmeticReview.content = rejected;
    value.arithmeticReview.sha256 = contractHash(rejected);
    value.task.artifacts.find(
      (item) => item.artifact.id === value.arithmeticReview.id,
    )!.artifact = exactReductionRef(value.arithmeticReview);
    expect(
      assessArtifactReviews(value.task, value.registry, value.artifacts),
    ).toContainEqual(
      expect.objectContaining({
        artifact: exactReductionRef(value.assessment),
        verdict: 'rejected',
      }),
    );
    expect(() => value.validate()).toThrow(
      expect.objectContaining({ code: 'independent_review_required' }),
    );
  });
});
