import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import {
  damageAccountSchema,
  damageReviewSchema,
} from '../../app/contracts/damage-account.js';
import {
  createSyntheticDamageImport,
  SYNTHETIC_DAMAGE_EXPECTATIONS,
} from '../../app/capabilities/damage-appraisal/fixtures.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-damage-runtime-'));
  let runtime = new TaskRuntime({
    stateDirectory: directory,
    mode: 'fixture',
    registry: createExecutionRegistry({ mode: 'fixture' }),
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
async function until(
  runtime: TaskRuntime,
  id: string,
  predicate = (t: TaskRecord) => !['queued', 'running'].includes(t.status),
) {
  await expect
    .poll(() => predicate(runtime.store.read(id, localTaskIdentity)), {
      timeout: 20_000,
    })
    .toBe(true);
  return runtime.store.read(id, localTaskIdentity);
}
function imported(runtime: TaskRuntime) {
  const artifact = runtime.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'synthetic-damage.json',
      media_type: 'application/json',
      declared_origin: 'Synthetic test only; invented CU; no empirical data.',
      content_base64: Buffer.from(
        JSON.stringify(createSyntheticDamageImport()),
      ).toString('base64'),
    },
    'import-damage',
  );
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}
const fence = (t: TaskRecord) => ({
  expected_objective_revision: t.objective_revision,
  expected_run_id: t.current_run_id,
  expected_generation: t.generation,
  expected_state_revision: t.state_revision,
});

