import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  artifactSchema,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import {
  reductionProgrammeHistorySchema,
  reductionProgrammeListSchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeViewSchema,
  type ReductionProgrammeBudget,
} from '../../app/contracts/damage-reduction-programme.js';
import { type TaskRecord } from '../../app/contracts/tasks.js';
import {
  SYNTHETIC_REDUCTION_TARGET,
  syntheticResidualImport,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import { createReductionCapacityFixture } from '../../app/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { reductionPreviewSelectionRequestSchema } from '../../app/contracts/damage-reduction-plan.js';
import { reductionSelectionRequestSchema } from '../../app/contracts/damage-reduction.js';
import { ReductionProgrammeService } from '../../app/capabilities/damage-reduction-programmes/service.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import {
  TaskRuntime,
  localTaskIdentity,
  type TaskRuntimeOptions,
} from '../../app/tasks/runtime.js';
import type { ExecutionRegistry } from '../../app/orchestration/ports.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing local address.');
  return `http://127.0.0.1:${address.port}`;
}
async function setup(
  options: {
    dispatchTask?: TaskRuntimeOptions['dispatchTask'];
    configureRegistry?: (registry: ExecutionRegistry) => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-reduction-programmes-'));
  const registry = createExecutionRegistry({ mode: 'fixture' });
  let handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    registry,
    env: {},
    ...(options.dispatchTask ? { dispatchTask: options.dispatchTask } : {}),
  });
  options.configureRegistry?.(registry);
  let server = createServer(handler);
  let origin = await listen(server);
  async function close() {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
  }
  cleanups.push(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get runtime() {
      return handler.runtime;
    },
    get origin() {
      return origin;
    },
    async restart(mode: 'fixture' | 'live' = 'fixture') {
      await close();
      handler = createTaskHandler({
        stateDirectory: directory,
        mode,
        registry: createExecutionRegistry({ mode }),
        env: {},
      });
      server = createServer(handler);
      origin = await listen(server);
    },
    async call(path: string, body?: unknown, key: string = randomUUID()) {
      const response = await fetch(
        `${origin}${path}`,
        body === undefined
          ? { headers: { Connection: 'close' } }
          : {
              method: 'POST',
              headers: {
                Connection: 'close',
                Origin: origin,
                'Content-Type': 'application/json',
                'Idempotency-Key': key,
              },
              body: JSON.stringify(body),
            },
      );
      return {
        status: response.status,
        body: await response.json(),
      };
    },
  };
}
type Api = Awaited<ReturnType<typeof setup>>;
function programmeService(api: Api) {
  const service = api.runtime.extension('reduction-programmes')?.service;
  if (!(service instanceof ReductionProgrammeService))
    throw new Error(
      'The composition-owned programme service was not registered.',
    );
  return service;
}
async function preview(api: Api) {
  const input = syntheticResidualImport();
  const imported = await api.call('/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'programme-physical-residuals.json',
    media_type: 'application/json',
    declared_origin: 'Synthetic engineering programme fixture only.',
    content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
  });
  expect(imported.status).toBe(201);
  const source = exactReductionRef(artifactSchema.parse(imported.body));
  return {
    source,
    request: {
      schema_version: 'haze.reduction.preview-request.v1' as const,
      selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
        { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
      ]),
      candidate: syntheticReductionCandidate(),
    },
  };
}
async function createProgramme(api: Api, budget?: ReductionProgrammeBudget) {
  const fixture = await preview(api);
  const input = {
    schema_version: 'haze.reduction.programme.create.v1',
    expected_revision: 0,
    title: 'Synthetic digital-action programme',
    accountable_owner: 'Synthetic local operator',
    scientific_owner: null,
    preview: fixture.request,
    ...(budget ? { budget } : {}),
  };
  const response = await api.call('/api/reduction-programmes', input);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return {
    ...fixture,
    input,
    receipt: reductionProgrammeMutationReceiptSchema.parse(response.body),
  };
}
async function programme(api: Api, id: string) {
  const response = await api.call(`/api/reduction-programmes/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return reductionProgrammeViewSchema.parse(response.body);
}
async function history(api: Api, id: string) {
  const response = await api.call(`/api/reduction-programmes/${id}/history`);
  expect(response.status).toBe(200);
  return reductionProgrammeHistorySchema.parse(response.body);
}
async function start(
  api: Api,
  id: string,
  phase: 'assessment' | 'planning',
  assessmentAttemptId?: string,
) {
  const current = await programme(api, id);
  const response = await api.call(`/api/reduction-programmes/${id}/phases`, {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: current.programme.revision,
    phase,
    ...(assessmentAttemptId
      ? { assessment_attempt_id: assessmentAttemptId }
      : {}),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return reductionProgrammeMutationReceiptSchema.parse(response.body).attempt!;
}
async function settle(api: Api, id: string) {
  await expect
    .poll(() => api.runtime.store.read(id, localTaskIdentity).status, {
      timeout: 20_000,
    })
    .not.toMatch(/^(queued|running)$/);
  return api.runtime.store.read(id, localTaskIdentity);
}
const fence = (task: TaskRecord) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'checked_at')
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

describe('damage reduction programme integration', () => {
  it('retains the maximum-byte programme assessment and conditional plan through restart', async () => {
    const api = await setup();
    const fixture = createReductionCapacityFixture(500, 16, 524_288);
    const sources: ArtifactRef[] = [];
    for (const [index, artifact] of fixture.artifacts.entries()) {
      const imported = await api.call('/api/artifacts', {
        schema_version: 'haze.artifact.import.v3',
        filename: `programme-capacity-${index}.json`,
        media_type: 'application/json',
        declared_origin: 'Explicit synthetic maximum-byte programme fixture.',
        content_base64: Buffer.from(JSON.stringify(artifact.content)).toString(
          'base64',
        ),
      });
      expect(imported.status, JSON.stringify(imported.body)).toBe(201);
      sources.push(exactReductionRef(artifactSchema.parse(imported.body)));
    }
    const request = {
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title: 'Synthetic maximum-byte programme',
      accountable_owner: 'Synthetic local operator',
      scientific_owner: null,
      preview: {
        schema_version: 'haze.reduction.preview-request.v1',
        selection: createReductionSelection(
          fixture.target,
          fixture.selection.sources.map((source, index) => ({
            ...source,
            artifact: sources[index]!,
          })),
        ),
        candidate: {
          ...syntheticReductionCandidate(),
          name: fixture.target.intervention,
        },
      },
    };
    const created = await api.call('/api/reduction-programmes', request);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = reductionProgrammeMutationReceiptSchema.parse(
      created.body,
    ).programme_id;
    const assessment = await start(api, id, 'assessment');
    const assessmentTask = await settle(api, assessment.task_id);
    expect(assessmentTask.status, JSON.stringify(assessmentTask.error)).toBe(
      'completed',
    );
    const planning = await start(api, id, 'planning', assessment.id);
    const planningTask = await settle(api, planning.task_id);
    expect(planningTask.status, JSON.stringify(planningTask.error)).toBe(
      'completed',
    );
    expect(planningTask.limits.max_model_input_bytes).toBe(24_576);
    const before = await programme(api, id);
    expect(
      Buffer.byteLength(JSON.stringify(before.programme)),
    ).toBeLessThanOrEqual(65_536);
    const result = before.attempts.find(
      ({ attempt }) => attempt.id === planning.id,
    )!;
    expect(result.currency).toBe('current');
    expect(result.preview?.assessment?.value).toMatchObject({
      baseline_damage: '25000',
      intervention_damage: '22000',
      absolute_reduction: '3000',
      target_met: true,
    });
    expect(result.preview?.plan_review?.value.verdict).toBe('supported');
    expect(result.preview?.plan_eligibility).toBe('conditional');
    await api.restart();
    expect(stable(await programme(api, id))).toEqual(stable(before));
  }, 90_000);
  it('keeps the admitted declaration material for inline copies and rejects a substituted programme selection', async () => {
    let selected: ReturnType<typeof createReductionSelection> | undefined;
    const api = await setup({
      configureRegistry(registry) {
        const capability = registry.capabilities.get(
          'damage-reduction-planning',
        )!;
        const assignments = capability.assignments.bind(capability);
        capability.assignments = (request) =>
          assignments(request).map((entry) =>
            entry.definition_id === 'reduction.select' && selected
              ? { ...entry, input: structuredClone(selected) }
              : entry,
          );
      },
    });
    const created = await createProgramme(api);
    selected = created.request.selection;
    const id = created.receipt.programme_id;
    const assessment = await start(api, id, 'assessment');
    expect((await settle(api, assessment.task_id)).status).toBe('completed');
    const planning = await start(api, id, 'planning', assessment.id);
    const plannedTask = await settle(api, planning.task_id);
    expect(plannedTask.status, JSON.stringify(plannedTask.error)).toBe(
      'completed',
    );
    const scope = reductionPreviewSelectionRequestSchema.parse(
      plannedTask.original_request.scope,
    );
    const declaration = api.runtime.store.artifact(
      scope.selection_ref.id,
      localTaskIdentity,
      scope.selection_ref,
    );
    expect(declaration.content).toEqual(selected);
    const selection = plannedTask.artifacts
      .map(({ artifact }) =>
        api.runtime.store.artifact(artifact.id, localTaskIdentity, artifact),
      )
      .find(
        (artifact) =>
          artifact.kind === 'reduction.input-selection' &&
          artifact.task_id === plannedTask.id,
      )!;
    expect(selection.dependencies).toContainEqual(scope.selection_ref);
    const current = await programme(api, id);
    expect(
      current.attempts.find(({ attempt }) => attempt.id === planning.id)
        ?.preview?.plan?.value.candidate,
    ).toEqual(created.request.candidate);
    const worldScope = { ...localTaskIdentity, mode: 'fixture' as const };
    const record = api.runtime.store.world.lookup(worldScope, {
      kind: 'artifact_reference',
      external_id: `artifact:${declaration.id}:${declaration.version}`,
      limit: 2,
    })[0]!;
    const hold = api.runtime.store.world.hold(
      worldScope,
      record.ref,
      'Operator withdrew the exact selection declaration.',
      'unknown_impact',
    );
    const held = await programme(api, id);
    expect(
      held.attempts.every(
        ({ currency, preview }) => currency === 'stale' && preview === null,
      ),
    ).toBe(true);
    api.runtime.store.world.clearHold(
      worldScope,
      hold.id,
      'Operator reinstated the exact declaration.',
    );
    expect(
      (await programme(api, id)).attempts.every(
        ({ currency }) => currency === 'current',
      ),
    ).toBe(true);

    const other = await createProgramme(api);
    selected = structuredClone(other.request.selection);
    selected.target.intervention = 'An unadmitted alternative';
    const substituted = await start(
      api,
      other.receipt.programme_id,
      'assessment',
    );
    const rejected = await settle(api, substituted.task_id);
    const selector = rejected.assignments.find(
      ({ definition_id }) => definition_id === 'reduction.select',
    );
    expect(selector?.support).toBe('gap');
    expect(selector?.gaps.join(' ')).toContain(
      'Selection conflicts with the current operator-declared',
    );
    expect(
      rejected.artifacts
        .map(({ artifact }) =>
          api.runtime.store.artifact(artifact.id, localTaskIdentity, artifact),
        )
        .some((artifact) =>
          ['reduction.input-selection', 'reduction.assessment'].includes(
            artifact.kind,
          ),
        ),
    ).toBe(false);
  }, 60_000);
  it('retains two exact explicitly started runs, note freshness, material invalidation and restart history', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    expect((await programme(api, id)).attempts).toHaveLength(0);
    const assessment = await start(api, id, 'assessment');
    expect(assessment.reservation).toEqual({ model_calls: 40, tool_calls: 40 });
    expect((await settle(api, assessment.task_id)).status).toBe('completed');
    const predecessor = (await programme(api, id)).attempts.find(
      ({ attempt }) => attempt.id === assessment.id,
    )!.preview!;
    const predecessorRefs = [
      predecessor.assessment!.artifact,
      predecessor.arithmetic_review!.artifact,
    ];
    const planning = await start(api, id, 'planning', assessment.id);
    expect(planning.assessment_attempt_id).toBe(assessment.id);
    expect(planning.run_id).not.toBe(assessment.run_id);
    const planned = await settle(api, planning.task_id);
    expect(
      planned.status,
      JSON.stringify({
        error: planned.error,
        work: planned.assignments.map(
          ({ definition_id, status, error, gaps }) => ({
            definition_id,
            status,
            error,
            gaps,
          }),
        ),
      }),
    ).toBe('completed');
    for (const ref of predecessorRefs) {
      expect(planning.selected_refs).toContainEqual(ref);
      expect(
        planned.original_request.context_refs.some(({ id }) => id === ref.id),
      ).toBe(false);
    }
    const completed = await programme(api, id);
    expect(completed.attempts).toHaveLength(2);
    expect(
      completed.attempts.every(({ currency }) => currency === 'current'),
    ).toBe(true);
    expect(
      completed.attempts.find(({ attempt }) => attempt.id === planning.id)
        ?.preview?.plan_review?.value.verdict,
    ).toBe('supported');
    expect(completed.capacity).toMatchObject({
      reserved_model_calls: 0,
      reserved_tool_calls: 0,
      charged_model_calls: 0,
      charged_tool_calls: 8,
      remaining_runs: 10,
      remaining_attempts: { assessment: 2, planning: 2 },
      active_attempt_id: null,
    });
    const fingerprints = completed.attempts.map(
      ({ attempt }) => attempt.input_fingerprint,
    );
    const note = await api.call(`/api/reduction-programmes/${id}/records`, {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: completed.programme.revision,
      record: {
        kind: 'note',
        text: 'Unrelated administrative note; numerical inputs unchanged.',
      },
    });
    expect(note.status).toBe(200);
    const noted = await programme(api, id);
    expect(noted.attempts.every(({ currency }) => currency === 'current')).toBe(
      true,
    );
    expect(
      noted.attempts.map(({ attempt }) => attempt.input_fingerprint),
    ).toEqual(fingerprints);
    const planningOnly = structuredClone(created.request);
    planningOnly.candidate.costs[0]!.prerequisite =
      'Obtain a new scoped service financing and budget decision.';
    const costRevision = await api.call(
      `/api/reduction-programmes/${id}/revisions`,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: noted.programme.revision,
        reason:
          'Change a planning cost prerequisite without changing the supplied residual quantities or target.',
        preview: planningOnly,
      },
    );
    expect(costRevision.status).toBe(200);
    const replanning = await programme(api, id);
    expect(
      replanning.attempts.find(({ attempt }) => attempt.id === assessment.id)
        ?.currency,
    ).toBe('current');
    expect(
      replanning.attempts.find(({ attempt }) => attempt.id === planning.id)
        ?.currency,
    ).toBe('stale');
    const corrected = structuredClone(created.request);
    corrected.selection.target.target_fraction = '0.15';
    const revision = await api.call(
      `/api/reduction-programmes/${id}/revisions`,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: replanning.programme.revision,
        reason:
          'An explicit operator decision raises the target to fifteen percent.',
        preview: corrected,
      },
    );
    expect(revision.status).toBe(200);
    const changed = await programme(api, id);
    expect(changed.attempts.every(({ currency }) => currency === 'stale')).toBe(
      true,
    );
    expect(
      changed.attempts.every(
        ({ historical_artifact_refs }) => historical_artifact_refs.length > 0,
      ),
    ).toBe(true);
    expect(changed.attempts).toHaveLength(2);
    expect(changed.scientific_qualification).toBe('unqualified');
    expect(changed.achieved_reduction).toBe(false);
    const beforeHistory = await history(api, id);
    expect(
      new Set(beforeHistory.revisions.map(({ revision }) => revision)).size,
    ).toBe(beforeHistory.revisions.length);
    expect(
      beforeHistory.revisions.every(
        ({ revision, previous_revision }) => previous_revision === revision - 1,
      ),
    ).toBe(true);
    await api.restart();
    expect(stable(await programme(api, id))).toEqual(stable(changed));
    expect(await history(api, id)).toEqual(beforeHistory);
    expect(
      api.runtime.store.runResult(
        assessment.task_id,
        assessment.run_id,
        localTaskIdentity,
      ),
    ).toBeDefined();
    expect(
      api.runtime.store.runResult(
        planning.task_id,
        planning.run_id,
        localTaskIdentity,
      ),
    ).toBeDefined();
  }, 40_000);

  it('deduplicates mutations and rejects competing revisions and future record kinds', async () => {
    const api = await setup();
    const fixture = await preview(api);
    const body = {
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title: 'Idempotent programme',
      accountable_owner: 'Local operator',
      scientific_owner: null,
      preview: fixture.request,
    };
    const first = await api.call(
      '/api/reduction-programmes',
      body,
      'programme-create',
    );
    const duplicate = await api.call(
      '/api/reduction-programmes',
      body,
      'programme-create',
    );
    expect(duplicate.body).toEqual(first.body);
    expect(
      (
        await api.call(
          '/api/reduction-programmes',
          { ...body, title: 'Different input under the same key' },
          'programme-create',
        )
      ).status,
    ).toBe(409);
    const receipt = reductionProgrammeMutationReceiptSchema.parse(first.body);
    const revision = {
      schema_version: 'haze.reduction.programme.revise.v1',
      expected_revision: receipt.revision,
      reason: 'Concurrent metadata edit.',
    };
    const competing = await Promise.all([
      api.call(`/api/reduction-programmes/${receipt.programme_id}/revisions`, {
        ...revision,
        title: 'Edit one',
      }),
      api.call(`/api/reduction-programmes/${receipt.programme_id}/revisions`, {
        ...revision,
        title: 'Edit two',
      }),
    ]);
    expect(competing.map(({ status }) => status).sort()).toEqual([200, 409]);
    const current = await programme(api, receipt.programme_id);
    expect(current.programme.revision).toBe(receipt.revision + 1);
    expect(
      (
        await api.call(
          `/api/reduction-programmes/${receipt.programme_id}/records`,
          {
            schema_version: 'haze.reduction.programme.record-request.v1',
            expected_revision: current.programme.revision,
            record: { kind: 'delivery', delivered: true },
          },
        )
      ).status,
    ).toBe(400);
    expect((await programme(api, receipt.programme_id)).attempts).toHaveLength(
      0,
    );
    const list = reductionProgrammeListSchema.parse(
      (await api.call('/api/reduction-programmes')).body,
    );
    expect(list.programmes).toHaveLength(1);
  });

  it('partitions saved programmes by execution mode and preserves the existing fixture history', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const before = await history(api, created.receipt.programme_id);
    await api.restart('live');
    expect(
      reductionProgrammeListSchema.parse(
        (await api.call('/api/reduction-programmes')).body,
      ).programmes,
    ).toHaveLength(0);
    expect(
      (
        await api.call(
          `/api/reduction-programmes/${created.receipt.programme_id}`,
        )
      ).status,
    ).toBe(404);
    await api.restart('fixture');
    expect(await history(api, created.receipt.programme_id)).toEqual(before);
    const spoof = await api.call('/api/reduction-programmes', {
      ...created.input,
      principal: 'another-user',
    });
    expect(spoof.status).toBe(400);
  });

  it('reserves admitted maxima and reconciles only unused terminal calls before permitting another run', async () => {
    const api = await setup();
    const created = await createProgramme(api, {
      max_model_calls: 40,
      max_tool_calls: 40,
      max_runs: 2,
      max_attempts_per_phase: 3,
    });
    const id = created.receipt.programme_id;
    const assessment = await start(api, id, 'assessment');
    await settle(api, assessment.task_id);
    const settled = await programme(api, id);
    expect(settled.capacity).toMatchObject({
      charged_model_calls: 0,
      charged_tool_calls: 3,
      reserved_model_calls: 0,
      reserved_tool_calls: 0,
      remaining_model_calls: 40,
      remaining_tool_calls: 37,
    });
    const blocked = await api.call(`/api/reduction-programmes/${id}/phases`, {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: settled.programme.revision,
      phase: 'planning',
      assessment_attempt_id: assessment.id,
    });
    expect(blocked.status).toBe(409);
    expect((await programme(api, id)).attempts).toHaveLength(1);
    const revised = await api.call(
      `/api/reduction-programmes/${id}/revisions`,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: settled.programme.revision,
        reason: 'Explicitly raise the bounded programme allowance.',
        budget: {
          max_model_calls: 80,
          max_tool_calls: 80,
          max_runs: 2,
          max_attempts_per_phase: 3,
        },
      },
    );
    expect(revised.status).toBe(200);
    const planning = await start(api, id, 'planning', assessment.id);
    await settle(api, planning.task_id);
    const exhausted = await programme(api, id);
    expect(exhausted.capacity).toMatchObject({
      charged_tool_calls: 8,
      reserved_tool_calls: 0,
      remaining_runs: 0,
    });
    expect(
      (
        await api.call(`/api/reduction-programmes/${id}/phases`, {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: exhausted.programme.revision,
          phase: 'assessment',
        })
      ).status,
    ).toBe(409);
    const task = api.runtime.store.read(planning.task_id, localTaskIdentity);
    const direct = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'continue',
    });
    expect([403, 409]).toContain(direct.status);
    const coordinated = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'continue',
      coordination: {
        owner_id: id,
        expected_revision: exhausted.programme.revision,
      },
    });
    expect([403, 409, 422]).toContain(coordinated.status);
    expect(
      api.runtime.store.read(task.id, localTaskIdentity).current_run_id,
    ).toBe(task.current_run_id);
    const changedPreview = structuredClone(created.request);
    changedPreview.selection.target.target_fraction = '0.2';
    const update = {
      schema_version: 'haze.task.update.v3',
      ...fence(task),
      kind: 'correction',
      passage:
        'Change the programme-bound target using the generic task endpoint.',
      scope: changedPreview,
      affected_assignment_ids: task.assignments
        .filter(({ role }) => role !== 'Manager')
        .map(({ id }) => id),
    };
    expect([403, 409]).toContain(
      (await api.call(`/api/tasks/${task.id}/updates`, update)).status,
    );
    expect([403, 409, 422]).toContain(
      (
        await api.call(`/api/tasks/${task.id}/updates`, {
          ...update,
          coordination: {
            owner_id: id,
            expected_revision: exhausted.programme.revision,
          },
        })
      ).status,
    );
    expect(
      api.runtime.store.read(task.id, localTaskIdentity).objective_revision,
    ).toBe(task.objective_revision);
    expect((await programme(api, id)).attempts).toHaveLength(2);
  }, 40_000);

  it('rechecks exact source holds and access without a programme revision', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    const attempt = await start(api, id, 'assessment');
    await settle(api, attempt.task_id);
    const before = await programme(api, id);
    expect(before.attempts[0]?.currency).toBe('current');
    const scope = { ...localTaskIdentity, mode: 'fixture' as const };
    const source = api.runtime.store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${created.source.id}:${created.source.version}`,
      limit: 2,
    })[0]!;
    const hold = api.runtime.store.world.hold(
      scope,
      source.ref,
      'Source applicability requires renewed scientific review.',
      'unknown_impact',
    );
    const held = await programme(api, id);
    expect(held.programme.revision).toBe(before.programme.revision);
    expect(held.attempts[0]?.currency).toBe('stale');
    api.runtime.store.world.clearHold(
      scope,
      hold.id,
      'The source was reinstated for the exact stated use.',
    );
    expect((await programme(api, id)).attempts[0]?.currency).toBe('current');
    api.runtime.store.recordApplicability(
      attempt.task_id,
      localTaskIdentity,
      created.source,
      false,
      'Exact source withdrawn from this task scope.',
      'Runtime',
    );
    expect((await programme(api, id)).attempts[0]?.currency).toBe('stale');
    api.runtime.store.recordApplicability(
      attempt.task_id,
      localTaskIdentity,
      created.source,
      true,
      'Explicit source review reinstated applicability.',
      'Runtime',
    );
    const task = api.runtime.store.read(attempt.task_id, localTaskIdentity);
    const revoked = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'revoke',
      revoked_tools: ['reduction.imported-residual-comparison.v1'],
    });
    expect(revoked.status).toBe(200);
    expect((await programme(api, id)).attempts[0]?.currency).toBe('stale');
  });

  it('rolls back nested task admission and discards dispatch on outer failure', async () => {
    const dispatched: string[] = [];
    const api = await setup({
      dispatchTask: (id, dispatch) => {
        dispatched.push(id);
        dispatch();
      },
    });
    const fixture = await preview(api);
    const request = {
      schema_version: 'haze.task.request.v3',
      objective:
        'Assess damage reduction using the selected supplied quantities.',
      scope: fixture.request.selection,
      context_refs: [fixture.source],
    };
    let rolledBackId = '';
    expect(() =>
      api.runtime.store.transaction(() => {
        rolledBackId = api.runtime.admit(request, 'rollback-task').task_id;
        throw new Error('Injected failure before outer commit.');
      }),
    ).toThrow('Injected failure');
    expect(dispatched).toHaveLength(0);
    expect(() =>
      api.runtime.store.read(rolledBackId, localTaskIdentity),
    ).toThrow();
    const actual = api.runtime.admit(request, 'rollback-task');
    expect(actual.task_id).not.toBe(rolledBackId);
    await settle(api, actual.task_id);
    expect(dispatched).toEqual([actual.task_id]);
  });

  it('rolls back a programme phase, task, binding, reservation and operation receipt as one transaction', async () => {
    const dispatched: string[] = [];
    const api = await setup({
      dispatchTask: (id, dispatch) => {
        dispatched.push(id);
        dispatch();
      },
    });
    const created = await createProgramme(api);
    const service = programmeService(api);
    const id = created.receipt.programme_id;
    const input = {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: created.receipt.revision,
      phase: 'assessment',
    };
    let rolledBackTask = '';
    expect(() =>
      api.runtime.store.transaction(() => {
        const receipt = service.startPhase(
          id,
          input,
          'whole-phase-rollback',
          localTaskIdentity,
        );
        rolledBackTask = receipt.attempt!.task_id;
        throw new Error('Injected partial programme admission failure.');
      }),
    ).toThrow('Injected partial programme admission failure');
    expect(dispatched).toHaveLength(0);
    expect(() =>
      api.runtime.store.read(rolledBackTask, localTaskIdentity),
    ).toThrow();
    const unchanged = await programme(api, id);
    expect(unchanged.programme.revision).toBe(created.receipt.revision);
    expect(unchanged.attempts).toHaveLength(0);
    expect(unchanged.capacity).toMatchObject({
      reserved_model_calls: 0,
      reserved_tool_calls: 0,
      remaining_runs: 12,
    });
    const receipt = service.startPhase(
      id,
      input,
      'whole-phase-rollback',
      localTaskIdentity,
    );
    expect(receipt.attempt!.task_id).not.toBe(rolledBackTask);
    await settle(api, receipt.attempt!.task_id);
    expect(dispatched).toEqual([receipt.attempt!.task_id]);
    expect((await programme(api, id)).attempts).toHaveLength(1);
  });

  it('isolates direct programme access by both principal and workspace', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const service = programmeService(api);
    for (const identity of [
      { ...localTaskIdentity, principal: 'different-principal' },
      { ...localTaskIdentity, workspace: 'different-workspace' },
    ]) {
      expect(() =>
        service.read(created.receipt.programme_id, identity),
      ).toThrow();
      expect(service.list(identity).programmes).toHaveLength(0);
      expect(() =>
        service.history(created.receipt.programme_id, identity),
      ).toThrow();
      expect(() =>
        service.appendRecord(
          created.receipt.programme_id,
          {
            schema_version: 'haze.reduction.programme.record-request.v1',
            expected_revision: created.receipt.revision,
            record: {
              kind: 'note',
              text: 'Unauthorized cross-partition mutation.',
            },
          },
          randomUUID(),
          identity,
        ),
      ).toThrow();
    }
    expect(
      (await programme(api, created.receipt.programme_id)).programme.revision,
    ).toBe(created.receipt.revision);
  });

  it('preserves committed queued phase admission after dispatch failure and recovers the exact receipt on restart', async () => {
    const api = await setup({
      dispatchTask: () => {
        throw new Error('Injected committed dispatch failure.');
      },
    });
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    const input = {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: created.receipt.revision,
      phase: 'assessment',
    };
    const response = await api.call(
      `/api/reduction-programmes/${id}/phases`,
      input,
      'dispatch-failure-phase',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const receipt = reductionProgrammeMutationReceiptSchema.parse(
      response.body,
    );
    const attempt = receipt.attempt!;
    expect(
      api.runtime.store.read(attempt.task_id, localTaskIdentity).status,
    ).toBe('queued');
    expect(
      (
        await api.call(
          `/api/reduction-programmes/${id}/phases`,
          input,
          'dispatch-failure-phase',
        )
      ).body,
    ).toEqual(receipt);
    expect((await programme(api, id)).attempts).toHaveLength(1);
    await api.restart();
    expect((await settle(api, attempt.task_id)).status).toBe('completed');
    expect(
      (
        await api.call(
          `/api/reduction-programmes/${id}/phases`,
          input,
          'dispatch-failure-phase',
        )
      ).body,
    ).toEqual(receipt);
    const recovered = await programme(api, id);
    expect(recovered.attempts).toHaveLength(1);
    expect(recovered.attempts[0]?.attempt.run_id).toBe(attempt.run_id);
    expect(recovered.capacity.charged_tool_calls).toBe(3);
    expect(recovered.capacity.reserved_tool_calls).toBe(0);
  }, 40_000);

  it('counts cancellation as an attempt, rejects overlapping phases, fences late output and enforces three attempts', async () => {
    let release = () => {};
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    let issued = false;
    let lateReturned = false;
    const api = await setup({
      configureRegistry: (registry) => {
        const tool = registry.tools.get(
          'reduction.imported-residual-comparison.v1',
        )!;
        registry.tools.set(tool.id, {
          ...tool,
          execute: async (input, context) => {
            if (!issued) {
              issued = true;
              await barrier;
              lateReturned = true;
            }
            return tool.execute(input, context);
          },
        });
      },
    });
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    const first = await start(api, id, 'assessment');
    await expect.poll(() => issued, { timeout: 20_000 }).toBe(true);
    const active = await programme(api, id);
    expect(active.capacity.active_attempt_id).toBe(first.id);
    expect(
      (
        await api.call(`/api/reduction-programmes/${id}/phases`, {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: active.programme.revision,
          phase: 'assessment',
        })
      ).status,
    ).toBe(409);
    const task = api.runtime.store.read(first.task_id, localTaskIdentity);
    const cancelled = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'cancel',
      coordination: {
        owner_id: id,
        expected_revision: active.programme.revision,
      },
      reason: 'Operator cancels the still-running supplied calculation.',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    release();
    await expect.poll(() => lateReturned, { timeout: 10_000 }).toBe(true);
    const stopped = await settle(api, first.task_id);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.usage.tool_calls).toBe(2);
    expect(
      stopped.artifacts.some(
        ({ artifact }) =>
          api.runtime.store.artifact(artifact.id, localTaskIdentity).kind ===
          'reduction.assessment',
      ),
    ).toBe(false);
    const reconciled = await programme(api, id);
    expect(reconciled.capacity).toMatchObject({
      charged_tool_calls: 2,
      reserved_tool_calls: 0,
      remaining_attempts: { assessment: 2, planning: 3 },
    });
    expect(reconciled.attempts).toHaveLength(1);
    expect(reconciled.attempts[0]?.execution_status).toBe('cancelled');
    expect(reconciled.attempts[0]?.result_status).not.toBe('available');
    const second = await start(api, id, 'assessment');
    await settle(api, second.task_id);
    const third = await start(api, id, 'assessment');
    await settle(api, third.task_id);
    const exhausted = await programme(api, id);
    expect(exhausted.capacity.remaining_attempts.assessment).toBe(0);
    expect(exhausted.attempts).toHaveLength(3);
    expect(
      (
        await api.call(`/api/reduction-programmes/${id}/phases`, {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: exhausted.programme.revision,
          phase: 'assessment',
        })
      ).status,
    ).toBe(409);
  }, 40_000);

  it('keeps an attached standalone preview historical and never follows its later current run', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const standalone = api.runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Prepare a conditional damage reduction planning preview.',
        scope: created.request,
        context_refs: [created.source],
      },
      'historical-standalone',
    );
    const first = await settle(api, standalone.task_id);
    expect(first.status).toBe('completed');
    const product = first.artifacts
      .map(({ artifact }) =>
        api.runtime.store.artifact(artifact.id, localTaskIdentity),
      )
      .find(({ kind }) => kind === 'reduction.conditional-plan')!;
    const record = await api.call(
      `/api/reduction-programmes/${created.receipt.programme_id}/records`,
      {
        schema_version: 'haze.reduction.programme.record-request.v1',
        expected_revision: created.receipt.revision,
        record: {
          kind: 'attachment',
          artifact: exactReductionRef(product),
          description:
            'Exact previously saved standalone preview, attached only as historical context.',
        },
      },
    );
    expect(record.status).toBe(200);
    const attached = await programme(api, created.receipt.programme_id);
    expect(attached.records[0]?.task_binding?.run_id).toBe(
      first.current_run_id,
    );
    expect(attached.records[0]?.applicability).toBe('historical_context');
    expect(attached.attempts).toHaveLength(0);
    expect(attached.capacity.remaining_runs).toBe(12);
    const oldResult = api.runtime.store.runResult(
      first.id,
      first.current_run_id,
      localTaskIdentity,
    );
    expect(oldResult).toEqual(first.result);
    api.runtime.control(
      first.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(first),
        action: 'continue',
      },
      'continue-standalone',
    );
    const second = await settle(api, first.id);
    expect(second.current_run_id).not.toBe(first.current_run_id);
    expect(
      api.runtime.store.runResult(
        first.id,
        first.current_run_id,
        localTaskIdentity,
      ),
    ).toEqual(oldResult);
    const historical = await programme(api, created.receipt.programme_id);
    expect(historical.records[0]?.task_binding?.run_id).toBe(
      first.current_run_id,
    );
    expect(historical.records[0]?.record).toEqual(attached.records[0]?.record);
    expect(historical.attempts).toHaveLength(0);
  }, 40_000);

  it('retains charged unknown remote attempts and requires an explicit operator action', async () => {
    const api = await setup({
      configureRegistry: (registry) => {
        const tool = registry.tools.get(
          'reduction.imported-residual-comparison.v1',
        )!;
        registry.tools.set(tool.id, {
          ...tool,
          execute: () =>
            Promise.reject(
              Object.assign(
                new Error(
                  'Supplied comparison transport closed before a receipt; outcome unknown.',
                ),
                { outcome: 'unknown' as const },
              ),
            ),
        });
      },
    });
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    const attempt = await start(api, id, 'assessment');
    const paused = await settle(api, attempt.task_id);
    expect(paused.status).toBe('paused');
    expect(paused.usage.tool_calls).toBe(2);
    const pending = await programme(api, id);
    expect(pending.attempts).toHaveLength(1);
    expect(pending.capacity.active_attempt_id).toBe(attempt.id);
    expect(
      (
        await api.call(`/api/reduction-programmes/${id}/phases`, {
          schema_version: 'haze.reduction.programme.phase.v1',
          expected_revision: pending.programme.revision,
          phase: 'assessment',
        })
      ).status,
    ).toBe(409);
    const cancelled = await api.call(`/api/tasks/${paused.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(paused),
      action: 'cancel',
      coordination: {
        owner_id: id,
        expected_revision: pending.programme.revision,
      },
      reason:
        'Operator cancels the unknown-outcome run; charged attempts remain charged.',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const retained = await programme(api, id);
    expect(retained.attempts).toHaveLength(1);
    expect(retained.capacity).toMatchObject({
      charged_tool_calls: 2,
      reserved_tool_calls: 0,
      remaining_runs: 11,
      active_attempt_id: null,
    });
    expect(
      api.runtime.store.read(paused.id, localTaskIdentity).usage.tool_calls,
    ).toBe(2);
  });

  it('binds an explicitly coordinated Continue to its new exact run while retaining the old run result', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const id = created.receipt.programme_id;
    const firstAttempt = await start(api, id, 'assessment');
    const firstTask = await settle(api, firstAttempt.task_id);
    const originalResult = api.runtime.store.runResult(
      firstTask.id,
      firstAttempt.run_id,
      localTaskIdentity,
    );
    const before = await programme(api, id);
    const response = await api.call(`/api/tasks/${firstTask.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(firstTask),
      action: 'continue',
      coordination: {
        owner_id: id,
        expected_revision: before.programme.revision,
      },
      reason:
        'Explicitly admit a bounded replacement run under the programme reservation and attempt guards.',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const successor = await settle(api, firstTask.id);
    expect(successor.status, JSON.stringify(successor.error)).toBe('completed');
    expect(successor.current_run_id).not.toBe(firstAttempt.run_id);
    expect(
      api.runtime.store.runResult(
        firstTask.id,
        firstAttempt.run_id,
        localTaskIdentity,
      ),
    ).toEqual(originalResult);
    const after = await programme(api, id);
    expect(after.attempts).toHaveLength(2);
    const old = after.attempts.find(
      ({ attempt }) => attempt.id === firstAttempt.id,
    )!;
    const replacement = after.attempts.find(
      ({ attempt }) => attempt.run_id === successor.current_run_id,
    )!;
    expect(old.attempt.run_id).toBe(firstAttempt.run_id);
    expect(old.execution_status).toBe('completed');
    expect(old.currency).toBe('historical');
    expect(old.preview).toBeNull();
    expect(old.historical_artifact_refs.length).toBeGreaterThan(0);
    expect(replacement.attempt.task_id).toBe(firstTask.id);
    expect(replacement.currency, JSON.stringify(replacement.reasons)).toBe(
      'current',
    );
    expect(replacement.preview?.claims?.point_estimate_label).toBe('meets');
    expect(after.capacity).toMatchObject({
      charged_tool_calls: 6,
      reserved_tool_calls: 0,
      remaining_runs: 10,
      remaining_attempts: { assessment: 1, planning: 3 },
    });
    const { selection_ref: declaration } =
      reductionSelectionRequestSchema.parse(successor.original_request.scope);
    expect(
      successor.artifacts.some(
        ({ artifact, current }) =>
          current &&
          artifact.id === declaration.id &&
          artifact.version === declaration.version &&
          artifact.sha256 === declaration.sha256,
      ),
    ).toBe(true);
    await api.restart();
    expect(
      (await programme(api, id)).attempts.find(
        ({ attempt }) => attempt.run_id === successor.current_run_id,
      )?.currency,
    ).toBe('current');
    const worldScope = { ...localTaskIdentity, mode: 'fixture' as const };
    const worldRecord = api.runtime.store.world.lookup(worldScope, {
      kind: 'artifact_reference',
      external_id: `artifact:${declaration.id}:${declaration.version}`,
      limit: 2,
    })[0]!;
    const hold = api.runtime.store.world.hold(
      worldScope,
      worldRecord.ref,
      'Withdraw the exact selection declaration after Continue.',
      'unknown_impact',
    );
    const held = await programme(api, id);
    expect(
      held.attempts.find(
        ({ attempt }) => attempt.run_id === successor.current_run_id,
      ),
    ).toMatchObject({ currency: 'stale', preview: null });
    const blocked = await api.call(`/api/tasks/${successor.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(api.runtime.store.read(successor.id, localTaskIdentity)),
      action: 'continue',
      coordination: {
        owner_id: id,
        expected_revision: held.programme.revision,
      },
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    api.runtime.store.world.clearHold(
      worldScope,
      hold.id,
      'Reinstate the same admitted declaration.',
    );
    expect(
      (await programme(api, id)).attempts.find(
        ({ attempt }) => attempt.run_id === successor.current_run_id,
      )?.currency,
    ).toBe('current');
  });

  it('releases the state owner and database when an extension factory fails during construction', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'haze-programme-constructor-failure-'),
    );
    const registry = createExecutionRegistry({ mode: 'fixture' });
    registry.registerExtension(() => {
      throw new Error('Injected programme extension factory failure.');
    });
    expect(
      () =>
        new TaskRuntime({
          stateDirectory: directory,
          mode: 'fixture',
          registry,
          env: {},
        }),
    ).toThrow('Injected programme extension factory failure');
    const reopened = new TaskRuntime({
      stateDirectory: directory,
      mode: 'fixture',
      registry: createExecutionRegistry({ mode: 'fixture' }),
      env: {},
    });
    cleanups.push(async () => {
      await reopened.close();
      await rm(directory, { recursive: true, force: true });
    });
    expect(reopened.extension('reduction-programmes')).toBeDefined();
  });

  it('enforces method, query and idempotency boundaries on the composition-provided programme routes', async () => {
    const api = await setup();
    const created = await createProgramme(api);
    const path = `/api/reduction-programmes/${created.receipt.programme_id}`;
    expect(
      (
        await fetch(api.origin + path, {
          method: 'PUT',
          headers: { Origin: api.origin, Connection: 'close' },
        })
      ).status,
    ).toBe(405);
    expect((await api.call(`${path}?bogus=true`)).status).toBe(400);
    expect((await api.call('/api/reduction-programmes?limit=101')).status).toBe(
      400,
    );
    expect(
      (await api.call('/api/reduction-programmes?limit=1&limit=2')).status,
    ).toBe(400);
    expect(
      (
        await fetch(api.origin + '/api/reduction-programmes', {
          method: 'POST',
          headers: {
            Origin: api.origin,
            Connection: 'close',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(created.input),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(api.origin + path, {
          headers: { Origin: 'https://untrusted.example', Connection: 'close' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await programme(api, created.receipt.programme_id)).programme.revision,
    ).toBe(created.receipt.revision);
  });

  it('rechecks a generated candidate source independent review even though it is not an ordinary source dependency', async () => {
    let withholdDispatch = false;
    const withheldTasks = new Set<string>();
    const api = await setup({
      dispatchTask: (taskId, dispatch) => {
        if (withholdDispatch) withheldTasks.add(taskId);
        else dispatch();
      },
    });
    const upstream = await preview(api);
    const admission = api.runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Assess damage reduction from the exact supplied residual quantities.',
        scope: upstream.request.selection,
        context_refs: [upstream.source],
      },
      'upstream-reviewed-preview',
    );
    const taskA = await settle(api, admission.task_id);
    expect(taskA.status, JSON.stringify(taskA.error)).toBe('completed');
    const upstreamArtifacts = taskA.artifacts.map(({ artifact }) =>
      api.runtime.store.artifact(artifact.id, localTaskIdentity),
    );
    const sourceProduct = upstreamArtifacts.find(
      ({ kind }) => kind === 'reduction.assessment',
    )!;
    const review = upstreamArtifacts.find(
      ({ kind }) => kind === 'reduction.review',
    )!;
    expect(sourceProduct.dependencies.some(({ id }) => id === review.id)).toBe(
      false,
    );
    const downstream = await preview(api);
    downstream.request.candidate.claims = [
      {
        id: 'previous-scenario-inputs',
        kind: 'mechanism',
        statement:
          'A previous point-estimate assessment records supplied quantities for the proposed scenario.',
        evidence: [exactReductionRef(sourceProduct)],
      },
    ];
    const create = await api.call('/api/reduction-programmes', {
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title: 'Programme using an exact reviewed scenario source',
      accountable_owner: 'Local operator',
      scientific_owner: null,
      preview: downstream.request,
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const id = reductionProgrammeMutationReceiptSchema.parse(
      create.body,
    ).programme_id;
    const assessment = await start(api, id, 'assessment');
    expect((await settle(api, assessment.task_id)).status).toBe('completed');
    const assessed = await programme(api, id);
    withholdDispatch = true;
    const admitted = programmeService(api).startPhase(
      id,
      {
        schema_version: 'haze.reduction.programme.phase.v1',
        expected_revision: assessed.programme.revision,
        phase: 'planning',
        assessment_attempt_id: assessment.id,
      },
      'review-guard-pending-phase',
      localTaskIdentity,
    );
    const planning = admitted.attempt!;
    expect(withheldTasks.has(planning.task_id)).toBe(true);
    const queued = api.runtime.store.read(planning.task_id, localTaskIdentity);
    expect(queued.status).toBe('queued');
    api.runtime.control(
      queued.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(queued),
        action: 'pause',
        coordination: { owner_id: id, expected_revision: admitted.revision },
        reason:
          'Keep this admission-only source-freshness check paused before graph dispatch.',
      },
      'pause-review-guard-phase',
    );
    const before = await programme(api, id);
    expect(
      before.attempts.find(({ attempt }) => attempt.id === planning.id)
        ?.currency,
    ).toBe('current');
    expect(
      before.attempts.find(({ attempt }) => attempt.id === planning.id)
        ?.result_status,
    ).toBe('pending');
    const scope = { ...localTaskIdentity, mode: 'fixture' as const };
    const reviewRecord = api.runtime.store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${review.id}:${review.version}`,
      limit: 2,
    })[0]!;
    const hold = api.runtime.store.world.hold(
      scope,
      reviewRecord.ref,
      'The upstream independent arithmetic review has been withdrawn pending review.',
      'unknown_impact',
    );
    const held = await programme(api, id);
    expect(held.programme.revision).toBe(before.programme.revision);
    expect(
      held.attempts.find(({ attempt }) => attempt.id === assessment.id)
        ?.currency,
    ).toBe('current');
    expect(
      held.attempts.find(({ attempt }) => attempt.id === planning.id)?.currency,
    ).toBe('stale');
    expect(
      held.attempts.find(({ attempt }) => attempt.id === planning.id)?.preview,
    ).toBeNull();
    expect(
      api.runtime.store.artifact(sourceProduct.id, localTaskIdentity),
    ).toEqual(sourceProduct);
    const paused = api.runtime.store.read(planning.task_id, localTaskIdentity);
    api.runtime.control(
      paused.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(paused),
        action: 'cancel',
        coordination: {
          owner_id: id,
          expected_revision: held.programme.revision,
        },
      },
      'cancel-held-source-phase',
    );
    const cancelled = await programme(api, id);
    expect(cancelled.capacity.active_attempt_id).toBeNull();
    const rejected = await api.call(`/api/reduction-programmes/${id}/phases`, {
      schema_version: 'haze.reduction.programme.phase.v1',
      expected_revision: cancelled.programme.revision,
      phase: 'planning',
      assessment_attempt_id: assessment.id,
    });
    expect([409, 422]).toContain(rejected.status);
    expect(JSON.stringify(rejected.body)).toMatch(
      /review|held|source|evidence/i,
    );
    expect((await programme(api, id)).attempts).toHaveLength(2);
    api.runtime.store.world.clearHold(
      scope,
      hold.id,
      'The independent source review was explicitly reinstated.',
    );
    const cleared = await programme(api, id);
    const restored = programmeService(api).startPhase(
      id,
      {
        schema_version: 'haze.reduction.programme.phase.v1',
        expected_revision: cleared.programme.revision,
        phase: 'planning',
        assessment_attempt_id: assessment.id,
      },
      'review-guard-restored-phase',
      localTaskIdentity,
    );
    const restoredTask = api.runtime.store.read(
      restored.attempt!.task_id,
      localTaskIdentity,
    );
    api.runtime.control(
      restoredTask.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(restoredTask),
        action: 'pause',
        coordination: { owner_id: id, expected_revision: restored.revision },
      },
      'pause-restored-source-phase',
    );
    const reinstated = await programme(api, id);
    expect(reinstated.attempts).toHaveLength(3);
    expect(
      reinstated.attempts.find(
        ({ attempt }) => attempt.id === restored.attempt!.id,
      )?.currency,
    ).toBe('current');
  }, 40_000);
});
