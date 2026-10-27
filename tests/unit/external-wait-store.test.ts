import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import { graphThreadId } from '../../app/tasks/graph-ledger.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type {
  ExternalAuthority,
  ExternalWait,
} from '../../app/contracts/external-waits.js';
import type { NightshiftJob } from '../../app/contracts/nightshift-records.js';

const identity = {
  principal: 'external-fixture-user',
  workspace: 'external-fixture-workspace',
};
const tools = ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'];
const stores: TaskStore[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function open(directory?: string) {
  const target =
    directory ?? mkdtempSync(join(tmpdir(), 'haze-external-wait-'));
  if (!directory) directories.push(target);
  const store = new TaskStore(target, { recover: false });
  stores.push(store);
  return store;
}
const expected = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
function admit(store: TaskStore, key = 'task') {
  return store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Produce an evidence-linked draft and independent review.',
    }),
    identity,
    key,
    { tools },
  ).task;
}
function fixture(store: TaskStore, key = 'task') {
  let task = admit(store, key);
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
        brief: 'Coordinate bounded work.',
      },
      {
        role: 'HazeOps',
        definition_id: 'fixture.external',
        definition_version: 'fixture.v1',
        capability: 'fixture',
        brief: 'Prepare an evidence-linked draft.',
        tools,
      },
    ],
  );
  const specialist = store.acquireAssignment(task.id, assignments[1]!.id)!;
  task = store.read(task.id, identity);
  const chain = store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      task_id: task.id,
      ...expected(task),
    },
    `chain-${key}`,
    identity,
  ).chain;
  task = store.read(task.id, identity);
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      chain_id: chain.id,
      ...expected(task),
      expected_assignment_id: specialist.id,
      expected_assignment_revision: specialist.revision,
      expected_chain_revision: chain.revision,
      prompt: 'Draft an alternative explanation with uncertainty.',
      n: 1,
      role: 'HazeOps',
    },
    `job-${key}`,
    identity,
    {
      adapter_version: 'fixture.v1',
      runtime_version: 'fixture.v1',
      schema_hash: 'fixture',
    },
  ).job;
  store.nightshift.acknowledge(job.id, `remote-${job.id}`);
  const authority: ExternalAuthority = {
    task_id: task.id,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
    assignment_id: specialist.id,
    assignment_revision: specialist.revision,
  };
  const cursor = store.events(task.id, identity, 0).next_cursor;
  return {
    task: store.read(task.id, identity),
    authority,
    job: store.nightshift.job(job.id, identity),
    cursor,
    thread_id: graphThreadId('assignment', authority),
  };
}
type Fixture = ReturnType<typeof fixture>;
function park(
  store: TaskStore,
  f: Fixture,
  dependencies: ExternalWait['dependencies'] = [
    { job_id: f.job.id, required: true },
  ],
) {
  const wait = store.externalWaits.wait(
    {
      ...f.authority,
      thread_id: f.thread_id,
      after_cursor: f.cursor,
      dependencies,
    },
    identity,
  );
  store.completeAssignment(
    f.task.id,
    f.authority.assignment_id,
    f.authority.generation,
    { status: 'waiting' },
  );
  const task = store.read(f.task.id, identity);
  store.waitForManagerEvent(
    task.id,
    {
      run_id: task.current_run_id,
      objective_revision: task.objective_revision,
      plan_revision: task.manager!.plan_revision,
      generation: task.generation,
    },
    'Only the acknowledged external job is pending.',
  );
  const manager = {
    task_id: task.id,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
  };
  store.graph.park({
    ...manager,
    thread_id: graphThreadId('manager', manager),
    kind: 'manager',
    cursor: f.cursor,
    after_cursor: store.events(task.id, identity, 0).next_cursor,
    event_types: ['fixture_no_event'],
  });
  store.graph.park({
    ...f.authority,
    thread_id: f.thread_id,
    kind: 'assignment',
    cursor: f.cursor,
    after_cursor: f.cursor,
    event_types: ['external_result', 'external_result_ready'],
  });
  return wait;
}
function finish(
  store: TaskStore,
  job: NightshiftJob,
  state: 'completed' | 'failed' = 'completed',
) {
  store.nightshift.observation(
    job.id,
    job.remote_id!,
    {
      remote_id: job.remote_id!,
      execution_state: state,
      terminal: true,
      generated: 1,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    },
    { status: 'accepted', basis: null, explanation: null },
  );
  if (state === 'completed')
    store.nightshift.capture(
      job.id,
      job.remote_id!,
      {
        text: 'Candidate draft; all claims still require independent review.',
        attempts: [],
        winner_seq: null,
        retrieval_error: null,
        truncated: false,
      },
      { status: 'accepted', basis: null, explanation: null },
    );
}
function activate(store: TaskStore, f: Fixture) {
  store.externalWaits.drainReady();
  store.wakeExternalTask(f.authority);
  store.wakeAssignment(f.task.id, f.authority.assignment_id);
  expect(
    store.acquireAssignment(f.task.id, f.authority.assignment_id),
  ).not.toBeNull();
}
function consumedRequiredWithOptional(store: TaskStore) {
  const f = fixture(store);
  const task = store.read(f.task.id, identity);
  const chain = store.nightshift.chain(f.job.chain_id, identity);
  const submitted = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      chain_id: chain.id,
      ...expected(task),
      expected_assignment_id: f.authority.assignment_id,
      expected_assignment_revision: f.authority.assignment_revision,
      expected_chain_revision: chain.revision,
      prompt: 'An optional alternative; never delay required completion.',
      n: 1,
      role: 'HazeOps',
    },
    'optional-job',
    identity,
    {
      adapter_version: 'fixture.v1',
      runtime_version: 'fixture.v1',
      schema_hash: 'fixture',
    },
  ).job;
  const optional = store.nightshift.acknowledge(
    submitted.id,
    `remote-${submitted.id}`,
  );
  const wait = park(store, f, [
    { job_id: f.job.id, required: true },
    { job_id: optional.id, required: false },
  ]);
  finish(store, f.job);
  store.externalWaits.reconcileDeliveries();
  activate(store, f);
  store.externalWaits.resolve(f.job.id, f.authority, identity, {
    decision: 'use_candidate',
  });
  return { ...f, optional, wait };
}

