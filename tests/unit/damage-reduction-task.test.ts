import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import type { Artifact } from '../../app/contracts/artifacts.js';
import {
  reductionAssessmentSchema,
  reductionInputSelectionSchema,
  reductionReviewSchema,
} from '../../app/contracts/damage-reduction.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import {
  SYNTHETIC_REDUCTION_TARGET,
  syntheticResidualImport,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
  resolveReductionSelectionRequest,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { readDamageReductionClaim } from '../../app/capabilities/damage-reduction-planning/claims.js';
import { createReductionCapacityFixture } from '../../app/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import type { ExecutionRegistry } from '../../app/orchestration/ports.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  limits = {},
  configure?: (registry: ExecutionRegistry) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-reduction-runtime-'));
  const registry = createExecutionRegistry({ mode: 'fixture' });
  configure?.(registry);
  let runtime = new TaskRuntime({
    stateDirectory: directory,
    mode: 'fixture',
    registry,
    limits,
  });
  cleanups.push(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get runtime() {
      return runtime;
    },
    async restart() {
      await runtime.close();
      runtime = new TaskRuntime({
        stateDirectory: directory,
        mode: 'fixture',
        registry: createExecutionRegistry({ mode: 'fixture' }),
      });
      return runtime;
    },
  };
}

async function settle(runtime: TaskRuntime, id: string, timeout = 20_000) {
  await expect
    .poll(() => runtime.store.read(id, localTaskIdentity).status, {
      timeout,
    })
    .not.toMatch(/^(queued|running)$/);
  return runtime.store.read(id, localTaskIdentity);
}

function importJson(
  runtime: TaskRuntime,
  content: unknown,
  key = 'residual-import',
) {
  const artifact = runtime.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: `${key}.json`,
      media_type: 'application/json',
      declared_origin:
        'Explicit synthetic engineering fixture; no empirical applicability evidence.',
      content_base64: Buffer.from(JSON.stringify(content)).toString('base64'),
    },
    key,
  );
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}

function artifacts(runtime: TaskRuntime, task: TaskRecord): Artifact[] {
  return task.artifacts.map(({ artifact }) =>
    runtime.store.artifact(artifact.id, localTaskIdentity, artifact),
  );
}

function requestFor(
  runtime: TaskRuntime,
  baseline = '1000',
  intervention = '880',
) {
  const source = importJson(
    runtime,
    syntheticResidualImport(baseline, intervention),
  );
  const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
    { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
  ]);
  return {
    schema_version: 'haze.task.request.v3',
    objective:
      'Assess damage reduction from the explicitly selected supplied residual estimates with independent arithmetic review.',
    scope: selection,
    context_refs: [source],
  };
}

