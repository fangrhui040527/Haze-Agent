import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import type { Artifact } from '../../app/contracts/artifacts.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import { createReductionSelection } from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import { readDamageReductionPreview } from '../../app/capabilities/damage-reduction-planning/view.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-reduction-preview-'));
  let runtime = new TaskRuntime({
    stateDirectory: directory,
    mode: 'fixture',
    registry: createExecutionRegistry({ mode: 'fixture' }),
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
function imported(
  runtime: TaskRuntime,
  baseline: string | null = '1000',
  intervention: string | null = '880',
) {
  const input = syntheticResidualImport(baseline, intervention);
  const artifact = runtime.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'synthetic-preview-residuals.json',
      media_type: 'application/json',
      declared_origin:
        'Synthetic preview engineering fixture; no empirical evidence.',
      content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
    },
    'preview-source',
  );
  return {
    source: {
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
    },
    input,
  };
}
function previewRequest(
  runtime: TaskRuntime,
  intervention: string | null = '880',
) {
  const { source, input } = imported(runtime, '1000', intervention);
  return {
    request: {
      schema_version: 'haze.task.request.v3',
      objective:
        'Prepare a conditional damage-reduction planning preview for the supplied digital exposure-alert and work-schedule option. Preserve scientific prerequisites and independent reviews.',
      scope: {
        schema_version: 'haze.reduction.preview-request.v1',
        selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
          { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
        ]),
        candidate: syntheticReductionCandidate(),
      },
      context_refs: [source],
    },
    source,
    input,
  };
}
async function settle(runtime: TaskRuntime, id: string) {
  await expect
    .poll(() => runtime.store.read(id, localTaskIdentity).status, {
      timeout: 20_000,
    })
    .not.toMatch(/^(queued|running)$/);
  return runtime.store.read(id, localTaskIdentity);
}
function saved(runtime: TaskRuntime, task: TaskRecord): Artifact[] {
  return task.artifacts.map(({ artifact }) =>
    runtime.store.artifact(artifact.id, localTaskIdentity, artifact),
  );
}
const fence = (task: TaskRecord) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
const view = (runtime: TaskRuntime, id: string) =>
  readDamageReductionPreview(runtime.store, 'fixture', id, localTaskIdentity);

