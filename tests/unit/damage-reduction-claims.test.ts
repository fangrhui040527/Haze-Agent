import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import type { Assignment, TaskRecord } from '../../app/contracts/tasks.js';
import type { ReductionClaimQuery } from '../../app/contracts/damage-reduction.js';
import type { StatefulToolStore } from '../../app/orchestration/ports.js';
import { independentlyCheckReduction } from '../../app/capabilities/damage-reduction-planning/checker.js';
import {
  createDamageReductionClaimTool,
  readDamageReductionClaim,
} from '../../app/capabilities/damage-reduction-planning/claims.js';
import {
  SYNTHETIC_REDUCTION_TARGET,
  syntheticResidualImport,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { createReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';

const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
function setup(baseline = '1000', intervention = '880') {
  const identity = { principal: 'claims-test', workspace: 'claims-test' };
  const taskId = randomUUID();
  const runId = randomUUID();
  const artifacts = new Map<string, Artifact>();
  const held = new Set<string>();
  const inaccessible = new Set<string>();
  const assignment = (definition: string, role: string) => ({
    id: randomUUID(),
    definition_id: definition,
    definition_version: '1',
    capability: 'damage-reduction-planning',
    capability_version: 'damage-reduction-planning.v1',
    role,
    revision: 1,
    run_id: runId,
    objective_revision: 1,
    status: 'completed',
    usability: 'usable',
    outputs: [] as ArtifactRef[],
  });
  const selector = assignment('reduction.select', 'HazeOps');
  const producer = assignment('reduction.assess', 'DamageAccountant');
  const reviewer = assignment('reduction.check', 'EvidenceCritic');
  const add = (
    kind: string,
    value: unknown,
    producing?: typeof producer,
    dependencies: ArtifactRef[] = [],
  ): Artifact => {
    const content: unknown =
      typeof value === 'string' ? value : JSON.parse(JSON.stringify(value));
    const artifact = artifactSchema.parse({
      schema_version: 'haze.artifact.v3',
      id: randomUUID(),
      version: 1,
      sha256: contractHash(content),
      identity,
      kind,
      producer: producing
        ? { kind: 'assignment', id: producing.id }
        : { kind: 'user', id: identity.principal },
      ...(producing
        ? {
            task_id: taskId,
            run_id: runId,
            assignment_id: producing.id,
            assignment_revision: 1,
            objective_revision: 1,
          }
        : {}),
      created_at: '2026-10-27T00:00:00.000Z',
      dependencies,
      content,
      evidence_origin: producing ? 'derived' : 'synthetic_fixture',
    });
    artifacts.set(artifact.id, artifact);
    producing?.outputs.push(ref(artifact));
    return artifact;
  };
  const source = add(
    'source.import',
    JSON.stringify(syntheticResidualImport(baseline, intervention)),
  );
  const selection = createReductionSelection(
    structuredClone(SYNTHETIC_REDUCTION_TARGET),
    [{ artifact: ref(source), row_ids: ['baseline-1', 'intervention-1'] }],
  );
  const selected = add('reduction.input-selection', selection, selector, [
    ref(source),
  ]);
  const output = assessReduction(selection, [source], ref(selected));
  const assessment = add('reduction.assessment', output, producer, [
    ref(selected),
    ref(source),
  ]);
  const independent = independentlyCheckReduction(
    selection,
    [source],
    ref(selected),
    output,
    ref(assessment),
    { assignment_id: reviewer.id, revision: 1 },
    producer.id,
  );
  const review = add('reduction.review', independent, reviewer, [
    ref(selected),
    ref(assessment),
    ref(source),
  ]);
  const task = {
    id: taskId,
    identity,
    current_run_id: runId,
    objective_revision: 1,
    mode: 'fixture',
    original_request: { scope: selection },
    corrections: [],
    permissions: {
      tools: [
        'reduction.pin-selection',
        'reduction.imported-residual-comparison.v1',
        'reduction.independent-check.v1',
        'reduction.read-claim',
      ],
    },
    assignments: [selector, producer, reviewer] as unknown as Assignment[],
    artifacts: [...artifacts.values()].map((artifact) => ({
      artifact: ref(artifact),
      current: true,
      objective_revision: 1,
    })),
  } as unknown as TaskRecord;
  const store = {
    read: (id: string) => {
      if (id !== taskId) throw new Error('not found');
      return task;
    },
    artifact: (id: string, _identity: unknown, exact: ArtifactRef) => {
      if (inaccessible.has(id))
        throw new Error('Sensitive internal access error');
      const artifact = artifacts.get(id);
      if (
        !artifact ||
        artifact.version !== exact.version ||
        artifact.sha256 !== exact.sha256
      )
        throw new Error('not found');
      return artifact;
    },
    world: {
      lookup: (_scope: unknown, query: { external_id: string }) => [
        { ref: { id: query.external_id } },
      ],
      activeHolds: (_scope: unknown, id: string) => (held.has(id) ? [{}] : []),
    },
  } as unknown as StatefulToolStore;
  const query: ReductionClaimQuery = {
    selection_ref: ref(selected),
    assessment_ref: ref(assessment),
    review_ref: ref(review),
  };
  const context = { taskId, runId, identity };
  const claim = () =>
    readDamageReductionClaim(store, 'fixture', query, context);
  return {
    source,
    selected,
    assessment,
    review,
    producer,
    reviewer,
    artifacts,
    held,
    inaccessible,
    task,
    store,
    query,
    claim,
  };
}

describe('current damage reduction claims', () => {
  it('exposes a read-only tool and a current synthetic arithmetic-checked prediction', () => {
    const test = setup();
    expect(
      createDamageReductionClaimTool(test.store, 'fixture').manager_read_only,
    ).toBe(true);
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'arithmetic_checked_scenario',
      point_estimate_label: 'meets',
      origin: 'synthetic',
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
      reasons: [],
    });
  });

  it('retains a failed target and honest invalid-baseline gap without achieved claims', () => {
    expect(setup('1000', '1100').claim()).toMatchObject({
      claim_eligibility: 'arithmetic_checked_scenario',
      point_estimate_label: 'does_not_meet',
      achieved_reduction: false,
    });
    expect(setup('0', '1').claim()).toMatchObject({
      claim_eligibility: 'imported_estimate',
      point_estimate_label: 'unavailable',
      reasons: ['positive_baseline_required'],
    });
  });

  it.each(['source', 'selected', 'assessment', 'review'] as const)(
    'withdraws current eligibility after %s applicability changes',
    (name) => {
      const test = setup();
      test.task.artifacts.find(
        (entry) => entry.artifact.id === test[name].id,
      )!.current = false;
      expect(test.claim()).toMatchObject({
        claim_eligibility: 'none',
        point_estimate_label: 'unavailable',
        origin: 'unknown',
        reasons: ['claim_dependency_not_current'],
      });
    },
  );

  it('rechecks access without disclosing inaccessible payloads or internal errors', () => {
    const test = setup();
    test.inaccessible.add(test.source.id);
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_inputs_inaccessible_or_invalid'],
    });
    expect(JSON.stringify(test.claim())).not.toContain('Sensitive');
  });

  it('rechecks revoked grants in the current task', () => {
    const test = setup();
    test.source.required_tools = ['reduction.independent-check.v1'];
    test.task.permissions.tools = test.task.permissions.tools.filter(
      (tool) => tool !== 'reduction.independent-check.v1',
    );
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_dependency_permission_revoked'],
    });
  });

  it('withholds labels for a held or withdrawn original source', () => {
    const test = setup();
    test.held.add(`artifact:${test.source.id}:${test.source.version}`);
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_dependency_held_or_withdrawn'],
    });
  });

  it('rejects an imported review even when it copies every supported claim flag', () => {
    const test = setup();
    test.review.producer = { kind: 'user', id: 'claims-test' };
    delete test.review.assignment_id;
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_registered_producer_not_current'],
    });
  });

  it('independently reconstructs a saved review and rejects fabricated checks', () => {
    const test = setup();
    const value = test.review.content as Record<string, unknown>;
    value.checks = [];
    test.review.sha256 = contractHash(value);
    test.query.review_ref.sha256 = test.review.sha256;
    test.task.artifacts.find(
      (entry) => entry.artifact.id === test.review.id,
    )!.artifact.sha256 = test.review.sha256;
    test.reviewer.outputs[0]!.sha256 = test.review.sha256;
    expect(test.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_independent_review_not_supported'],
    });
  });

  it.each(['stale', 'rejected'] as const)(
    'requires the current assessment producer to remain %s-free',
    (usability) => {
      const test = setup();
      test.producer.usability = usability;
      expect(test.claim().claim_eligibility).toBe('none');
    },
  );

  it('requires the current task objective and operator selection', () => {
    const test = setup();
    test.task.objective_revision = 2;
    expect(test.claim().claim_eligibility).toBe('none');
    const changed = setup();
    changed.task.original_request.scope = {};
    expect(changed.claim()).toMatchObject({
      claim_eligibility: 'none',
      reasons: ['claim_current_operator_selection_changed'],
    });
  });
});