describe('damage reduction admitted task path', () => {
  it.each(['inline', 'alternative-reference'])(
    'keeps operator declaration lineage when a Manager plans %s input',
    async (mode) => {
      const planned = { input: undefined as unknown };
      const { runtime } = await setup({}, (registry) => {
        const capability = registry.capabilities.get(
          'damage-reduction-planning',
        )!;
        const assignments = capability.assignments.bind(capability);
        capability.assignments = (request) =>
          assignments(request).map((assignment) =>
            assignment.definition_id === 'reduction.select'
              ? { ...assignment, input: planned.input }
              : assignment,
          );
      });
      const request = requestFor(runtime);
      const declared = importJson(runtime, request.scope, 'operator-selection');
      const alternative = importJson(
        runtime,
        request.scope,
        'alternative-selection',
      );
      planned.input =
        mode === 'inline'
          ? request.scope
          : {
              schema_version: 'haze.reduction.selection-request.v1',
              selection_ref: alternative,
            };
      const admitted = runtime.admit(
        {
          ...request,
          scope: {
            schema_version: 'haze.reduction.selection-request.v1',
            selection_ref: declared,
          },
          context_refs: [...request.context_refs, declared, alternative],
        },
        `declaration-lineage-${mode}`,
      );
      const task = await settle(runtime, admitted.task_id);
      const saved = artifacts(runtime, task);
      const selected = saved.find(
        ({ kind }) => kind === 'reduction.input-selection',
      )!;
      expect(selected.dependencies).toContainEqual(declared);
      expect(selected.dependencies).not.toContainEqual(alternative);
      const query = {
        selection_ref: exactReductionRef(selected),
        assessment_ref: exactReductionRef(
          saved.find(({ kind }) => kind === 'reduction.assessment')!,
        ),
        review_ref: exactReductionRef(
          saved.find(({ kind }) => kind === 'reduction.review')!,
        ),
      };
      const claim = () =>
        readDamageReductionClaim(runtime.store, 'fixture', query, {
          taskId: task.id,
          identity: localTaskIdentity,
          runId: task.current_run_id,
        });
      const scope = { ...localTaskIdentity, mode: 'fixture' as const };
      const hold = (ref: typeof declared) => {
        const record = runtime.store.world.lookup(scope, {
          kind: 'artifact_reference',
          external_id: `artifact:${ref.id}:${ref.version}`,
          limit: 2,
        })[0]!;
        runtime.store.world.hold(
          scope,
          record.ref,
          'Synthetic lineage test hold.',
          'unknown_impact',
        );
      };
      hold(alternative);
      expect(claim().claim_eligibility).toBe('arithmetic_checked_scenario');
      hold(declared);
      expect(claim().claim_eligibility).toBe('none');
    },
  );

  it('rejects a specialist substitute for a selection pinned by reference', async () => {
    const { runtime } = await setup({}, (registry) => {
      registry.definitions.get('reduction.select')!.execute = async (
        services,
      ) => {
        const substitute = resolveReductionSelectionRequest(
          services.input,
          services.context.inputs,
        );
        substitute.target.target_fraction = '0.05';
        await services.tool('reduction.pin-selection', substitute);
        throw new Error(
          'Operator selection substitution should have been rejected.',
        );
      };
    });
    const request = requestFor(runtime);
    const declared = importJson(runtime, request.scope, 'declared-selection');
    const admitted = runtime.admit(
      {
        ...request,
        scope: {
          schema_version: 'haze.reduction.selection-request.v1',
          selection_ref: declared,
        },
        context_refs: [...request.context_refs, declared],
      },
      'selection-ref-substitution',
    );
    const task = await settle(runtime, admitted.task_id);
    expect(
      task.assignments.find(
        ({ definition_id }) => definition_id === 'reduction.select',
      )?.error?.message,
    ).toContain(
      'Selection conflicts with the current operator-declared target',
    );
    expect(
      artifacts(runtime, task).some(
        ({ kind }) => kind === 'reduction.assessment',
      ),
    ).toBe(false);
  });

  it('retains the exact byte-limit bundle and rechecks maximum-bundle claims after restart/hold', async () => {
    const session = await setup();
    const fixture = createReductionCapacityFixture(500, 16, 524_288);
    const sources = fixture.artifacts.map((artifact, index) =>
      importJson(session.runtime, artifact.content, `capacity-${index}`),
    );
    const selection = createReductionSelection(
      fixture.target,
      fixture.selection.sources.map((source, index) => ({
        ...source,
        artifact: sources[index]!,
      })),
    );
    const declared = importJson(
      session.runtime,
      selection,
      'capacity-selection',
    );
    const admission = session.runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Assess damage reduction from the explicitly selected supplied residual estimates.',
        scope: {
          schema_version: 'haze.reduction.selection-request.v1',
          selection_ref: declared,
        },
        context_refs: [...sources, declared],
      },
      'maximum-byte-bundle',
    );
    const task = await settle(session.runtime, admission.task_id, 30_000);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    const saved = artifacts(session.runtime, task);
    const byKind = (kind: string) =>
      exactReductionRef(saved.find((artifact) => artifact.kind === kind)!);
    const query = {
      selection_ref: byKind('reduction.input-selection'),
      assessment_ref: byKind('reduction.assessment'),
      review_ref: byKind('reduction.review'),
    };
    const restarted = await session.restart();
    expect(restarted.store.read(task.id, localTaskIdentity)).toEqual(task);
    const claim = () =>
      readDamageReductionClaim(restarted.store, 'fixture', query, {
        taskId: task.id,
        identity: localTaskIdentity,
        runId: task.current_run_id,
      });
    expect(claim().claim_eligibility).toBe('arithmetic_checked_scenario');
    const records = restarted.store.world.lookup(
      { ...localTaskIdentity, mode: 'fixture' },
      {
        kind: 'artifact_reference',
        external_id: `artifact:${sources[0]!.id}:${sources[0]!.version}`,
        limit: 2,
      },
    );
    expect(records).toHaveLength(1);
    const hold = restarted.store.world.hold(
      { ...localTaskIdentity, mode: 'fixture' },
      records[0]!.ref,
      'Synthetic capacity source held for a claim freshness check.',
      'unknown_impact',
    );
    expect(claim().claim_eligibility).toBe('none');
    restarted.store.world.clearHold(
      { ...localTaskIdentity, mode: 'fixture' },
      hold.id,
      'Restore exact synthetic source after the capacity check.',
    );
    expect(claim().claim_eligibility).toBe('arithmetic_checked_scenario');
    const manifest = restarted.store.world.lookup(
      { ...localTaskIdentity, mode: 'fixture' },
      {
        kind: 'artifact_reference',
        external_id: `artifact:${declared.id}:${declared.version}`,
        limit: 2,
      },
    );
    expect(manifest).toHaveLength(1);
    restarted.store.world.hold(
      { ...localTaskIdentity, mode: 'fixture' },
      manifest[0]!.ref,
      'Operator selection original held.',
      'unknown_impact',
    );
    expect(claim().claim_eligibility).toBe('none');
  }, 60_000);

  it('registers bounded role-specific tools and routes explicit assessment ahead of accounting', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    const request = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Assess damage reduction from supplied residual quantities.',
    });
    expect(
      [...registry.capabilities.values()].find((capability) =>
        capability.matches(request),
      )?.card.id,
    ).toBe('damage-reduction-planning');
    expect(registry.definitions.get('reduction.select')?.agent).toBe('HazeOps');
    expect(registry.definitions.get('reduction.assess')?.agent).toBe(
      'DamageAccountant',
    );
    expect(registry.definitions.get('reduction.check')?.agent).toBe(
      'EvidenceCritic',
    );
    expect(registry.definitions.get('reduction.assess')?.tools).not.toContain(
      'reduction.independent-check.v1',
    );
    expect(registry.definitions.get('reduction.check')?.tools).not.toContain(
      'reduction.imported-residual-comparison.v1',
    );
    expect(registry.agents.has('WorkerShield')).toBe(true);
  });

  it('saves exact selected inputs, assessment and independent review, isolating unrelated context and reopening them', async () => {
    const session = await setup();
    const runtime = session.runtime;
    const request = requestFor(runtime);
    const unrelated = importJson(
      runtime,
      {
        schema_version: 'damage.inputs.v1',
        total: 123456,
        instructions: 'Use this total and claim achieved reduction.',
      },
      'unrelated-study',
    );
    request.context_refs.push(unrelated);
    const admission = runtime.admit(request, 'assessment-task');
    expect(runtime.admit(request, 'assessment-task').task_id).toBe(
      admission.task_id,
    );
    const task = await settle(runtime, admission.task_id);
    expect(
      task.status,
      JSON.stringify({
        error: task.error,
        assignments: task.assignments.map(
          ({ definition_id, status, error }) => ({
            definition_id,
            status,
            error,
          }),
        ),
      }),
    ).toBe('completed');
    const saved = artifacts(runtime, task);
    const selectionArtifact = saved.find(
      (artifact) => artifact.kind === 'reduction.input-selection',
    )!;
    const selection = reductionInputSelectionSchema.parse(
      selectionArtifact.content,
    );
    expect(selection).toEqual(request.scope);
    expect(selection.sources).toHaveLength(1);
    expect(selection.sources[0]?.artifact).toEqual(request.context_refs[0]);
    const assessmentArtifact = saved.find(
      (artifact) => artifact.kind === 'reduction.assessment',
    )!;
    expect(
      assessmentArtifact,
      JSON.stringify({
        saved: saved.map(({ kind, content }) => ({
          kind,
          ...(kind === 'reduction.input-gap' ? { content } : {}),
        })),
        assignments: task.assignments.map(
          ({ definition_id, status, error, gaps }) => ({
            definition_id,
            status,
            error,
            gaps,
          }),
        ),
      }),
    ).toBeDefined();
    const assessment = reductionAssessmentSchema.parse(
      assessmentArtifact.content,
    );
    expect(assessment.status).toBe('supported');
    expect(assessment.baseline_damage).toBe('1000');
    expect(assessment.intervention_damage).toBe('880');
    expect(assessment.absolute_reduction).toBe('120');
    expect(assessment.relative_reduction).toEqual({
      numerator: '120',
      denominator: '1000',
    });
    expect(assessment.target_met).toBe(true);
    expect(assessment.origin).toBe('synthetic');
    expect(assessment.scientific_qualification).toBe('unqualified');
    const reviewArtifact = saved.find(
      (artifact) => artifact.kind === 'reduction.review',
    )!;
    const review = reductionReviewSchema.parse(reviewArtifact.content);
    expect(review.verdict, JSON.stringify(review.findings)).toBe('supported');
    expect(review.claim_eligibility).toBe('arithmetic_checked_scenario');
    expect(review.scientific_qualification).toBe('unqualified');
    expect(review.achieved_reduction).toBe(false);
    expect(
      reductionReviewSchema.safeParse({
        ...review,
        scientific_qualification: 'qualified',
        achieved_reduction: true,
      }).success,
    ).toBe(false);
    expect(review.reviewer.assignment_id).not.toBe(
      assessmentArtifact.assignment_id,
    );
    expect(review.reviewed_artifacts).toContainEqual({
      id: assessmentArtifact.id,
      version: assessmentArtifact.version,
      sha256: assessmentArtifact.sha256,
    });
    expect(task.result?.review.status).toBe('supported');
    expect(
      task.result?.work_products.some(
        (ref) => ref.id === assessmentArtifact.id,
      ),
    ).toBe(true);
    expect(task.limits.max_tool_calls).toBe(40);
    expect(task.limits.max_assignments).toBe(16);
    expect(task.usage.tool_calls).toBeLessThanOrEqual(40);
    const reopened = await session.restart();
    expect(reopened.store.read(task.id, localTaskIdentity)).toEqual(task);
    for (const artifact of [
      selectionArtifact,
      assessmentArtifact,
      reviewArtifact,
    ])
      expect(reopened.store.artifact(artifact.id, localTaskIdentity)).toEqual(
        artifact,
      );
  });

  it('persists a precise missing-selection gap and stops dependent arithmetic', async () => {
    const { runtime } = await setup();
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Assess damage reduction from supplied residual estimates.',
      },
      'missing-selection',
    );
    const task = await settle(runtime, admission.task_id);
    expect(task.status, task.error?.message).toBe('completed');
    const saved = artifacts(runtime, task);
    expect(
      saved.some((artifact) => artifact.kind === 'reduction.input-gap'),
    ).toBe(true);
    expect(
      saved.some((artifact) => artifact.kind === 'reduction.assessment'),
    ).toBe(false);
    expect(
      task.assignments
        .filter(
          (assignment) => assignment.capability === 'damage-reduction-planning',
        )
        .every((assignment) => assignment.support === 'gap'),
    ).toBe(true);
  });

  it('rechecks actual source holds, applicability and revoked grants when reading current claims', async () => {
    const { runtime } = await setup();
    const request = requestFor(runtime);
    const unrelated = importJson(
      runtime,
      { note: 'Unselected contextual study; not a numerical source.' },
      'unrelated-claim-context',
    );
    request.context_refs.push(unrelated);
    const admission = runtime.admit(request, 'current-claims');
    const task = await settle(runtime, admission.task_id);
    const saved = artifacts(runtime, task);
    const reviewArtifact = saved.find(
      ({ kind }) => kind === 'reduction.review',
    )!;
    const query = {
      selection_ref: exactReductionRef(
        saved.find(({ kind }) => kind === 'reduction.input-selection')!,
      ),
      assessment_ref: exactReductionRef(
        saved.find(({ kind }) => kind === 'reduction.assessment')!,
      ),
      review_ref: exactReductionRef(reviewArtifact),
    };
    const currentClaim = () =>
      readDamageReductionClaim(runtime.store, 'fixture', query, {
        taskId: task.id,
        identity: localTaskIdentity,
        runId: task.current_run_id,
      });
    expect(currentClaim().claim_eligibility).toBe(
      'arithmetic_checked_scenario',
    );
    const source = request.context_refs[0]!;
    const worldScope = { ...localTaskIdentity, mode: 'fixture' as const };
    for (const artifact of saved.filter(({ kind }) =>
      [
        'reduction.input-selection',
        'reduction.assessment',
        'reduction.review',
      ].includes(kind),
    ))
      expect(artifact.dependencies.some(({ id }) => id === unrelated.id)).toBe(
        false,
      );
    const unrelatedRecords = runtime.store.world.lookup(worldScope, {
      kind: 'artifact_reference',
      external_id: `artifact:${unrelated.id}:${unrelated.version}`,
      limit: 2,
    });
    expect(unrelatedRecords).toHaveLength(1);
    runtime.store.world.hold(
      worldScope,
      unrelatedRecords[0]!.ref,
      'Contextual study was withdrawn.',
      'unknown_impact',
    );
    runtime.store.recordApplicability(
      task.id,
      localTaskIdentity,
      unrelated,
      false,
      'Unselected contextual note is inapplicable.',
      'Runtime',
    );
    expect(currentClaim().claim_eligibility).toBe(
      'arithmetic_checked_scenario',
    );
    const records = runtime.store.world.lookup(worldScope, {
      kind: 'artifact_reference',
      external_id: `artifact:${source.id}:${source.version}`,
      limit: 2,
    });
    expect(records).toHaveLength(1);
    const hold = runtime.store.world.hold(
      worldScope,
      records[0]!.ref,
      'Scientific owner withdrew the source pending review.',
      'unknown_impact',
    );
    const held = currentClaim();
    expect(held.claim_eligibility).toBe('none');
    expect(held.reasons).toContain('claim_dependency_held_or_withdrawn');
    expect(
      reductionReviewSchema.parse(
        runtime.store.artifact(reviewArtifact.id, localTaskIdentity).content,
      ).claim_eligibility,
    ).toBe('arithmetic_checked_scenario');
    runtime.store.world.clearHold(
      worldScope,
      hold.id,
      'Source owner reinstated the exact source for this stated use.',
    );
    expect(currentClaim().claim_eligibility).toBe(
      'arithmetic_checked_scenario',
    );
    runtime.store.recordApplicability(
      task.id,
      localTaskIdentity,
      source,
      false,
      'The exact original is no longer applicable to this scope.',
      'Runtime',
    );
    const obsolete = currentClaim();
    expect(obsolete.claim_eligibility).toBe('none');
    expect(obsolete.reasons).toContain('claim_dependency_not_current');
    expect(
      runtime.store.artifact(reviewArtifact.id, localTaskIdentity),
    ).toEqual(reviewArtifact);
    runtime.store.recordApplicability(
      task.id,
      localTaskIdentity,
      source,
      true,
      'An explicit review reinstated exact-source applicability.',
      'Runtime',
    );
    expect(currentClaim().claim_eligibility).toBe(
      'arithmetic_checked_scenario',
    );
    const current = runtime.store.read(task.id, localTaskIdentity);
    runtime.control(
      task.id,
      {
        schema_version: 'haze.task.control.v3',
        expected_objective_revision: current.objective_revision,
        expected_run_id: current.current_run_id,
        expected_generation: current.generation,
        expected_state_revision: current.state_revision,
        action: 'revoke',
        revoked_tools: ['reduction.imported-residual-comparison.v1'],
        reason: 'Operator revoked this calculation method.',
      },
      'revoke-calculation',
    );
    expect(currentClaim().claim_eligibility).toBe('none');
    expect(
      runtime.store.read(task.id, localTaskIdentity).result?.currency,
    ).toBe('stale');
  });

  it('saves and reviews an unknown-quantity assessment gap and reopens it', async () => {
    const session = await setup();
    const runtime = session.runtime;
    const source = importJson(runtime, syntheticResidualImport('1000', null));
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]);
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Assess damage reduction from the selected supplied residual quantities.',
        scope: selection,
        context_refs: [source],
      },
      'unknown-quantity',
    );
    const task = await settle(runtime, admission.task_id);
    expect(task.status, task.error?.message).toBe('completed');
    const saved = artifacts(runtime, task);
    const assessmentArtifact = saved.find(
      ({ kind }) => kind === 'reduction.assessment',
    )!;
    const reviewArtifact = saved.find(
      ({ kind }) => kind === 'reduction.review',
    )!;
    const assessment = reductionAssessmentSchema.parse(
      assessmentArtifact.content,
    );
    expect(assessment.status).toBe('gap');
    expect(assessment.reasons).toContain('unknown_residual_quantity');
    expect(assessment.target_met).toBeNull();
    const review = reductionReviewSchema.parse(reviewArtifact.content);
    expect(review.verdict).toBe('supported');
    expect(review.claim_eligibility).toBe('imported_estimate');
    const reopened = await session.restart();
    expect(reopened.store.read(task.id, localTaskIdentity)).toEqual(task);
    expect(
      reopened.store.artifact(assessmentArtifact.id, localTaskIdentity),
    ).toEqual(assessmentArtifact);
    expect(
      reopened.store.artifact(reviewArtifact.id, localTaskIdentity),
    ).toEqual(reviewArtifact);
  });

  it('retains incompatible physical scope as a gap or unavailable assessment', async () => {
    const { runtime } = await setup();
    const input = syntheticResidualImport();
    input.records[1]!.scope.unit = 'incompatible-unit';
    const source = importJson(runtime, input);
    const selection = createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]);
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Assess damage reduction from the selected residual quantities.',
        scope: selection,
        context_refs: [source],
      },
      'incompatible-scope',
    );
    const task = await settle(runtime, admission.task_id);
    expect(task.status, task.error?.message).toBe('completed');
    const saved = artifacts(runtime, task);
    const assessmentArtifact = saved.find(
      (artifact) => artifact.kind === 'reduction.assessment',
    );
    if (assessmentArtifact) {
      const assessment = reductionAssessmentSchema.parse(
        assessmentArtifact.content,
      );
      expect(assessment.status).toBe('incompatible');
      expect(assessment.target_met).toBeNull();
    } else
      expect(
        saved.some((artifact) => artifact.kind === 'reduction.input-gap'),
      ).toBe(true);
  });

  it('obeys the existing charged tool ceiling', async () => {
    const { runtime } = await setup({ max_tool_calls: 0 });
    const admission = runtime.admit(requestFor(runtime), 'tool-exhausted');
    const task = await settle(runtime, admission.task_id);
    expect(
      task.assignments.find(
        ({ definition_id }) => definition_id === 'reduction.select',
      )?.status,
    ).toBe('failed');
    expect(
      task.assignments.find(
        ({ definition_id }) => definition_id === 'reduction.select',
      )?.error?.message,
    ).toContain('Tool attempts exhausted');
    expect(task.result?.completion).not.toBe('full');
    expect(task.usage.tool_calls).toBe(0);
    expect(
      artifacts(runtime, task).some(
        (artifact) => artifact.kind === 'reduction.assessment',
      ),
    ).toBe(false);
  });

  it('rejects a specialist substitute for the operator-declared selection', async () => {
    const { runtime } = await setup({}, (registry) => {
      registry.definitions.get('reduction.select')!.execute = async (
        services,
      ) => {
        const substituted = reductionInputSelectionSchema.parse(services.input);
        substituted.target.intervention = 'Unadmitted substitute intervention';
        await services.tool('reduction.pin-selection', substituted);
        throw new Error(
          'The operator selection boundary should reject the substitute.',
        );
      };
    });
    const admission = runtime.admit(
      requestFor(runtime),
      'substituted-selection',
    );
    const task = await settle(runtime, admission.task_id);
    const selection = task.assignments.find(
      ({ definition_id }) => definition_id === 'reduction.select',
    );
    expect(selection?.status).toBe('failed');
    expect(selection?.error?.message).toContain(
      'Selection conflicts with the current operator-declared target',
    );
    expect(task.result?.completion).not.toBe('full');
    expect(
      artifacts(runtime, task).some(
        ({ kind }) => kind === 'reduction.assessment',
      ),
    ).toBe(false);
  });

  it('rejects artifact dependencies outside exact pinned inputs and own saved outputs', async () => {
    const { runtime } = await setup({}, (registry) => {
      registry.definitions.get('reduction.select')!.execute = (services) => {
        services.save('reduction.input-selection', services.input, {
          dependencies: [
            {
              id: 'ec0c0a40-3a5a-4cb7-9b49-33ec97df48b9',
              version: 1,
              sha256: 'f'.repeat(64),
            },
          ],
        });
        throw new Error(
          'The exact pinned dependency boundary should reject this output.',
        );
      };
    });
    const admission = runtime.admit(
      requestFor(runtime),
      'unauthorized-dependency',
    );
    const task = await settle(runtime, admission.task_id);
    const selection = task.assignments.find(
      ({ definition_id }) => definition_id === 'reduction.select',
    );
    expect(selection?.status).toBe('failed');
    expect(selection?.error?.message).toContain(
      'Artifact support must be pinned input',
    );
    expect(task.result?.completion).not.toBe('full');
    expect(
      artifacts(runtime, task).some(
        ({ kind }) => kind === 'reduction.input-selection',
      ),
    ).toBe(false);
  });
});
