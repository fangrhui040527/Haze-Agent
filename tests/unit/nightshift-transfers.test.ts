import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import {
  graphThreadId,
  type GraphAuthority,
} from '../../app/tasks/graph-ledger.js';

const identity = { principal: 'local-user', workspace: 'local-workspace' };
const stores: TaskStore[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const local = relative(resolve(tmpdir()), resolve(directory));
    if (!local || local.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
const fence = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
function fixture(terminal = true) {
  const directory = mkdtempSync(join(tmpdir(), 'haze-ns-transfers-'));
  directories.push(directory);
  const store = new TaskStore(directory, { recover: false });
  stores.push(store);
  let task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Retain exact required predecessor candidates.',
    }),
    identity,
    randomUUID(),
    {
      tools: ['nightshift.result'],
      limits: {
        deadline: new Date(Date.now() + 60_000).toISOString(),
        max_model_calls: 8,
        max_artifacts: 16,
      },
    },
  ).task;
  const chain = store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: task.id,
      ...fence(task),
      total_runs: 2,
    },
    randomUUID(),
    identity,
  ).chain;
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      chain_id: chain.id,
      ...fence(task),
      expected_chain_revision: chain.revision,
      prompt: 'Unreviewed predecessor candidate.',
      n: 1,
      input_refs: [],
    },
    randomUUID(),
    identity,
    {
      adapter_version: 'fixture',
      runtime_version: 'fixture',
      schema_hash: 'fixture',
    },
  ).job;
  store.nightshift.acknowledge(job.id, 'remote-' + job.id);
  if (terminal) {
    store.nightshift.observation(job.id, 'remote-' + job.id, {
      remote_id: 'remote-' + job.id,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    });
    store.nightshift.capture(
      job.id,
      'remote-' + job.id,
      {
        text: 'Unreviewed candidate; independent checking remains required.',
        attempts: [],
        winner_seq: null,
        retrieval_error: null,
        truncated: false,
      },
      { status: 'unknown', basis: null, explanation: null },
    );
  }
  store.stop(task.id, 'timed_out', 'fixture_expiry', 'Original run expired.');
  task = store.read(task.id, identity);
  const admitted = store.linkedRuns.admit({
    task_id: task.id,
    identity,
    predecessor_run_id: task.current_run_id,
    objective_revision: task.objective_revision,
    actor: { kind: 'user', id: identity.principal },
    mode: 'manual',
    trigger_cursor: 1,
    delivery_ids: [],
    dependencies: [
      {
        job_id: job.id,
        required: true,
        source_wait_id: null,
        delivery_id: null,
      },
    ],
  });
  if (!('run_id' in admitted))
    throw new Error('Fixture manual admission unexpectedly queued.');
  task = store.read(task.id, identity);
  const assignment = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'HazeOps',
        definition_id: 'fixture.transfer-consumer',
        definition_version: 'fixture',
        capability: 'fixture',
        brief: 'Inspect the explicitly delegated candidate.',
        tools: ['nightshift.result'],
        input: { nightshift_job_ids: [job.id] },
      },
    ],
  )[0]!;
  const leased = store.acquireAssignment(task.id, assignment.id)!;
  task = store.read(task.id, identity);
  const authority: GraphAuthority = {
    task_id: task.id,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
    assignment_id: assignment.id,
    assignment_revision: assignment.revision,
  };
  return { store, task, chain, job, assignment: leased, authority };
}
describe('explicit successor inbox delegation', () => {
  it('retains required predecessor work and shows manual transfer lineage without supplied delivery IDs', () => {
    const f = fixture();
    expect(() =>
      f.store.nightshiftTransfers.assertFinalizable(f.authority),
    ).toThrow('Required predecessor work');
    const inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      job_id: f.job.id,
      target_run_id: f.task.current_run_id,
      required: true,
      resolved: false,
      requires_independent_review: true,
    });
    expect(
      f.store.nightshift.automationView(f.chain.id, identity).inbox[0],
    ).toMatchObject({
      job_id: f.job.id,
      required: true,
      delivered_to_run_id: f.task.current_run_id,
      original_run_id: f.job.authority.run_id,
    });
    expect(f.store.nightshift.job(f.job.id, identity).authority).toEqual(
      f.job.authority,
    );
  });
  it('rejects wrong assignment, revision, generation and workspace without granting result authority', () => {
    const f = fixture();
    const captured = f.store.nightshift.job(f.job.id, identity);
    expect(
      f.store.nightshiftTransfers.authorized(f.authority, captured, identity),
    ).toBe(true);
    expect(
      f.store.nightshiftTransfers.authorized(
        { ...f.authority, assignment_id: randomUUID() },
        captured,
        identity,
      ),
    ).toBe(false);
    expect(
      f.store.nightshiftTransfers.authorized(
        { ...f.authority, assignment_revision: 2 },
        captured,
        identity,
      ),
    ).toBe(false);
    expect(
      f.store.nightshiftTransfers.authorized(
        { ...f.authority, generation: f.task.generation + 1 },
        captured,
        identity,
      ),
    ).toBe(false);
    expect(() =>
      f.store.nightshiftTransfers.authorized(f.authority, captured, {
        ...identity,
        workspace: 'another-workspace',
      }),
    ).toThrow();
    expect(() =>
      f.store.createAssignments(
        f.task.id,
        f.task.current_run_id,
        f.task.objective_revision,
        [
          {
            role: 'HazeOps',
            definition_id: 'fixture.invalid-transfer',
            definition_version: 'fixture',
            capability: 'fixture',
            brief: 'Invalid handle.',
            tools: ['nightshift.result'],
            input: { nightshift_job_ids: [randomUUID()] },
          },
        ],
      ),
    ).toThrow('not delegated');
  });
  it('cannot clear a required transfer with an arbitrary decision or before controlled terminal consumption', () => {
    const f = fixture(false);
    expect(() =>
      f.store.nightshiftTransfers.resolve(
        f.authority,
        f.job.id,
        identity,
        'invented-decision',
      ),
    ).toThrow();
    expect(() =>
      f.store.nightshiftTransfers.resolve(
        f.authority,
        f.job.id,
        identity,
        'supported_failure',
      ),
    ).toThrow();
    expect(() =>
      f.store.nightshiftTransfers.assertFinalizable(f.authority),
    ).toThrow('Required predecessor work');
    expect(
      f.store.nightshiftTransfers.inbox(f.task.id, identity)[0]?.resolved,
    ).toBe(false);
  });
  it('requires the exact controlled dependency decision and rebinds only the resumed current specialist', () => {
    const f = fixture();
    const after = f.store.events(f.task.id, identity).next_cursor;
    f.store.externalWaits.wait(
      {
        ...f.authority,
        assignment_id: f.assignment.id,
        assignment_revision: f.assignment.revision,
        thread_id: graphThreadId('assignment', f.authority),
        after_cursor: after,
        dependencies: [{ job_id: f.job.id, required: true }],
      },
      identity,
    );
    f.store.graph.park({
      ...f.authority,
      kind: 'assignment',
      thread_id: graphThreadId('assignment', f.authority),
      cursor: after,
      after_cursor: after,
      event_types: ['external_result_ready'],
    });
    f.store.externalWaits.resolve(
      f.job.id,
      {
        ...f.authority,
        assignment_id: f.assignment.id,
        assignment_revision: f.assignment.revision,
      },
      identity,
      {
        decision: 'use_candidate',
        reason: 'Inspect unreviewed bytes under exact current authority.',
      },
    );
    f.store.nightshiftTransfers.resolve(
      f.authority,
      f.job.id,
      identity,
      'use_candidate',
    );
    expect(() =>
      f.store.nightshiftTransfers.assertFinalizable(f.authority),
    ).not.toThrow();
    let current = f.store.read(f.task.id, identity);
    f.store.control(current.id, identity, randomUUID(), {
      schema_version: 'haze.task.control.v3',
      ...fence(current),
      action: 'pause',
    });
    current = f.store.read(current.id, identity);
    f.store.nightshift.controlChain(
      f.chain.id,
      {
        schema_version: 'haze.nightshift.chain.control.v1',
        ...fence(current),
        expected_chain_revision: f.store.nightshift.chain(f.chain.id, identity)
          .revision,
        action: 'resume',
      },
      randomUUID(),
      identity,
    );
    f.store.control(current.id, identity, randomUUID(), {
      schema_version: 'haze.task.control.v3',
      ...fence(current),
      action: 'resume',
    });
    const leased = f.store.acquireAssignment(current.id, f.assignment.id)!;
    current = f.store.read(current.id, identity);
    const resumed = { ...f.authority, generation: current.generation };
    expect(leased.generation).toBe(current.generation);
    expect(
      f.store.nightshiftTransfers.authorized(
        f.authority,
        f.store.nightshift.job(f.job.id, identity),
        identity,
      ),
    ).toBe(false);
    expect(
      f.store.nightshiftTransfers.authorized(
        resumed,
        f.store.nightshift.job(f.job.id, identity),
        identity,
      ),
    ).toBe(true);
    const recovered = f.store.externalWaits.candidateContext(resumed, identity);
    expect(recovered.map((item) => item.job_id)).toEqual([f.job.id]);
    const retained = f.store.saveArtifact(current.id, identity, {
      kind: 'fixture.recovered-candidate-draft',
      content: { summary: 'Materially informed by the retained candidate.' },
      producer: { kind: 'assignment', id: f.assignment.id },
      generation: current.generation,
      assignment_revision: f.assignment.revision,
    });
    expect(retained.external_candidates).toEqual([recovered[0]!.artifact]);
    expect(
      (
        f.store.db
          .prepare('SELECT count(*) n FROM external_result_deliveries')
          .get() as { n: number }
      ).n,
    ).toBe(1);
    f.store.db
      .prepare('DELETE FROM graph_waits WHERE thread_id=?')
      .run(graphThreadId('assignment', resumed));
    // A terminal result tool can recover through the accepted control event
    // even when it never needed an interrupt checkpoint.
    expect(
      f.store.externalWaits
        .candidateContext(resumed, identity)
        .map((item) => item.job_id),
    ).toEqual([f.job.id]);
  });
  it('recovers consumed terminal candidates without a GraphWait and preserves their derived provenance', () => {
    const f = fixture(),
      after = f.store.events(f.task.id, identity).next_cursor;
    f.store.externalWaits.wait(
      {
        ...f.authority,
        assignment_id: f.assignment.id,
        assignment_revision: f.assignment.revision,
        thread_id: graphThreadId('assignment', f.authority),
        after_cursor: after,
        dependencies: [{ job_id: f.job.id, required: true }],
      },
      identity,
    );
    f.store.externalWaits.resolve(
      f.job.id,
      {
        ...f.authority,
        assignment_id: f.assignment.id,
        assignment_revision: f.assignment.revision,
      },
      identity,
      {
        decision: 'use_candidate',
        reason: 'Inspect exact unreviewed terminal output.',
      },
    );
    f.store.nightshiftTransfers.resolve(
      f.authority,
      f.job.id,
      identity,
      'use_candidate',
    );
    const usage = f.store.read(f.task.id, identity).usage;
    const count = (
      f.store.db
        .prepare('SELECT count(*) n FROM external_result_deliveries')
        .get() as { n: number }
    ).n;
    expect(
      f.store.graph.wait(graphThreadId('assignment', f.authority)),
    ).toBeUndefined();
    f.store.close();
    const recovered = new TaskStore(f.store.directory);
    stores.push(recovered);
    const task = recovered.read(f.task.id, identity),
      leased = recovered.acquireAssignment(task.id, f.assignment.id)!;
    const authority = { ...f.authority, generation: task.generation };
    expect(leased.generation).toBe(task.generation);
    const candidates = recovered.externalWaits.candidateContext(
      authority,
      identity,
    );
    expect(candidates.map((item) => item.job_id)).toEqual([f.job.id]);
    expect(() =>
      recovered.externalWaits.candidateContext(
        { ...authority, assignment_revision: leased.revision + 1 },
        identity,
      ),
    ).toThrow('assignment revision');
    expect(() =>
      recovered.externalWaits.candidateContext(
        { ...authority, objective_revision: task.objective_revision + 1 },
        identity,
      ),
    ).toThrow('objective revision');
    expect(recovered.read(task.id, identity).usage).toEqual(usage);
    const artifact = recovered.saveArtifact(task.id, identity, {
      kind: 'fixture.recovered-draft',
      content: { text: 'Retained candidate remains unreviewed.' },
      producer: { kind: 'assignment', id: leased.id },
      generation: task.generation,
      assignment_revision: leased.revision,
    });
    expect(artifact.external_candidates).toEqual([candidates[0]!.artifact]);
    expect(artifact.required_tools).toContain('nightshift.result');
    expect(
      (
        recovered.db
          .prepare('SELECT count(*) n FROM external_result_deliveries')
          .get() as { n: number }
      ).n,
    ).toBe(count);
    const grant = recovered.nightshift.chain(f.chain.id, identity);
    recovered.nightshift.controlChain(
      grant.id,
      {
        schema_version: 'haze.nightshift.chain.control.v1',
        ...fence(recovered.read(task.id, identity)),
        expected_chain_revision: grant.revision,
        action: 'close',
      },
      'close-grant',
      identity,
    );
    expect(
      recovered.externalWaits.candidateContext(authority, identity),
    ).toEqual([]);
  });
});