describe('external waits and durable capacity', () => {
  it('retains and explicitly consumes a late optional result without reopening required completion or waking execution', () => {
    const store = open(),
      f = consumedRequiredWithOptional(store);
    expect(() =>
      store.externalWaits.assertFinalizable(f.authority),
    ).not.toThrow();
    const cursor = store.events(f.task.id, identity, 0).next_cursor;
    const before = store.externalWaits.view(f.task.id, identity);
    expect(before.waits.find((wait) => wait.id === f.wait.id)?.state).toBe(
      'consumed',
    );

    finish(store, f.optional);
    expect(store.externalWaits.reconcileDeliveries()).toBe(1);
    expect(store.externalWaits.reconcileDeliveries()).toBe(0);
    const delivered = store.externalWaits.view(f.task.id, identity);
    expect(delivered.waits.find((wait) => wait.id === f.wait.id)?.state).toBe(
      'consumed',
    );
    expect(delivered.deliveries).toHaveLength(2);
    expect(
      delivered.deliveries.find((item) => item.job_id === f.optional.id),
    ).toMatchObject({ state: 'retained', reason: null });
    expect(delivered.capacity.queue).toEqual(before.capacity.queue);
    const events = store.events(f.task.id, identity, cursor).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'external_result',
      data: { job_id: f.optional.id, retained_only: true },
    });
    expect(store.externalWaits.drainReady()).toEqual([]);

    const consumed = store.externalWaits.resolve(
      f.optional.id,
      f.authority,
      identity,
      { decision: 'use_candidate' },
    );
    expect(consumed.state).toBe('consumed');
    expect(
      store.externalWaits.resolve(f.optional.id, f.authority, identity, {
        decision: 'use_candidate',
      }).id,
    ).toBe(consumed.id);
    expect(
      store.externalWaits
        .candidateContext(f.authority, identity)
        .map((item) => item.job_id),
    ).toEqual([f.job.id, f.optional.id]);
    expect(store.externalWaits.reconcileDeliveries()).toBe(0);
    expect(
      store.externalWaits.view(f.task.id, identity).deliveries,
    ).toHaveLength(2);
  });
  it.each(['pause', 'close'] as const)(
    'retains a late optional result after %s without a new readiness event or wake',
    (action) => {
      const store = open(),
        f = consumedRequiredWithOptional(store);
      const task = store.read(f.task.id, identity);
      if (action === 'pause')
        store.control(task.id, identity, 'pause', {
          schema_version: 'haze.task.control.v3',
          ...expected(task),
          action: 'pause',
        });
      else {
        store.nightshift.controlChain(
          f.job.chain_id,
          {
            schema_version: 'haze.nightshift.chain.control.v1',
            ...expected(task),
            expected_chain_revision: store.nightshift.chain(
              f.job.chain_id,
              identity,
            ).revision,
            action: 'close',
          },
          'close',
          identity,
        );
        store.externalWaits.onChainControl(f.job.chain_id, 'close');
      }
      const cursor = store.events(f.task.id, identity, 0).next_cursor;
      finish(store, f.optional);
      expect(store.externalWaits.reconcileDeliveries()).toBe(1);
      expect(store.externalWaits.reconcileDeliveries()).toBe(0);
      const view = store.externalWaits.view(f.task.id, identity);
      expect(view.waits.find((wait) => wait.id === f.wait.id)?.state).toBe(
        'consumed',
      );
      expect(view.deliveries).toHaveLength(2);
      expect(
        view.deliveries.find((item) => item.job_id === f.optional.id)?.state,
      ).toBe('fenced');
      const events = store.events(f.task.id, identity, cursor).events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'external_result',
        data: { job_id: f.optional.id, retained_only: true },
      });
      expect(store.externalWaits.drainReady()).toEqual([]);
      expect(() =>
        store.externalWaits.resolve(f.optional.id, f.authority, identity, {
          decision: 'use_candidate',
        }),
      ).toThrow();
      expect(
        store.nightshift.job(f.optional.id, identity).receipt,
      ).not.toBeNull();
    },
  );
  it('releases the specialist lease and only verified external-only work releases its task permit', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    expect(
      store
        .read(f.task.id, identity)
        .assignments.find((item) => item.id === f.authority.assignment_id)
        ?.lease_token,
    ).toBeUndefined();
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(true);
    expect(
      store.externalWaits.view(f.task.id, identity).capacity,
    ).toMatchObject({ permit: 'released', wait_reason: 'compute' });
    expect(() => store.externalWaits.assertPermit(f.authority)).toThrow(
      'permit',
    );
  });
  it('rejects cross-workspace, cross-task and unacknowledged local handles', () => {
    const store = open(),
      f = fixture(store);
    const input = {
      ...f.authority,
      thread_id: f.thread_id,
      after_cursor: f.cursor,
      dependencies: [{ job_id: f.job.id, required: true }],
    };
    expect(() =>
      store.externalWaits.wait(input, { ...identity, workspace: 'elsewhere' }),
    ).toThrow();
    const other = admit(store, 'other');
    expect(() =>
      store.externalWaits.wait({ ...input, task_id: other.id }, identity),
    ).toThrow();
    const row = store.db
      .prepare('SELECT body FROM ns_jobs WHERE id=?')
      .get(f.job.id) as { body: string };
    const body = JSON.parse(row.body) as NightshiftJob;
    body.remote_id = null;
    body.execution_state = 'submission_unknown';
    store.db
      .prepare('UPDATE ns_jobs SET body=? WHERE id=?')
      .run(JSON.stringify(body), body.id);
    expect(() => store.externalWaits.wait(input, identity)).toThrow(
      'acknowledged',
    );
  });
  it('blocks finalization for pending and failed required work until an explicit supported decision', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    expect(() => store.externalWaits.assertFinalizable(f.authority)).toThrow(
      'Required external',
    );
    expect(() =>
      store.externalWaits.resolve(f.job.id, f.authority, identity, {
        decision: 'replan',
        reason: 'Try registered capabilities.',
      }),
    ).toThrow('pending');
    finish(store, f.job, 'failed');
    store.externalWaits.reconcileDeliveries();
    expect(() => store.externalWaits.assertFinalizable(f.authority)).toThrow(
      'Required external',
    );
    expect(() =>
      store.externalWaits.resolve(f.job.id, f.authority, identity, {
        decision: 'supported_failure',
      }),
    ).toThrow('reason');
    expect(() =>
      store.externalWaits.resolve(f.job.id, f.authority, identity, {
        decision: 'supported_failure',
        reason: 'A terminal failure needs a current lease.',
      }),
    ).toThrow('lease');
    activate(store, f);
    store.externalWaits.resolve(f.job.id, f.authority, identity, {
      decision: 'supported_failure',
      reason: 'The native worker verified terminal failure; report the gap.',
    });
    expect(() =>
      store.externalWaits.assertFinalizable(f.authority),
    ).not.toThrow();
    expect(store.externalWaits.candidateContext(f.authority, identity)).toEqual(
      [],
    );
  });
  it('deduplicates terminal delivery, targets the exact specialist and retains one FIFO position', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.externalWaits.tryReleaseExternalOnly(f.authority);
    const other = admit(store, 'other'),
      third = admit(store, 'third');
    finish(store, f.job);
    expect(store.externalWaits.reconcileDeliveries()).toBe(1);
    const before = store.externalWaits.view(f.task.id, identity);
    expect(before.capacity.wait_reason).toBe('capacity');
    for (let i = 0; i < 4; i++)
      expect(store.externalWaits.reconcileDeliveries()).toBe(0);
    const after = store.externalWaits.view(f.task.id, identity);
    expect(after.deliveries).toHaveLength(1);
    expect(after.capacity.queue?.sequence).toBe(
      before.capacity.queue?.sequence,
    );
    expect(store.graph.wait(f.thread_id)?.status).toBe('ready');
    expect(
      store.graph.wait(graphThreadId('manager', f.authority))?.status,
    ).toBe('parked');
    expect(store.externalWaits.drainReady()).toEqual([]);
    store.externalWaits.release(
      {
        task_id: other.id,
        run_id: other.current_run_id,
        generation: other.generation,
        objective_revision: other.objective_revision,
      },
      'fixture completed',
    );
    expect(() => admit(store, 'jump')).toThrow('priority');
    expect(
      store.externalWaits.drainReady().map((item) => item.task_id),
    ).toEqual([f.task.id]);
    expect(store.externalWaits.drainReady()).toEqual([]);
    expect(store.externalWaits.view(third.id, identity).capacity.permit).toBe(
      'held',
    );
    expect(
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM task_capacity_permits WHERE status='held'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
  });
  it('handles result-before-park and commits terminal receipt plus exact delivery once', () => {
    const store = open(),
      f = fixture(store);
    finish(store, f.job);
    park(store, f);
    const view = store.externalWaits.view(f.task.id, identity);
    expect(view.waits[0]?.state).toBe('ready');
    expect(view.deliveries).toHaveLength(1);
    expect(store.graph.wait(f.thread_id)?.status).toBe('ready');
    expect(store.externalWaits.reconcileDeliveries()).toBe(0);
    activate(store, f);
    store.externalWaits.resolve(f.job.id, f.authority, identity, {
      decision: 'use_candidate',
    });
    expect(
      store.externalWaits.candidateContext(f.authority, identity)[0],
    ).toMatchObject({
      job_id: f.job.id,
      candidate: true,
      independent_review: 'required',
      judge_is_not_review: true,
    });
    expect(
      store
        .read(f.task.id, identity)
        .artifacts.some(
          (item) =>
            item.artifact.id === view.deliveries[0]?.artifact?.id &&
            item.current,
        ),
    ).toBe(false);
  });
  it('does not release a permit for mixed, human, runnable, executing or unresolved waits', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    const manager = store
      .read(f.task.id, identity)
      .assignments.find((item) => item.role === 'Manager')!;
    const amend = (id: string, patch: Record<string, unknown>) => {
      const row = store.db
        .prepare('SELECT body FROM assignments WHERE id=?')
        .get(id) as { body: string };
      store.db
        .prepare('UPDATE assignments SET body=? WHERE id=?')
        .run(JSON.stringify({ ...JSON.parse(row.body), ...patch }), id);
    };
    amend(f.authority.assignment_id, { status: 'queued' });
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(false);
    amend(f.authority.assignment_id, { status: 'waiting' });
    amend(manager.id, { status: 'running' });
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(false);
    amend(manager.id, { status: 'waiting' });
    store.graph.enqueue({
      ...f.authority,
      thread_id: f.thread_id,
      kind: 'assignment',
      cursor: 900,
    });
    store.graph.claim('fixture-worker');
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(false);
    for (const job of store.graph.pending()) store.graph.finish(job.id);
    const row = store.db
      .prepare('SELECT body FROM ns_jobs WHERE id=?')
      .get(f.job.id) as { body: string };
    store.db.prepare('UPDATE ns_jobs SET body=? WHERE id=?').run(
      JSON.stringify({
        ...JSON.parse(row.body),
        execution_state: 'submission_unknown',
      }),
      f.job.id,
    );
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(false);
    expect(store.externalWaits.view(f.task.id, identity).capacity.permit).toBe(
      'held',
    );
  });
  it('retains late bytes while pause fences delivery and consumption', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    let task = store.read(f.task.id, identity);
    store.control(task.id, identity, 'pause', {
      schema_version: 'haze.task.control.v3',
      ...expected(task),
      action: 'pause',
    });
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    const view = store.externalWaits.view(task.id, identity);
    expect(view.deliveries[0]?.state).toBe('fenced');
    expect(view.capacity.wait_reason).toBe('stopped');
    expect(() =>
      store.externalWaits.resolve(f.job.id, f.authority, identity, {
        decision: 'use_candidate',
      }),
    ).toThrow();
    expect(store.nightshift.job(f.job.id, identity).receipt?.output).toContain(
      'Candidate',
    );
    task = store.read(task.id, identity);
    store.control(task.id, identity, 'resume', {
      schema_version: 'haze.task.control.v3',
      ...expected(task),
      action: 'resume',
    });
    const resumed = store.read(task.id, identity),
      current = store.externalWaits
        .view(task.id, identity)
        .waits.find((wait) => wait.authority.generation === resumed.generation);
    expect(current?.authority.assignment_revision).toBe(
      f.authority.assignment_revision,
    );
    expect(current?.state).toBe('ready');
  });
  it('does not restore correction, revoked or superseded authority when generations change', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.externalWaits.onAuthorityChange(f.task.id, 'revoke');
    const row = store.db
      .prepare('SELECT body FROM runs WHERE id=?')
      .get(f.task.current_run_id) as { body: string };
    const run = JSON.parse(row.body) as TaskRecord['runs'][number];
    run.generation++;
    store.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify(run), f.task.current_run_id);
    store.externalWaits.rebind(
      {
        task_id: f.task.id,
        run_id: f.task.current_run_id,
        objective_revision: f.task.objective_revision,
        generation: run.generation,
      },
      'recovery',
    );
    expect(store.externalWaits.view(f.task.id, identity).waits).toHaveLength(1);
  });
  it('persists released capacity and inbox across reopening without replaying remote submission', () => {
    let store = open();
    const f = fixture(store);
    park(store, f);
    store.externalWaits.tryReleaseExternalOnly(f.authority);
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    const sequence = store.externalWaits.view(f.task.id, identity).capacity
      .queue!.sequence;
    const path = store.directory;
    store.close();
    store = open(path);
    store.externalWaits.recover();
    expect(store.externalWaits.view(f.task.id, identity).capacity.permit).toBe(
      'released',
    );
    expect(
      store.externalWaits.view(f.task.id, identity).capacity.queue?.sequence,
    ).toBe(sequence);
    expect(
      store.externalWaits.view(f.task.id, identity).deliveries,
    ).toHaveLength(1);
    expect(
      (
        store.db
          .prepare('SELECT count(*) n FROM ns_submission_attempts')
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });
  it('retains a granted permit across a generation fence without manufacturing released capacity', () => {
    const store = open(),
      f = fixture(store);
    store.externalWaits.retainPermit({ ...f.authority, generation: 2 });
    expect(() =>
      store.externalWaits.assertPermit({ ...f.authority, generation: 2 }),
    ).not.toThrow();
    store.externalWaits.release(f.authority, 'fixture');
    store.externalWaits.retainPermit({ ...f.authority, generation: 3 });
    expect(() =>
      store.externalWaits.assertPermit({ ...f.authority, generation: 3 }),
    ).toThrow();
  });
  it('serves earlier eligible completions first across several parked tasks without queue jumping', () => {
    const store = open(),
      first = fixture(store, 'first');
    park(store, first);
    store.externalWaits.tryReleaseExternalOnly(first.authority);
    const second = fixture(store, 'second');
    park(store, second);
    store.externalWaits.tryReleaseExternalOnly(second.authority);
    const third = admit(store, 'third'),
      fourth = admit(store, 'fourth');
    finish(store, second.job);
    store.externalWaits.reconcileDeliveries();
    finish(store, first.job);
    store.externalWaits.reconcileDeliveries();
    const sequence = store.externalWaits.view(second.task.id, identity).capacity
      .queue!.sequence;
    expect(sequence).toBeLessThan(
      store.externalWaits.view(first.task.id, identity).capacity.queue!
        .sequence,
    );
    expect(store.externalWaits.drainReady()).toEqual([]);
    store.externalWaits.release(
      {
        task_id: third.id,
        run_id: third.current_run_id,
        generation: third.generation,
        objective_revision: third.objective_revision,
      },
      'fixture completed',
    );
    expect(() => admit(store, 'jump')).toThrow('priority');
    expect(store.externalWaits.drainReady().map((row) => row.task_id)).toEqual([
      second.task.id,
    ]);
    expect(
      store.externalWaits.view(second.task.id, identity).capacity.queue!
        .sequence,
    ).toBe(sequence);
    store.externalWaits.release(
      {
        task_id: fourth.id,
        run_id: fourth.current_run_id,
        generation: fourth.generation,
        objective_revision: fourth.objective_revision,
      },
      'fixture completed',
    );
    expect(store.externalWaits.drainReady().map((row) => row.task_id)).toEqual([
      first.task.id,
    ]);
    expect(
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM task_capacity_permits WHERE status='held'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
  });
  it('suspends chain-paused targets and emits a separate exact wake on explicit same-generation chain Resume', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.externalWaits.tryReleaseExternalOnly(f.authority);
    const change = (action: 'pause' | 'resume') =>
      store.graph.transaction(() => {
        const task = store.read(f.task.id, identity),
          chain = store.nightshift.chain(f.job.chain_id, identity);
        store.nightshift.controlChain(
          chain.id,
          {
            schema_version: 'haze.nightshift.chain.control.v1',
            ...expected(task),
            expected_chain_revision: chain.revision,
            action,
          },
          `chain-${action}`,
          identity,
        );
        store.externalWaits.onChainControl(chain.id, action);
      });
    change('pause');
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    expect(
      store.externalWaits.view(f.task.id, identity).capacity.wait_reason,
    ).toBe('stopped');
    expect(store.graph.wait(f.thread_id)?.status).toBe('parked');
    expect(store.externalWaits.drainReady()).toEqual([]);
    change('resume');
    expect(store.graph.wait(f.thread_id)?.status).toBe('ready');
    expect(
      store.externalWaits.view(f.task.id, identity).deliveries,
    ).toHaveLength(1);
    const cursor = store.externalWaits.view(f.task.id, identity).capacity.queue!
      .sequence;
    store.externalWaits.onChainControl(f.job.chain_id, 'resume');
    expect(
      store.externalWaits.view(f.task.id, identity).capacity.queue!.sequence,
    ).toBe(cursor);
    expect(
      store
        .events(f.task.id, identity, 0)
        .events.filter((event) => event.type === 'external_result_ready'),
    ).toHaveLength(1);
    expect(store.externalWaits.drainReady()).toHaveLength(1);
  });
  it('records explicit Manager replanning and scopes specialist finalization to its own required jobs', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    const task = store.read(f.task.id, identity),
      manager = task.assignments.find((item) => item.role === 'Manager')!;
    expect(() =>
      store.externalWaits.assertFinalizable({
        ...f.authority,
        assignment_id: manager.id,
        assignment_revision: manager.revision,
      }),
    ).not.toThrow();
    expect(() => store.externalWaits.assertFinalizable(f.authority)).toThrow();
    store.externalWaits.replanAssignments(
      task.id,
      [f.authority.assignment_id],
      'Accepted Manager plan uses registered deterministic methods instead.',
    );
    expect(() =>
      store.externalWaits.assertFinalizable(f.authority),
    ).not.toThrow();
    expect(store.externalWaits.view(task.id, identity).waits[0]?.state).toBe(
      'fenced',
    );
    expect(store.nightshift.job(f.job.id, identity).execution_state).toBe(
      'queued',
    );
  });
  it('does not mistake a peer graph wait for verified external-only blockage', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.graph.park({
      ...f.authority,
      thread_id: f.thread_id,
      kind: 'assignment',
      cursor: f.cursor,
      after_cursor: f.cursor,
      event_types: ['peer_message_sent', 'external_result'],
    });
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(false);
    expect(store.externalWaits.view(f.task.id, identity).capacity.permit).toBe(
      'held',
    );
  });
  it('makes deadline-expired retained results historical and requires explicit Continue', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.externalWaits.tryReleaseExternalOnly(f.authority);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 360_000);
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    const view = store.externalWaits.view(f.task.id, identity);
    expect(view.capacity.wait_reason).toBe('stopped');
    expect(view.deliveries[0]?.state).toBe('fenced');
    expect(view.waits[0]?.reason).toContain('Continue');
    expect(store.externalWaits.drainReady()).toEqual([]);
    expect(store.nightshift.job(f.job.id, identity).receipt?.output).toContain(
      'Candidate',
    );
    expect(store.read(f.task.id, identity).runs).toHaveLength(1);
  });
  it('protects immutable wait authority and terminal delivery identity in SQLite', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    const wait = store.externalWaits.view(f.task.id, identity).waits[0]!;
    expect(() =>
      store.db.prepare('UPDATE external_waits SET body=? WHERE id=?').run(
        JSON.stringify({
          ...wait,
          authority: { ...wait.authority, generation: 99 },
        }),
        wait.id,
      ),
    ).toThrow('immutable');
    const delivery = store.externalWaits.view(f.task.id, identity)
      .deliveries[0]!;
    expect(() =>
      store.db
        .prepare('UPDATE external_result_deliveries SET body=? WHERE id=?')
        .run(
          JSON.stringify({
            ...delivery,
            event_cursor: delivery.event_cursor + 1,
          }),
          delivery.id,
        ),
    ).toThrow('immutable');
  });
  it('preserves FIFO sequence through generation recovery and an acquired permit before graph dispatch', () => {
    let store = open();
    const first = fixture(store, 'recover-first');
    park(store, first);
    store.externalWaits.tryReleaseExternalOnly(first.authority);
    const second = fixture(store, 'recover-second');
    park(store, second);
    store.externalWaits.tryReleaseExternalOnly(second.authority);
    const third = admit(store, 'recover-third');
    admit(store, 'recover-fourth');
    finish(store, second.job);
    store.externalWaits.reconcileDeliveries();
    finish(store, first.job);
    store.externalWaits.reconcileDeliveries();
    const firstSequence = store.externalWaits.view(first.task.id, identity)
      .capacity.queue!.sequence;
    const secondSequence = store.externalWaits.view(second.task.id, identity)
      .capacity.queue!.sequence;
    expect(secondSequence).toBeLessThan(firstSequence);
    const directory = store.directory;
    store.close();
    store = open(directory);
    store.recover();
    expect(
      store.externalWaits.view(first.task.id, identity).capacity.queue!
        .sequence,
    ).toBe(firstSequence);
    expect(
      store.externalWaits.view(second.task.id, identity).capacity.queue!
        .sequence,
    ).toBe(secondSequence);
    const currentThird = store.read(third.id, identity);
    store.externalWaits.release(
      {
        task_id: third.id,
        run_id: currentThird.current_run_id,
        generation: currentThird.generation,
        objective_revision: currentThird.objective_revision,
      },
      'fixture releases one slot',
    );
    expect(store.externalWaits.drainReady().map((row) => row.task_id)).toEqual([
      second.task.id,
    ]);
    store.close();
    store = open(directory);
    store.recover();
    expect(
      store.externalWaits.view(second.task.id, identity).capacity.queue!
        .sequence,
    ).toBe(secondSequence);
    expect(store.externalWaits.drainReady().map((row) => row.task_id)).toEqual([
      second.task.id,
    ]);
    expect(
      (
        store.db
          .prepare(
            "SELECT count(*) n FROM task_capacity_permits WHERE status='held'",
          )
          .get() as { n: number }
      ).n,
    ).toBeLessThanOrEqual(2);
    expect(
      (
        store.db
          .prepare('SELECT count(*) n FROM ns_submission_attempts')
          .get() as { n: number }
      ).n,
    ).toBe(2);
  });
  it('never creates a second terminal delivery for the same job and exact target thread', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    finish(store, f.job);
    store.externalWaits.reconcileDeliveries();
    activate(store, f);
    store.externalWaits.resolve(f.job.id, f.authority, identity, {
      decision: 'use_candidate',
    });
    expect(() =>
      store.externalWaits.wait(
        {
          ...f.authority,
          thread_id: f.thread_id,
          after_cursor: store.events(f.task.id, identity, 0).next_cursor,
          dependencies: [{ job_id: f.job.id, required: true }],
        },
        identity,
      ),
    ).toThrow('already has a wait');
    expect(
      (
        store.db
          .prepare(
            'SELECT count(*) n FROM external_delivery_targets WHERE job_id=?',
          )
          .get(f.job.id) as { n: number }
      ).n,
    ).toBe(1);
    expect(() =>
      store.db
        .prepare('INSERT INTO external_delivery_targets VALUES(?,?,?)')
        .run(f.job.id, f.thread_id, 'duplicate-fixture'),
    ).toThrow('UNIQUE');
    const candidate = store.nightshift.job(f.job.id, identity).receipt!
      .artifact;
    const row = store.db
      .prepare('SELECT body FROM artifacts WHERE id=?')
      .get(candidate.id) as { body: string };
    const artifact = JSON.parse(row.body) as { content: { text: string } };
    artifact.content.text = 'Changed bytes without an accepted receipt.';
    store.db
      .prepare('UPDATE artifacts SET body=? WHERE id=?')
      .run(JSON.stringify(artifact), candidate.id);
    expect(() =>
      store.externalWaits.candidateContext(f.authority, identity),
    ).toThrow('hash');
  });
  it('new admission checks retained terminal results before a slower supervisor can queue them', () => {
    const store = open(),
      f = fixture(store);
    park(store, f);
    store.externalWaits.tryReleaseExternalOnly(f.authority);
    admit(store, 'occupied');
    finish(store, f.job);
    expect(() => admit(store, 'cannot-jump-retained-result')).toThrow(
      'priority',
    );
    expect(
      store.externalWaits.drainReady().map((entry) => entry.task_id),
    ).toEqual([f.task.id]);
  });
  it('releases capacity for queued downstream review blocked solely by a verified external producer', () => {
    const store = open(),
      f = fixture(store);
    store.createAssignments(
      f.task.id,
      f.task.current_run_id,
      f.task.objective_revision,
      [
        {
          role: 'EvidenceCritic',
          definition_id: 'fixture.review',
          definition_version: 'fixture.v1',
          capability: 'fixture',
          brief: 'Independently review the completed producer draft.',
          dependencies: [f.authority.assignment_id],
        },
      ],
    );
    park(store, f);
    expect(store.externalWaits.tryReleaseExternalOnly(f.authority)).toBe(true);
  });
});
