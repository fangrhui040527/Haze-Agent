import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import { damageAccountSchema } from '../../app/contracts/damage-account.js';
import { damageWorldSelectionSchema } from '../../app/contracts/damage-world.js';
import { contractHash } from '../../app/contracts/json.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import {
  createSyntheticDamageImport,
  SYNTHETIC_DAMAGE_EXPECTATIONS,
} from '../../app/capabilities/damage-appraisal/fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-world-damage-'));
  const runtime = new TaskRuntime({
    stateDirectory: directory,
    mode: 'fixture',
    registry: createExecutionRegistry({ mode: 'fixture' }),
  });
  cleanup.push(async () => {
    await runtime.close();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..') || rel.includes(':'))
      throw new Error('Unsafe test cleanup.');
    await rm(directory, { recursive: true, force: true });
  });
  return runtime;
}
async function settled(runtime: TaskRuntime, id: string) {
  try {
    await expect
      .poll(() => runtime.store.read(id, localTaskIdentity).status, {
        timeout: 35000,
      })
      .not.toMatch(/^(queued|running)$/u);
  } catch {
    const task = runtime.store.read(id, localTaskIdentity);
    throw new Error(
      JSON.stringify({
        status: task.status,
        error: task.error,
        work: task.assignments.map((a) => ({
          id: a.definition_id,
          status: a.status,
          error: a.error,
          gaps: a.gaps,
        })),
        questions: task.questions,
        usage: task.usage,
        decisions: task.manager?.decisions.slice(-2),
      }),
    );
  }
  return runtime.store.read(id, localTaskIdentity);
}
async function seed(runtime: TaskRuntime, quantityChange = 0) {
  const input = createSyntheticDamageImport();
  input.effects[0]!.quantity! += quantityChange;
  const source = runtime.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'retained-test-evidence.json',
      media_type: 'application/json',
      content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
    },
    'seed-source-' + quantityChange,
  );
  const task = runtime.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Build a damage account from retained source evidence.',
      context_refs: [
        { id: source.id, version: source.version, sha256: source.sha256 },
      ],
    },
    'seed-task-' + quantityChange,
  );
  const complete = await settled(runtime, task.task_id);
  expect(complete.status, complete.error?.message).toBe('completed');
  return { source, task: complete };
}
function consumer(
  runtime: TaskRuntime,
  key: string,
  scope: unknown = createSyntheticDamageImport().scope,
) {
  return runtime.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective:
        'Build a damage account for Fixture Region for September to October 2015 using World Model.',
      ...(scope === undefined || scope === null ? {} : { scope }),
    },
    key,
  ).task_id;
}
function originals(runtime: TaskRuntime, task: TaskRecord) {
  return task.artifacts.map((a) =>
    runtime.store.artifact(a.artifact.id, localTaskIdentity),
  );
}

