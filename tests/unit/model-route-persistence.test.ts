import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type { TaskControl } from '../../app/contracts/controls.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import { TaskStore } from '../../app/tasks/store.js';
import type { ModelRouteSnapshot } from '../../app/contracts/model-routes.js';
import { scriptedAgentModel } from './scripted-model.js';
import { fixtureDecision } from '../../app/agents/manager/fixture.js';
import type { ModelRouteService } from '../../app/orchestration/model-service.js';

const directories: string[] = [];
const stores: TaskStore[] = [];
const runtimes: TaskRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  for (const store of stores.splice(0).reverse())
    if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup target.');
    rmSync(directory, { recursive: true, force: true });
  }
});
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'haze-model-routes-'));
  directories.push(value);
  return value;
}
function open(path = directory()) {
  const store = new TaskStore(path);
  stores.push(store);
  return store;
}
function snapshot(model = 'specialist-a') {
  return new ModelRouteRegistry({
    HAZE_PROVIDER: 'nvidia',
    HAZE_MODEL: 'manager-a',
    HAZE_MODEL_ROUTES_JSON: JSON.stringify({
      version: 1,
      profiles: {
        specialist: {
          provider: 'openai-compatible',
          model,
          base_url: 'http://localhost:9876/v1',
          credential_env: 'TEST_ROUTE_KEY',
        },
      },
    }),
    HAZE_AGENT_ROUTES_JSON: JSON.stringify({
      version: 1,
      routes: {
        HazeOps: 'specialist',
        WorkerShield: 'specialist',
        EvidenceCritic: 'specialist',
        DamageAccountant: 'specialist',
      },
    }),
  }).snapshot();
}
function admit(
  store: TaskStore,
  routeSnapshot: ModelRouteSnapshot,
  key = 'admit',
) {
  return store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Explain the notes.',
    }),
    localTaskIdentity,
    key,
    { routeSnapshot },
  ).task;
}
function control(
  store: TaskStore,
  task: TaskRecord,
  action: TaskControl['action'],
  routeSnapshot?: ModelRouteSnapshot,
) {
  return store.control(
    task.id,
    localTaskIdentity,
    `${action}-${task.generation}`,
    {
      schema_version: 'haze.task.control.v3',
      action,
      expected_run_id: task.current_run_id,
      expected_generation: task.generation,
      expected_objective_revision: task.objective_revision,
      expected_state_revision: task.state_revision,
    },
    routeSnapshot,
  );
}
function assign(
  store: TaskStore,
  task: TaskRecord,
  role:
    | 'Manager'
    | 'HazeOps'
    | 'WorkerShield'
    | 'EvidenceCritic'
    | 'DamageAccountant',
) {
  return store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role,
        definition_id: `test.${role}`,
        capability: 'test',
        definition_version: '1',
        brief: 'Use the admitted route.',
      },
    ],
  )[0]!;
}

async function untilTask(
  runtime: TaskRuntime,
  id: string,
  accept: (task: TaskRecord) => boolean,
) {
  const deadline = Date.now() + 10_000;
  let task = runtime.store.read(id, localTaskIdentity);
  while (!accept(task) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    task = runtime.store.read(id, localTaskIdentity);
  }
  expect(
    accept(task),
    `Task ${task.status}: ${task.error?.message ?? ''}`,
  ).toBe(true);
  return task;
}

function routeService(prepare: NonNullable<ModelRouteService['prepare']>) {
  return {
    snapshot: () => snapshot(),
    resolve: vi.fn(() => {
      throw new Error('A strict route requires asynchronous preflight.');
    }),
    prepare,
    readiness: () =>
      Promise.resolve({
        version: 1,
        checked_at: new Date().toISOString(),
        routes: [],
      }),
  } satisfies ModelRouteService;
}

function mutationExpectation(task: TaskRecord) {
  return {
    expected_run_id: task.current_run_id,
    expected_generation: task.generation,
    expected_objective_revision: task.objective_revision,
    expected_state_revision: task.state_revision,
  };
}