describe('damage-appraisal registration and task path', () => {
  it.each([
    ['Build a haze damage account from imported outcomes.', 'damage-appraisal'],
    ['Build a damage appraisal from imported outcomes.', 'damage-appraisal'],
    [
      'Use damage-account-intake to check supplied components.',
      'damage-account-intake',
    ],
    [
      'Calculate a PM2.5 damage account from imported outcomes.',
      'damage-appraisal',
    ],
    [
      'Appraise avoided haze damage using imported project scenarios.',
      'damage-appraisal',
    ],
    ['Summarize ordinary PM2.5 evidence.', 'pm25-evidence-summary'],
    ['Explain the supplied damage report valuation.', 'evidence-synthesis'],
    [
      'Explain how to calculate damage from the supplied source.',
      'evidence-synthesis',
    ],
    [
      'Explain the supplied PM2.5 damage report valuation.',
      'evidence-synthesis',
    ],
    ['Create a damage account, but inputs are missing.', 'damage-appraisal'],
  ])(
    'routes %s to %s without a fixture-specific branch',
    (objective, expected) => {
      const registry = createExecutionRegistry({ mode: 'fixture' });
      const request = taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective,
      });
      expect(
        [...registry.capabilities.values()].find((c) => c.matches(request))
          ?.card.id,
      ).toBe(expected);
    },
  );

  it.each([
    'Build a damage account from the imported synthetic physical outcomes and unit values.',
    'Build a damage account from the exact imported quantities and declared unit values using the registered damage-appraisal capability. Produce physical outcomes, financial incidence, selected social welfare, omissions and scenarios, with an independent exact-component accounting review. Keep imported applicability and synthetic evidence limits visible.',
  ])(
    'reconstructs, reviews and persists the imported account for %s',
    async (objective) => {
      const setupResult = await setup();
      const runtime = setupResult.runtime;
      const source = imported(runtime);
      const request = {
        schema_version: 'haze.task.request.v3',
        objective,
        context_refs: [source],
      };
      const admission = runtime.admit(request, 'account-task');
      expect(runtime.admit(request, 'account-task').task_id).toBe(
        admission.task_id,
      );
      const task = await until(runtime, admission.task_id);
      expect(
        task.status,
        JSON.stringify({
          error: task.error,
          work: task.assignments.map((a) => [
            a.definition_id,
            a.status,
            a.error,
          ]),
        }),
      ).toBe('completed');
      expect(task.assignments.some((a) => a.role === 'DamageAccountant')).toBe(
        true,
      );
      const records = task.artifacts.map((a) =>
        runtime.store.artifact(a.artifact.id, localTaskIdentity),
      );
      const accountArtifact = records.find((a) => a.kind === 'damage.account')!;
      const account = damageAccountSchema.parse(accountArtifact.content);
      expect(account.evidence_origin).toBe('synthetic');
      expect(
        account.welfare_totals.find((t) => t.scenario_id === 'historical')
          ?.amount,
      ).toBeCloseTo(SYNTHETIC_DAMAGE_EXPECTATIONS.historical_loss, 6);
      expect(account.scenarios[0]?.avoided_damage).toBeCloseTo(
        SYNTHETIC_DAMAGE_EXPECTATIONS.avoided_damage,
        6,
      );
      expect(
        account.component_refs.every((c) =>
          accountArtifact.dependencies.some(
            (d) =>
              d.id === c.artifact.id &&
              d.sha256 === c.artifact.sha256 &&
              d.version === c.artifact.version,
          ),
        ),
      ).toBe(true);
      const review = damageReviewSchema.parse(
        records.find((a) => a.kind === 'damage.review')!.content,
      );
      expect(review.verdict, JSON.stringify(review.findings)).toBe('supported');
      expect(review.applicability).toBe('not_established_by_arithmetic');
      expect(
        task.result?.review.checks?.filter((r) => r.verdict === 'supported'),
      ).toHaveLength(5);
      expect(
        task.result?.work_products.some((p) => p.id === accountArtifact.id),
      ).toBe(true);
      const restarted = await setupResult.restart();
      expect(restarted.store.read(task.id, localTaskIdentity)).toEqual(task);
      expect(
        restarted.store.artifact(accountArtifact.id, localTaskIdentity),
      ).toEqual(accountArtifact);
    },
    // Leave room for the 20-second task poll, restart and cleanup.
    30_000,
  );

  it('reports missing World Model evidence without requiring uploads or inventing estimates', async () => {
    const { runtime } = await setup();
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Build a PM2.5 damage account.',
      },
      'missing-inputs',
    );
    const task = await until(runtime, admission.task_id);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.questions).toHaveLength(0);
    expect(task.result?.uncertainty.join(' ')).toContain('World Model');
    expect(task.assignments.flatMap((a) => a.gaps).join(' ')).toContain(
      'Backend acquisition',
    );
    expect(
      task.artifacts.some(
        (a) =>
          runtime.store.artifact(a.artifact.id, localTaskIdentity).kind ===
          'damage.account',
      ),
    ).toBe(false);
    expect(
      task.assignments
        .filter((a) => a.role !== 'Manager')
        .every((a) => a.capability === 'damage-appraisal'),
    ).toBe(true);
  });

  it('holds conflicting corrected geography and keeps the old account stale', async () => {
    const { runtime } = await setup();
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Build a damage account.',
        context_refs: [imported(runtime)],
      },
      'correction-account',
    );
    const before = await until(runtime, admission.task_id);
    expect(before.status, before.error?.message).toBe('completed');
    runtime.update(
      before.id,
      {
        schema_version: 'haze.task.update.v3',
        ...fence(before),
        kind: 'correction',
        passage:
          'Build the damage account for a different country; hold incompatible old effects.',
        scope: { countries: ['Different Country'] },
        affected_assignment_ids: before.assignments
          .filter((a) => a.role !== 'Manager')
          .map((a) => a.id),
      },
      'correct-geography',
    );
    const held = runtime.store.read(before.id, localTaskIdentity);
    expect(held.result?.currency).toBe('stale');
    runtime.control(
      before.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(held),
        action: 'resume',
      },
      'resume-correction',
    );
    const after = await until(
      runtime,
      before.id,
      (t) =>
        t.objective_revision === 2 &&
        ['waiting', 'failed', 'completed'].includes(t.status),
    );
    expect(after.status, after.error?.message).toBe('waiting');
    expect(
      after.questions.some(
        (q) => q.status === 'open' && q.question.includes('countries'),
      ),
    ).toBe(true);
  });

  it('retains cancellation and bounded tool exhaustion through the accounting path', async () => {
    const { runtime } = await setup({ max_tool_calls: 0 });
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Build a damage account.',
        context_refs: [imported(runtime)],
      },
      'exhaust-account',
    );
    const task = await until(runtime, admission.task_id);
    expect(
      task.artifacts.some(
        (a) =>
          runtime.store.artifact(a.artifact.id, localTaskIdentity).kind ===
          'damage.account',
      ),
    ).toBe(false);
    expect(
      task.assignments.some(
        (a) => a.definition_id === 'damage.collect' && a.status === 'failed',
      ),
    ).toBe(true);
    const activeSetup = await setup();
    const activeRuntime = activeSetup.runtime;
    const active = activeRuntime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Build a damage account.',
        context_refs: [imported(activeRuntime)],
        scope: { countries: ['Different Country'] },
      },
      'cancel-waiting-account',
    );
    const waiting = await until(activeRuntime, active.task_id);
    const receipt = activeRuntime.control(
      waiting.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(waiting),
        action: 'cancel',
      },
      'cancel-account',
    );
    expect(receipt).toBeDefined();
    expect(activeRuntime.store.read(waiting.id, localTaskIdentity).status).toBe(
      'cancelled',
    );
  });
});