describe('WorldModelDamageInputAdapter integration', () => {
  it('builds and independently checks an account without consumer uploads, retaining original evidence', async () => {
    const runtime = await setup();
    const retained = await seed(runtime);
    const task = await settled(
      runtime,
      consumer(runtime, 'world-account', null),
    );
    expect(
      task.status,
      JSON.stringify({
        error: task.error,
        work: task.assignments.map((a) => [a.definition_id, a.status, a.error]),
      }),
    ).toBe('completed');
    expect(task.original_request.context_refs).toEqual([]);
    expect(task.original_request.scope).toBeUndefined();
    const artifacts = originals(runtime, task);
    const account = damageAccountSchema.parse(
      artifacts.find((a) => a.kind === 'damage.account')!.content,
    );
    expect(
      account.welfare_totals.find((t) => t.scenario_id === 'historical')
        ?.amount,
    ).toBeCloseTo(SYNTHETIC_DAMAGE_EXPECTATIONS.historical_loss, 6);
    const selection = artifacts.find(
      (a) => a.kind === 'damage.world-selection',
    )!;
    const receipt = damageWorldSelectionSchema.parse(selection.content);
    expect(receipt.source_refs).toContainEqual({
      id: retained.source.id,
      version: retained.source.version,
      sha256: retained.source.sha256,
    });
    expect(selection.producer).toEqual({
      kind: 'service',
      id: 'world-model-damage-input-adapter',
    });
    expect(
      task.result?.review.checks?.filter((c) => c.verdict === 'supported'),
    ).toHaveLength(5);
    for (const assignment of task.assignments.filter((a) =>
      [
        'damage.collect',
        'damage.scope',
        'damage.compile',
        'damage.assemble',
        'damage.check',
      ].includes(a.definition_id),
    )) {
      expect(
        assignment.inputs.some((ref) => ref.id === retained.source.id),
      ).toBe(true);
      expect(assignment.inputs.some((ref) => ref.id === selection.id)).toBe(
        true,
      );
    }
    runtime.update(
      task.id,
      {
        schema_version: 'haze.task.update.v3',
        kind: 'correction',
        expected_objective_revision: task.objective_revision,
        expected_run_id: task.current_run_id,
        expected_generation: task.generation,
        expected_state_revision: task.state_revision,
        passage:
          'Rebuild the account for Fixture Region for September to October 2015 using World Model.',
        affected_assignment_ids: task.assignments
          .filter((assignment) =>
            assignment.definition_id.startsWith('damage.'),
          )
          .map((assignment) => assignment.id),
      },
      'refresh-world-account',
    );
    const corrected = runtime.store.read(task.id, localTaskIdentity);
    runtime.control(
      task.id,
      {
        schema_version: 'haze.task.control.v3',
        action: 'resume',
        expected_objective_revision: corrected.objective_revision,
        expected_run_id: corrected.current_run_id,
        expected_generation: corrected.generation,
        expected_state_revision: corrected.state_revision,
      },
      'resume-refreshed-world-account',
    );
    const refreshed = await settled(runtime, task.id);
    expect(
      refreshed.status,
      JSON.stringify({
        error: refreshed.error,
        usage: refreshed.usage,
        decisions: refreshed.manager?.decisions.slice(-2),
        assignments: refreshed.assignments.map((a) => ({
          definition: a.definition_id,
          status: a.status,
          error: a.error,
          gaps: a.gaps,
        })),
      }),
    ).toBe('completed');
    const currentAssignments = refreshed.assignments.filter(
      (a) =>
        a.definition_id.startsWith('damage.') &&
        a.status === 'completed' &&
        a.objective_revision === refreshed.objective_revision,
    );
    expect(currentAssignments).toHaveLength(5);
    for (const assignment of currentAssignments) {
      const receipts = assignment.inputs
        .map((ref) => runtime.store.artifact(ref.id, localTaskIdentity, ref))
        .filter((artifact) => artifact.kind === 'damage.world-selection');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.id).not.toBe(selection.id);
    }
  }, 90000);

  it('reports a backend acquisition gap without asking for uploaded files', async () => {
    const runtime = await setup();
    const task = await settled(runtime, consumer(runtime, 'empty-world'));
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.questions).toHaveLength(0);
    expect(task.assignments.flatMap((a) => a.gaps).join(' ')).toContain(
      'Backend acquisition',
    );
    expect(
      originals(runtime, task).some((a) => a.kind === 'damage.account'),
    ).toBe(false);
  }, 20000);

  it('refuses a different geography and does not relabel retained quantities', async () => {
    const runtime = await setup();
    await seed(runtime);
    const scope = {
      ...createSyntheticDamageImport().scope!,
      countries: ['Different Country'],
    };
    const task = await settled(
      runtime,
      consumer(runtime, 'different-geography', scope),
    );
    expect(task.status, task.error?.message).toBe('completed');
    expect(
      originals(runtime, task).some((a) => a.kind === 'damage.account'),
    ).toBe(false);
  }, 35000);

  it('requires a selection when different evidence sets match instead of choosing the latest', async () => {
    const runtime = await setup();
    await seed(runtime);
    await seed(runtime, 1);
    const task = await settled(
      runtime,
      consumer(runtime, 'ambiguous-evidence'),
    );
    expect(task.status, task.error?.message).toBe('waiting');
    expect(
      task.questions.some((q) =>
        q.question.includes('Several different scoped evidence sets'),
      ),
    ).toBe(true);
    expect(
      originals(runtime, task).some((a) => a.kind === 'damage.account'),
    ).toBe(false);
  }, 45000);

  it('withholds evidence on a World Model hold', async () => {
    const runtime = await setup();
    const retained = await seed(runtime);
    const capture = originals(runtime, retained.task).find(
      (a) => a.kind === 'damage.inputs',
    )!;
    const scope = { ...localTaskIdentity, mode: 'fixture' as const };
    const record = runtime.store.world
      .lookup(scope, {
        kind: 'artifact_reference',
        artifact_kind: 'damage.inputs',
        limit: 50,
      })
      .find(
        (r) =>
          typeof r.payload === 'object' &&
          r.payload !== null &&
          !Array.isArray(r.payload) &&
          contractHash(r.payload.artifact) ===
            contractHash({
              id: capture.id,
              version: capture.version,
              sha256: capture.sha256,
            }),
      )!;
    runtime.store.world.hold(
      scope,
      record.ref,
      'A source correction requires reconsideration.',
      'correction',
    );
    const task = await settled(runtime, consumer(runtime, 'held-inputs'));
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.assignments.flatMap((a) => a.gaps).join(' ')).toContain(
      'active hold',
    );
    expect(
      originals(runtime, task).some((a) => a.kind === 'damage.account'),
    ).toBe(false);
  }, 35000);
});