describe('immutable model route authority', () => {
  it('selects pinned Manager and specialist routes through the model service boundary', async () => {
    const pinned = snapshot();
    const selected: { role: string; route_id: string }[] = [];
    const scripted = scriptedAgentModel();
    const registry = createExecutionRegistry({ mode: 'fixture' });
    // This fixture exercises model routing for every specialist. Production
    // PM2.5 executors are deterministic, so only this isolated registry uses
    // their scripted model path instead of the registered execution hooks.
    for (const id of ['pm25.retrieve', 'pm25.analyze', 'pm25.check']) {
      const definition = { ...registry.definitions.get(id)! };
      delete definition.execute;
      registry.definitions.set(id, definition);
    }
    // Synthetic sources keep this routing integration test isolated from live evidence.
    for (const [id, tool] of registry.tools)
      registry.tools.set(id, { ...tool, mode: 'live' });
    const runtime = new TaskRuntime({
      stateDirectory: directory(),
      registry,
      mode: 'live',
      env: {},
      modelRoutes: {
        snapshot: () => pinned,
        resolve: (route) => ({
          selection: {
            provider: 'synthetic-route-test',
            model: route.requested_model!,
          },
          complete: async (input, signal) => {
            selected.push({ role: input.role, route_id: route.route_id });
            return input.role === 'Manager' &&
              (input.context as { purpose?: string }).purpose === 'decision'
              ? JSON.stringify(
                  fixtureDecision(
                    input.context as Parameters<typeof fixtureDecision>[0],
                  ),
                )
              : scripted.complete(input, signal);
          },
        }),
        readiness: () =>
          Promise.resolve({
            version: 1,
            checked_at: new Date().toISOString(),
            routes: [],
          }),
      },
    });
    runtimes.push(runtime);
    const admission = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Investigate PM2.5.',
        scope: {
          location: 'Kuala Lumpur',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
      },
      'mixed-service',
    );
    let task = runtime.store.read(admission.task_id, localTaskIdentity);
    const deadline = Date.now() + 20_000;
    while (
      !['failed', 'completed', 'paused', 'timed_out'].includes(task.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = runtime.store.read(task.id, localTaskIdentity);
    }
    expect(task.status, task.error?.message).toBe('completed');
    expect(
      selected.some(
        (call) =>
          call.role === 'Manager' &&
          call.route_id === pinned.routes.Manager.route_id,
      ),
    ).toBe(true);
    expect(
      selected.some(
        (call) =>
          call.role === 'HazeOps' &&
          call.route_id === pinned.routes.HazeOps.route_id,
      ),
    ).toBe(true);
    expect(
      selected.some(
        (call) =>
          call.role === 'WorkerShield' &&
          call.route_id === pinned.routes.WorkerShield.route_id,
      ),
    ).toBe(true);
    expect(
      selected.some(
        (call) =>
          call.role === 'EvidenceCritic' &&
          call.route_id === pinned.routes.EvidenceCritic.route_id,
      ),
    ).toBe(true);
    for (const assignment of task.assignments)
      expect(runtime.store.modelRoutes.assignmentRoute(assignment)).toEqual(
        pinned.routes[assignment.role],
      );
  });
  it('pins mixed roles across repeated restart, late assignment, resume and explicit successor admission', () => {
    const original = snapshot();
    let store = open();
    const path = store.directory;
    const task = admit(store, original);
    const first = assign(store, task, 'Manager');
    expect(store.modelRoutes.assignmentRoute(first)).toEqual(
      original.routes.Manager,
    );
    expect(() =>
      store.db
        .prepare('UPDATE run_model_routes SET body=? WHERE run_id=?')
        .run('{}', task.current_run_id),
    ).toThrow('immutable');
    expect(() =>
      store.db
        .prepare('DELETE FROM run_model_routes WHERE run_id=?')
        .run(task.current_run_id),
    ).toThrow('immutable');
    const changed = snapshot('specialist-b');
    expect(admit(store, changed).id).toBe(task.id); // Retrying admission never changes authority.
    const readback = store.modelRoutes.snapshot(task.current_run_id)!;
    readback.routes.HazeOps.requested_model = 'tampered';
    expect(store.modelRoutes.snapshot(task.current_run_id)).toEqual(original);
    store.close();
    store = open(path);
    store.close();
    store = open(path);
    const recovered = store.read(task.id, localTaskIdentity);
    const late = assign(store, recovered, 'HazeOps');
    expect(store.modelRoutes.assignmentRoute(late)).toEqual(
      original.routes.HazeOps,
    );
    expect(store.modelRoutes.assignmentRoute(first)).toEqual(
      original.routes.Manager,
    );
    control(store, store.read(task.id, localTaskIdentity), 'pause');
    const paused = store.read(task.id, localTaskIdentity);
    control(store, paused, 'resume');
    expect(store.modelRoutes.snapshot(task.current_run_id)).toEqual(original);
    control(store, store.read(task.id, localTaskIdentity), 'pause');
    control(store, store.read(task.id, localTaskIdentity), 'continue', changed);
    const successor = store.read(task.id, localTaskIdentity);
    expect(successor.runs.at(-1)?.predecessor_run_id).toBe(task.current_run_id);
    expect(store.modelRoutes.snapshot(successor.current_run_id)).toEqual(
      changed,
    );
    expect(store.modelRoutes.snapshot(task.current_run_id)).toEqual(original);
    expect(
      store.modelRoutes.assignmentRoute(
        assign(store, successor, 'WorkerShield'),
      ),
    ).toEqual(changed.routes.WorkerShield);
    expect(JSON.stringify(successor)).not.toContain('TEST_ROUTE_KEY');
    expect(JSON.stringify(successor)).not.toContain('localhost:9876');
  });
  it('fences a pre-snapshot run, leaves historical operations unknown and unchanged, and requires linked continuation', () => {
    let store = open();
    const path = store.directory;
    const task = admit(store, snapshot());
    const assignment = assign(store, task, 'Manager');
    const leased = store.acquireAssignment(task.id, assignment.id)!;
    const operation = store.graph.prepare(
      'historical-model',
      { old: true },
      {
        task_id: task.id,
        run_id: task.current_run_id,
        generation: leased.generation,
        objective_revision: task.objective_revision,
        assignment_id: assignment.id,
        assignment_revision: assignment.revision,
      },
      'model',
    );
    store.graph.complete(operation.id, leased.generation, {
      ok: true,
      value: {
        text: 'Historical response.',
        receipt: {
          response_model: 'historical-model',
          response_id: 'old-response',
          input_tokens: null,
          output_tokens: null,
        },
      },
    });
    const original = JSON.stringify(store.graph.operation(operation.id));
    const originalReceipt = store.db
      .prepare('SELECT body FROM graph_effect_receipts WHERE operation_id=?')
      .get(operation.id);
    // Simulate an older authoritative database before the additive route migration.
    store.db.exec('DROP TABLE run_model_routes');
    store.close();
    store = open(path);
    const paused = store.read(task.id, localTaskIdentity);
    expect(paused.status).toBe('paused');
    expect(paused.manager?.upgrade_required).toContain(
      'immutable model routes',
    );
    expect(store.modelRoutes.snapshot(task.current_run_id)).toBeNull();
    expect(store.modelRoutes.operationRoute(operation.id)).toBeNull();
    expect(JSON.stringify(store.graph.operation(operation.id))).toBe(original);
    expect(
      store.db
        .prepare('SELECT body FROM graph_effect_receipts WHERE operation_id=?')
        .get(operation.id),
    ).toEqual(originalReceipt);
    expect(() => control(store, paused, 'resume')).toThrow(
      'predates immutable model routes',
    );
    control(store, paused, 'continue', snapshot('successor'));
    const successor = store.read(task.id, localTaskIdentity);
    expect(
      store.modelRoutes.snapshot(successor.current_run_id)?.routes.HazeOps
        .requested_model,
    ).toBe('successor');
    expect(store.modelRoutes.snapshot(task.current_run_id)).toBeNull();
    expect(store.modelRoutes.operationRoute(operation.id)).toBeNull();
    expect(JSON.stringify(store.graph.operation(operation.id))).toBe(original);
    expect(
      store.db
        .prepare('SELECT body FROM graph_effect_receipts WHERE operation_id=?')
        .get(operation.id),
    ).toEqual(originalReceipt);
  });
  it('records a versioned additive migration and refuses a future schema version', () => {
    const store = open();
    expect(
      store.db.prepare('SELECT version FROM model_route_migrations').all(),
    ).toEqual([{ version: 1 }]);
    store.db
      .prepare('INSERT INTO model_route_migrations VALUES(?,?)')
      .run(2, new Date().toISOString());
    const path = store.directory;
    store.close();
    expect(() => open(path)).toThrow('unsupported migration version');
  });
  it('blocks an unavailable inference route before charging a remote attempt', async () => {
    const runtime = new TaskRuntime({
      stateDirectory: directory(),
      registry: createExecutionRegistry({ mode: 'live' }),
      mode: 'live',
      env: {},
    });
    runtimes.push(runtime);
    const admitted = runtime.admit(
      { schema_version: 'haze.task.request.v3', objective: 'Say hello.' },
      'unavailable',
    );
    let task = runtime.store.read(admitted.task_id, localTaskIdentity);
    const deadline = Date.now() + 10_000;
    while (
      !['failed', 'paused', 'completed'].includes(task.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = runtime.store.read(admitted.task_id, localTaskIdentity);
    }
    expect(task.status, task.error?.message).toBe('failed');
    expect(task.error?.code).toBe('model_route_unavailable');
    expect(task.usage.model_calls).toBe(0);
    expect(runtime.store.attempts(task.id, localTaskIdentity)).toEqual([]);
  });

  it('rejects an unavailable asynchronous contract before charging or invoking a provider', async () => {
    const prepare = vi
      .fn<NonNullable<ModelRouteService['prepare']>>()
      .mockRejectedValue(
        new Error('The exact model has no supported strict contract.'),
      );
    const service = routeService(prepare);
    const runtime = new TaskRuntime({
      stateDirectory: directory(),
      registry: createExecutionRegistry({ mode: 'live' }),
      mode: 'live',
      env: {},
      modelRoutes: service,
    });
    runtimes.push(runtime);
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Say hello.',
      },
      'async-unavailable',
    );
    const task = await untilTask(
      runtime,
      admitted.task_id,
      (value) => value.status === 'failed',
    );
    expect(task.error?.code).toBe('model_route_unavailable');
    expect(task.usage.model_calls).toBe(0);
    expect(runtime.store.attempts(task.id, localTaskIdentity)).toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(service.resolve).not.toHaveBeenCalled();
    const operations = runtime.store.db
      .prepare(
        "SELECT body FROM graph_operations WHERE run_id=? AND json_extract(body,'$.kind')='model'",
      )
      .all(task.current_run_id) as { body: string }[];
    expect(
      operations.map((row) => JSON.parse(row.body) as { status: string }),
    ).toMatchObject([{ status: 'prepared' }]);
  });

  it.each(['cancel', 'correction'] as const)(
    'fences %s while asynchronous preflight is pending without charging or dispatching a late result',
    async (action) => {
      let release!: (model: AgentModel) => void;
      let preflightSignal: AbortSignal | undefined;
      let preflightCount = 0;
      const provider = {
        selection: { provider: 'controlled-test', model: 'manager-a' },
        complete: vi.fn(() =>
          Promise.resolve('A late result must not be invoked.'),
        ),
      } satisfies AgentModel;
      const prepare = vi
        .fn<NonNullable<ModelRouteService['prepare']>>()
        .mockImplementation((_route, signal) => {
          // Corrected work owns a fresh negotiation; keep it unavailable so
          // this regression measures whether the obsolete call can dispatch.
          if (++preflightCount > 1)
            return Promise.reject(
              new Error('The corrected route is unavailable.'),
            );
          preflightSignal = signal;
          // This controlled remote inspection deliberately ignores cancellation.
          return new Promise<AgentModel>((resolve) => {
            release = resolve;
          });
        });
      const service = routeService(prepare);
      const runtime = new TaskRuntime({
        stateDirectory: directory(),
        registry: createExecutionRegistry({ mode: 'live' }),
        mode: 'live',
        env: {},
        modelRoutes: service,
      });
      runtimes.push(runtime);
      const admitted = runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'Say hello.',
        },
        `pending-${action}`,
      );
      const before = await untilTask(
        runtime,
        admitted.task_id,
        () => prepare.mock.calls.length === 1,
      );
      expect(before.usage.model_calls).toBe(0);
      if (action === 'correction')
        runtime.update(
          before.id,
          {
            schema_version: 'haze.task.update.v3',
            ...mutationExpectation(before),
            kind: 'correction',
            passage:
              'Replace this objective before any inference is dispatched.',
          },
          'correct-preflight',
        );
      else
        runtime.control(
          before.id,
          {
            schema_version: 'haze.task.control.v3',
            ...mutationExpectation(before),
            action: 'cancel',
          },
          'cancel-preflight',
        );
      await untilTask(runtime, before.id, () => runtime.activeCount === 0);
      expect(preflightSignal?.aborted).toBe(true);
      release(provider);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = runtime.store.read(before.id, localTaskIdentity);
      expect(after.status).toBe(action === 'cancel' ? 'cancelled' : 'failed');
      expect(after.generation).toBeGreaterThan(before.generation);
      expect(after.usage.model_calls).toBe(0);
      expect(runtime.store.attempts(after.id, localTaskIdentity)).toEqual([]);
      expect(provider.complete).not.toHaveBeenCalled();
      expect(service.resolve).not.toHaveBeenCalled();
    },
  );

  it('replays a completed model receipt without preparing the route again after credentials become unavailable', async () => {
    let credentialAvailable = true;
    const completion = {
      text: 'An exact retained provider response.',
      receipt: {
        response_model: 'manager-a',
        response_id: 'durable-response-1',
        response_status: 'stop',
        input_tokens: 17,
        output_tokens: 9,
        http_status: 200,
      },
    };
    const provider = {
      selection: { provider: 'controlled-test', model: 'manager-a' },
      complete: vi.fn(() => Promise.resolve(completion.text)),
      completeWithReceipt: vi.fn(() => Promise.resolve(completion)),
    } satisfies AgentModel;
    const prepare = vi
      .fn<NonNullable<ModelRouteService['prepare']>>()
      .mockImplementation(() =>
        credentialAvailable
          ? Promise.resolve(provider)
          : Promise.reject(new Error('The server credential is unavailable.')),
      );
    const service = routeService(prepare);
    const runtime = new TaskRuntime({
      stateDirectory: directory(),
      registry: createExecutionRegistry({ mode: 'live' }),
      mode: 'live',
      env: {},
      modelRoutes: service,
    });
    runtimes.push(runtime);
    // Admit directly into the authoritative store so graph scheduling cannot
    // advance this controlled operation between its dispatch and exact replay.
    const task = admit(runtime.store, snapshot(), 'receipt-replay');
    const manager = runtime.store.ensureManager(task.id, task.current_run_id, {
      definition_id: 'core.manager.coordinator',
      definition_version: '4',
      role: 'Manager',
      capability: 'core.manager',
      brief: 'Exercise exact durable receipt replay.',
      tools: task.permissions.tools,
      max_model_calls: task.limits.max_model_calls,
    });
    const leased = runtime.store.acquireAssignment(task.id, manager.id)!;
    const context = { purpose: 'decision' };
    const first = await runtime['modelTurn'](
      task,
      leased,
      context,
      new AbortController().signal,
      'exact-receipt-operation',
    );
    expect(first).toEqual(completion);
    credentialAvailable = false;
    const replay = await runtime['modelTurn'](
      runtime.store.read(task.id, localTaskIdentity),
      leased,
      context,
      new AbortController().signal,
      'exact-receipt-operation',
    );
    expect(replay).toEqual(completion);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(provider.completeWithReceipt).toHaveBeenCalledTimes(1);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
    expect(
      runtime.store.read(task.id, localTaskIdentity).usage.model_calls,
    ).toBe(1);
    expect(runtime.store.attempts(task.id, localTaskIdentity)).toHaveLength(1);
  });
});