describe('conditional damage reduction preview task', () => {
  it('routes preview requests before accounting, retains the assessment-only path and leaves explanations direct', () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    const request = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Prepare a conditional damage-reduction planning preview.',
    });
    const capability = [...registry.capabilities.values()].find((item) =>
      item.matches(request),
    );
    expect(capability?.card.id).toBe('damage-reduction-planning');
    const explain = taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Explain how damage reduction targets are compared.',
    });
    expect(
      registry.capabilities.get('damage-reduction-planning')?.matches(explain),
    ).toBe(false);
    expect(registry.definitions.get('reduction.plan')?.agent).toBe(
      'WorkerShield',
    );
    expect(registry.definitions.get('reduction.plan-check')?.agent).toBe(
      'EvidenceCritic',
    );
  });

  it.each([
    ['supported', '880', true, 'meets'],
    ['below target', '950', false, 'does_not_meet'],
    ['insufficient evidence', null, null, 'unavailable'],
  ] as const)(
    'retains the complete %s preview and independent reviews within the existing ceilings',
    async (_label, intervention, targetMet, pointEstimate) => {
      const session = await setup();
      const runtime = session.runtime;
      const { request, source, input } = previewRequest(runtime, intervention);
      const admission = runtime.admit(request, `preview-${_label}`);
      expect(runtime.admit(request, `preview-${_label}`).task_id).toBe(
        admission.task_id,
      );
      const task = await settle(runtime, admission.task_id);
      expect(
        task.status,
        JSON.stringify({
          error: task.error,
          work: task.assignments.map(({ definition_id, status, error }) => ({
            definition_id,
            status,
            error,
          })),
        }),
      ).toBe('completed');
      const result = view(runtime, task.id);
      expect(result.assessment?.value.target_met).toBe(targetMet);
      expect(result.claims?.point_estimate_label).toBe(pointEstimate);
      expect(result.selection?.value).toEqual(request.scope.selection);
      expect(result.arithmetic_review?.value.verdict).toBe('supported');
      expect(result.plan).not.toBeNull();
      expect(result.plan_review?.value.verdict).toBe('supported');
      expect(result.state).toBe('current');
      expect(result.claims?.scientific_qualification).toBe('unqualified');
      expect(result.claims?.achieved_reduction).toBe(false);
      expect(result.source_refs).toContainEqual(source);
      expect(
        runtime.store.artifact(source.id, localTaskIdentity, source).content,
      ).toEqual(input);
      expect(
        new Set(
          task.assignments
            .filter(({ role }) => role !== 'Manager')
            .map(({ role }) => role),
        ),
      ).toEqual(
        new Set([
          'HazeOps',
          'DamageAccountant',
          'WorkerShield',
          'EvidenceCritic',
        ]),
      );
      expect(task.limits.max_tool_calls).toBe(40);
      expect(task.limits.max_assignments).toBe(16);
      expect(task.limits.max_artifacts).toBe(64);
      expect(task.usage.tool_calls).toBeLessThanOrEqual(40);
      expect(task.usage.assignments).toBeLessThanOrEqual(16);
      expect(task.usage.artifacts).toBeLessThanOrEqual(64);
      const products = saved(runtime, task).filter(({ kind }) =>
        kind.startsWith('reduction.'),
      );
      const reopened = await session.restart();
      expect(reopened.store.read(task.id, localTaskIdentity)).toEqual(task);
      for (const product of products)
        expect(reopened.store.artifact(product.id, localTaskIdentity)).toEqual(
          product,
        );
      const after = view(reopened, task.id);
      expect(after.plan).toEqual(result.plan);
      expect(after.plan_review).toEqual(result.plan_review);
      expect(after.claims?.point_estimate_label).toBe(pointEstimate);
    },
  );

  it('withholds current preview support when an exact source is held or no longer applicable', async () => {
    const { runtime } = await setup();
    const { request, source } = previewRequest(runtime);
    const admission = runtime.admit(request, 'preview-source-currency');
    const task = await settle(runtime, admission.task_id);
    const before = view(runtime, task.id);
    expect(before.plan_eligibility).toBe('conditional');
    const historicalPlan = runtime.store.artifact(
      before.plan!.artifact.id,
      localTaskIdentity,
    );
    const historicalReview = runtime.store.artifact(
      before.plan_review!.artifact.id,
      localTaskIdentity,
    );
    const scope = { ...localTaskIdentity, mode: 'fixture' as const };
    const record = runtime.store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${source.id}:${source.version}`,
      limit: 2,
    })[0]!;
    const hold = runtime.store.world.hold(
      scope,
      record.ref,
      'Exact physical source applicability is disputed.',
      'unknown_impact',
    );
    const held = view(runtime, task.id);
    expect(held.plan_eligibility).toBe('none');
    expect(held.claims?.claim_eligibility ?? 'none').toBe('none');
    expect(
      runtime.store.artifact(historicalPlan.id, localTaskIdentity),
    ).toEqual(historicalPlan);
    expect(
      runtime.store.artifact(historicalReview.id, localTaskIdentity),
    ).toEqual(historicalReview);
    runtime.store.world.clearHold(
      scope,
      hold.id,
      'Exact-source applicability explicitly reinstated.',
    );
    expect(view(runtime, task.id).plan_eligibility).toBe('conditional');
    runtime.store.recordApplicability(
      task.id,
      localTaskIdentity,
      source,
      false,
      'Evidence does not apply to the revised local scope.',
      'Runtime',
    );
    expect(view(runtime, task.id).plan_eligibility).toBe('none');
    expect(view(runtime, task.id).claims?.claim_eligibility ?? 'none').toBe(
      'none',
    );
  });

  it('preserves old plans through an explicit correction and reopens a reviewed replacement', async () => {
    const { runtime } = await setup();
    const { request } = previewRequest(runtime);
    const admission = runtime.admit(request, 'preview-correction');
    const before = await settle(runtime, admission.task_id);
    const old = view(runtime, before.id);
    const correctedScope = structuredClone(request.scope);
    correctedScope.selection.target.target_fraction = '0.15';
    runtime.update(
      before.id,
      {
        schema_version: 'haze.task.update.v3',
        ...fence(before),
        kind: 'correction',
        passage:
          'Use an inclusive fifteen percent target, preserving the supplied candidate and original source.',
        scope: correctedScope,
        affected_assignment_ids: before.assignments
          .filter(({ role }) => role !== 'Manager')
          .map(({ id }) => id),
      },
      'correct-preview-target',
    );
    const corrected = runtime.store.read(before.id, localTaskIdentity);
    expect(corrected.result?.currency).toBe('stale');
    expect(view(runtime, before.id).plan_eligibility).toBe('none');
    expect(
      runtime.store.artifact(old.plan!.artifact.id, localTaskIdentity),
    ).toEqual(
      saved(runtime, before).find(({ id }) => id === old.plan!.artifact.id),
    );
    runtime.control(
      before.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(corrected),
        action: 'resume',
      },
      'resume-preview-correction',
    );
    const after = await settle(runtime, before.id);
    expect(after.status, JSON.stringify(after.error)).toBe('completed');
    const replacement = view(runtime, after.id);
    expect(replacement.selection?.value.target.target_fraction).toBe('0.15');
    expect(replacement.claims?.point_estimate_label).toBe('does_not_meet');
    expect(replacement.plan_review?.value.verdict).toBe('supported');
    expect(replacement.plan?.artifact.id).not.toBe(old.plan?.artifact.id);
    expect(
      after.artifacts.some(
        ({ artifact, current }) =>
          artifact.id === old.plan?.artifact.id && !current,
      ),
    ).toBe(true);
  });

  it('supports explicit pause and resume, then reflects revoked method access in the saved preview', async () => {
    const { runtime } = await setup();
    const { request } = previewRequest(runtime);
    const admission = runtime.admit(request, 'preview-controls');
    const queued = runtime.store.read(admission.task_id, localTaskIdentity);
    runtime.control(
      queued.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(queued),
        action: 'pause',
        reason: 'Operator requested a pause before review.',
      },
      'pause-preview',
    );
    const paused = runtime.store.read(queued.id, localTaskIdentity);
    expect(paused.status).toBe('paused');
    runtime.control(
      queued.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(paused),
        action: 'resume',
      },
      'resume-preview',
    );
    const completed = await settle(runtime, queued.id);
    expect(completed.status).toBe('completed');
    expect(view(runtime, queued.id).plan_eligibility).toBe('conditional');
    runtime.control(
      queued.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(completed),
        action: 'revoke',
        revoked_tools: ['reduction.imported-residual-comparison.v1'],
        reason: 'The operator revoked method access.',
      },
      'revoke-preview',
    );
    expect(view(runtime, queued.id).plan_eligibility).toBe('none');
    expect(
      runtime.store.read(queued.id, localTaskIdentity).result?.currency,
    ).toBe('stale');
  });
});
