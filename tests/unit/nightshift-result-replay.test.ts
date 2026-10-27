import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  taskRequestSchema,
  type Assignment,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import { TaskStore } from '../../app/tasks/store.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import { graphThreadId } from '../../app/tasks/graph-ledger.js';
import type { NightshiftToolOutput } from '../../app/tasks/nightshift-tools.js';

const resources: { store: TaskStore; directory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    const target = relative(resolve(tmpdir()), resolve(directory));
    if (!target || target.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

const expected = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});

function fixture(consume = true) {
  // A short grant exposes expiry without waiting; fixture setup must not spend
  // that lifetime on a slow runner.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const directory = mkdtempSync(
    join(tmpdir(), 'haze-nightshift-result-replay-'),
  );
  const store = new TaskStore(directory, { recover: false });
  resources.push({ store, directory });
  const tools = ['nightshift.result'];
  let task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Inspect an unreviewed candidate under its current grant.',
    }),
    localTaskIdentity,
    'task',
    { tools },
  ).task;
  const assignments = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'Manager',
        definition_id: 'core.manager.coordinator',
        definition_version: 'fixture.v1',
        capability: 'fixture',
        brief: 'Coordinate.',
      },
      {
        role: 'HazeOps',
        definition_id: 'fixture.external',
        definition_version: 'fixture.v1',
        capability: 'fixture',
        brief: 'Consume candidate.',
        tools,
      },
    ],
  );
  const assignment = store.acquireAssignment(task.id, assignments[1]!.id)!;
  task = store.read(task.id, localTaskIdentity);
  const chain = store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: task.id,
      ...expected(task),
      lifetime_seconds: 1,
    },
    'chain',
    localTaskIdentity,
  ).chain;
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      chain_id: chain.id,
      ...expected(store.read(task.id, localTaskIdentity)),
      expected_assignment_id: assignment.id,
      expected_assignment_revision: assignment.revision,
      expected_chain_revision: chain.revision,
      prompt: 'Unreviewed candidate.',
      n: 1,
      role: 'HazeOps',
    },
    'job',
    localTaskIdentity,
    {
      adapter_version: 'fixture',
      runtime_version: 'fixture',
      schema_hash: 'fixture',
    },
  ).job;
  const remote = 'fixture-remote';
  store.nightshift.acknowledge(job.id, remote);
  const authority = {
    task_id: task.id,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
    assignment_id: assignment.id,
    assignment_revision: assignment.revision,
  };
  store.externalWaits.wait(
    {
      ...authority,
      thread_id: graphThreadId('assignment', authority),
      after_cursor: store.events(task.id, localTaskIdentity, 0).next_cursor,
      dependencies: [{ job_id: job.id, required: true }],
    },
    localTaskIdentity,
  );
  store.nightshift.observation(
    job.id,
    remote,
    {
      remote_id: remote,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    },
    { status: 'accepted', basis: null, explanation: null },
  );
  store.nightshift.capture(
    job.id,
    remote,
    {
      text: 'Unreviewed candidate bytes.',
      attempts: [],
      winner_seq: null,
      retrieval_error: null,
      truncated: false,
    },
    { status: 'accepted', basis: null, explanation: null },
  );
  store.externalWaits.reconcileDeliveries();
  // Exercise the real local receipt path without starting a graph dispatcher,
  // listening server, supervisor or external adapter.
  const runtime = Object.create(TaskRuntime.prototype) as TaskRuntime;
  Object.defineProperty(runtime, 'store', { value: store });
  const local = runtime as unknown as {
    localNightshiftResult(
      task: TaskRecord,
      assignment: Assignment,
      key: string,
      input: unknown,
      version: string,
    ): NightshiftToolOutput;
  };
  const input = {
    schema_version: 'haze.nightshift.tool.result.v1',
    job_id: job.id,
    ...(consume
      ? {
          decision: 'use_candidate',
          reason: 'Use the exact delivered candidate as unreviewed input.',
        }
      : {}),
  };
  const call = () =>
    local.localNightshiftResult(
      store.read(task.id, localTaskIdentity),
      assignment,
      'read-candidate',
      input,
      'nightshift-result.v1',
    );
  return { store, task, authority, chain, clock, call };
}

it('replays eligible candidate bytes without charging or dispatching again', () => {
  const f = fixture();
  const first = f.call();
  expect(first.output).toBe('Unreviewed candidate bytes.');
  const before = f.store.read(f.task.id, localTaskIdentity).usage.tool_calls;
  expect(f.call()).toEqual(first);
  expect(f.store.read(f.task.id, localTaskIdentity).usage.tool_calls).toBe(
    before,
  );
});

it('rejects completed-result replay after chain expiry without altering its accepted receipt or charges', () => {
  const f = fixture();
  expect(f.call().output).toBe('Unreviewed candidate bytes.');
  const before = f.store.read(f.task.id, localTaskIdentity).usage.tool_calls;
  const receiptBefore = f.store.db
    .prepare('SELECT body FROM graph_operations WHERE key=?')
    .get('read-candidate');
  f.clock.mockReturnValue(Date.parse(f.chain.expires_at) + 1);
  expect(
    f.store.externalWaits.candidateContext(f.authority, localTaskIdentity),
  ).toEqual([]);
  const current = f.store.read(f.task.id, localTaskIdentity);
  expect(['queued', 'running']).toContain(current.status);
  expect(Date.now()).toBeLessThan(Date.parse(current.limits.deadline));
  expect(() => f.call()).toThrow('no longer authorized');
  expect(f.store.read(f.task.id, localTaskIdentity).usage.tool_calls).toBe(
    before,
  );
  expect(
    f.store.db
      .prepare('SELECT body FROM graph_operations WHERE key=?')
      .get('read-candidate'),
  ).toEqual(receiptBefore);
});

it('preserves metadata-only receipt replay without granting candidate bytes', () => {
  const f = fixture(false);
  const first = f.call();
  expect(first.output).toBeNull();
  expect(first.candidate).not.toBeNull();
  const before = f.store.read(f.task.id, localTaskIdentity).usage.tool_calls;
  f.clock.mockReturnValue(Date.parse(f.chain.expires_at) + 1);
  expect(
    f.store.externalWaits.candidateContext(f.authority, localTaskIdentity),
  ).toEqual([]);
  expect(f.call()).toEqual(first);
  expect(f.store.read(f.task.id, localTaskIdentity).usage.tool_calls).toBe(
    before,
  );
});
