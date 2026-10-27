import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  taskRequestSchema,
  type TaskRecord,
  type TaskIdentity,
} from '../../app/contracts/tasks.js';
import type {
  NightshiftChain,
  NightshiftJob,
} from '../../app/contracts/nightshift-records.js';
import type { NightshiftRemoteResult } from '../../app/contracts/nightshift.js';

const identity: TaskIdentity = {
  principal: 'local-user',
  workspace: 'local-workspace',
};
const stores: TaskStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of dirs.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
});
function open(directory?: string) {
  const target =
    directory ?? mkdtempSync(join(tmpdir(), 'haze-nightshift-store-'));
  if (!directory) dirs.push(target);
  const store = new TaskStore(target, { recover: false });
  stores.push(store);
  return store;
}
const authority = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
function task(store: TaskStore) {
  return store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Retain a candidate for manual independent review.',
    }),
    identity,
    'task',
    {
      limits: {
        deadline: new Date(Date.now() + 60_000).toISOString(),
        max_artifacts: 8,
        max_model_calls: 8,
        max_tool_calls: 8,
        max_assignments: 8,
      },
    },
  ).task;
}
function chain(store: TaskStore, task: TaskRecord, totalRuns = 1) {
  return store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: task.id,
      ...authority(task),
      total_runs: totalRuns,
    },
    'chain',
    identity,
  ).chain;
}
const adapter = {
  adapter_version: 'fixture.v1',
  runtime_version: 'runtime.fixture',
  schema_hash: 'schema.fixture',
};
function request(task: TaskRecord, chain: NightshiftChain) {
  return {
    schema_version: 'haze.nightshift.job.submit.v1',
    chain_id: chain.id,
    ...authority(task),
    expected_chain_revision: chain.revision,
    prompt: 'Draft an alternative explanation without inventing measurements.',
    input_refs: [],
    n: 4,
    role: 'Manager',
  };
}
function submit(
  store: TaskStore,
  task: TaskRecord,
  chain: NightshiftChain,
  key = 'job',
) {
  return store.nightshift.reserveJob(
    request(task, chain),
    key,
    identity,
    adapter,
  ).job;
}
function result(
  text = 'A derived candidate with uncertainty.',
): NightshiftRemoteResult {
  return {
    text,
    attempts: [
      {
        seq: 0,
        lane: null,
        model: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        finish_reason: null,
        receipt_id: null,
        prompt_sha256: null,
      },
    ],
    winner_seq: 0,
    retrieval_error: null,
    truncated: false,
  };
}
const outcome = {
  status: 'accepted' as const,
  basis: 'runtime judge only',
  explanation: null,
};
function finish(store: TaskStore, job: NightshiftJob) {
  store.nightshift.acknowledge(job.id, `remote-${job.id}`);
  store.nightshift.observation(
    job.id,
    `remote-${job.id}`,
    {
      remote_id: `remote-${job.id}`,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 4,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    },
    outcome,
  );
  return store.nightshift.capture(
    job.id,
    `remote-${job.id}`,
    result(),
    outcome,
  );
}
function control(
  store: TaskStore,
  task: TaskRecord,
  action: 'pause' | 'continue' | 'cancel' | 'revoke' | 'resume',
) {
  return store.control(task.id, identity, `${action}-${task.generation}`, {
    schema_version: 'haze.task.control.v3',
    ...authority(task),
    action,
  });
}

describe('Nightshift durable grants and candidate inbox', () => {
  it('enrollment includes existing Haze charges and cannot enlarge the current run limits', () => {
    const store = open();
    let admitted = task(store);
    const row = store.db
      .prepare('SELECT body FROM runs WHERE id=?')
      .get(admitted.current_run_id) as { body: string };
    const run = JSON.parse(row.body) as TaskRecord['runs'][number];
    run.usage = { model_calls: 7, tool_calls: 2, assignments: 3, artifacts: 2 };
    store.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify(run), run.id);
    admitted = store.read(admitted.id, identity);
    const original = JSON.stringify(admitted.limits);
    const grant = chain(store, admitted);
    expect(grant.usage).toMatchObject({
      model_calls: 7,
      tool_calls: 2,
      assignments: 3,
      artifacts: 2,
    });
    expect(grant.remaining.model_calls).toBe(1);
    expect(JSON.stringify(store.read(admitted.id, identity).limits)).toBe(
      original,
    );
    expect(() =>
      store.nightshift.assertResource(run.id, 'model_calls', 2),
    ).toThrow('cumulative');
  });
  it('reserves before dispatch, enforces capacity, and replays local deliveries without enlarging grants', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const original = request(admitted, grant);
    const first = store.nightshift.reserveJob(
      original,
      'same',
      identity,
      adapter,
    );
    expect(first.reused).toBe(false);
    expect(
      store.nightshift.chain(grant.id, identity).usage.requested_attempts,
    ).toBe(4);
    store.nightshift.acknowledge(first.job.id, 'remote-first');
    const replay = store.nightshift.submissionForKey(
      original,
      'same',
      identity,
    );
    expect(replay?.job.remote_id).toBe('remote-first');
    expect(replay?.reused).toBe(true);
    expect(() =>
      store.nightshift.submissionForKey(
        { ...original, prompt: 'changed' },
        'same',
        identity,
      ),
    ).toThrow('different content');
    const fresh = store.nightshift.chain(grant.id, identity);
    submit(store, admitted, fresh, 'second');
    expect(() =>
      submit(
        store,
        admitted,
        store.nightshift.chain(grant.id, identity),
        'third',
      ),
    ).toThrow('capacity');
    expect(() =>
      store.db
        .prepare('UPDATE ns_grants SET body=body WHERE chain_id=?')
        .run(grant.id),
    ).toThrow('immutable');
  });
  it('fences unacknowledged submission after restart and never infers identity from a similar job', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.markDispatched(job.id);
    const directory = store.directory;
    store.close();
    const restarted = open(directory);
    restarted.nightshift.recoverIntents();
    const unknown = restarted.nightshift.job(job.id, identity);
    expect(unknown.execution_state).toBe('submission_unknown');
    expect(
      restarted.nightshift.chain(grant.id, identity).usage.requested_attempts,
    ).toBe(4);
    expect(() => restarted.nightshift.markDispatched(job.id)).toThrow(
      'repeated',
    );
    const reconcile = {
      schema_version: 'haze.nightshift.job.reconcile.v1',
      ...authority(restarted.read(admitted.id, identity)),
      expected_chain_revision: restarted.nightshift.chain(grant.id, identity)
        .revision,
      expected_job_revision: unknown.revision,
      remote_id: 'similar',
    };
    expect(() =>
      restarted.nightshift.reconcile(job.id, reconcile, 'reconcile', identity, {
        ownership_verified: false,
        request_fingerprint: job.request_fingerprint,
      }),
    ).toThrow('not verified');
  });
  it('late capture after cancellation retains original provenance without current applicability or replacement charges', () => {
    const store = open();
    let admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, `remote-${job.id}`);
    control(store, admitted, 'cancel');
    admitted = store.read(admitted.id, identity);
    const before = JSON.stringify(admitted);
    const captured = store.nightshift.capture(
      job.id,
      `remote-${job.id}`,
      result(),
      outcome,
    );
    const artifact = store.artifact(captured.receipt!.artifact.id, identity);
    expect(artifact.run_id).toBe(job.authority.run_id);
    expect(artifact.objective_revision).toBe(job.authority.objective_revision);
    expect(artifact.producer).toEqual({ kind: 'service', id: 'Nightshift' });
    expect(artifact.evidence_origin).toBe('derived');
    expect(
      store.db
        .prepare(
          'SELECT body FROM applicability WHERE task_id=? AND artifact_id=?',
        )
        .get(admitted.id, artifact.id),
    ).toBeUndefined();
    expect(JSON.stringify(store.read(admitted.id, identity))).toBe(before);
    store.nightshift.capture(
      job.id,
      `remote-${job.id}`,
      result('changed duplicate output'),
      outcome,
    );
    expect(
      (
        store.db.prepare('SELECT COUNT(*) count FROM ns_deliveries').get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(() =>
      store.nightshift.select(
        job.id,
        {
          schema_version: 'haze.nightshift.job.select.v1',
          ...authority(admitted),
          expected_chain_revision: store.nightshift.chain(grant.id, identity)
            .revision,
          expected_job_revision: store.nightshift.job(job.id, identity)
            .revision,
          candidate: captured.receipt!.artifact,
          input_refs: [],
        },
        'select',
        identity,
      ),
    ).toThrow();
  });
  it('keeps cancellation capacity until verified termination and fences duplicate cancellation dispatch', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, 'remote-cancel');
    const current = store.nightshift.job(job.id, identity);
    store.nightshift.cancellationIntent(
      job.id,
      {
        schema_version: 'haze.nightshift.job.cancel.v1',
        ...authority(admitted),
        expected_chain_revision: store.nightshift.chain(grant.id, identity)
          .revision,
        expected_job_revision: current.revision,
      },
      'cancel',
      identity,
    );
    expect(store.nightshift.markCancellationDispatched(job.id)).toBe(true);
    expect(store.nightshift.markCancellationDispatched(job.id)).toBe(false);
    store.nightshift.cancellationAcknowledged(job.id);
    expect(
      (
        store.db
          .prepare('SELECT capacity_held FROM ns_reservations WHERE job_id=?')
          .get(job.id) as { capacity_held: number }
      ).capacity_held,
    ).toBe(1);
    store.nightshift.observation(job.id, 'remote-cancel', {
      remote_id: 'remote-cancel',
      execution_state: 'cancelled',
      terminal: true,
      generated: null,
      requested_attempts: 4,
      privacy: null,
      fleet: null,
      runtime_version: null,
    });
    expect(
      (
        store.db
          .prepare('SELECT capacity_held FROM ns_reservations WHERE job_id=?')
          .get(job.id) as { capacity_held: number }
      ).capacity_held,
    ).toBe(0);
  });
  it('Continue consumes the same immutable run grant and cannot refresh expiry or route identities', () => {
    const store = open();
    let admitted = task(store);
    const grant = chain(store, admitted, 2);
    control(store, admitted, 'pause');
    admitted = store.read(admitted.id, identity);
    store.nightshift.controlChain(
      grant.id,
      {
        schema_version: 'haze.nightshift.chain.control.v1',
        ...authority(admitted),
        expected_chain_revision: store.nightshift.chain(grant.id, identity)
          .revision,
        action: 'resume',
      },
      'resume-grant-for-explicit-continue',
      identity,
    );
    control(store, admitted, 'continue');
    admitted = store.read(admitted.id, identity);
    const current = store.nightshift.chain(grant.id, identity);
    expect(current.usage.runs).toBe(2);
    expect(current.remaining.runs).toBe(0);
    expect(current.expires_at).toBe(grant.expires_at);
    expect(current.grant.route_ids).toEqual(grant.grant.route_ids);
    control(store, admitted, 'pause');
    admitted = store.read(admitted.id, identity);
    store.nightshift.controlChain(
      grant.id,
      {
        schema_version: 'haze.nightshift.chain.control.v1',
        ...authority(admitted),
        expected_chain_revision: store.nightshift.chain(grant.id, identity)
          .revision,
        action: 'resume',
      },
      'resume-grant-before-quota-check',
      identity,
    );
    expect(() => control(store, admitted, 'continue')).toThrow('run allowance');
  });
  it('explicit selection retains an unreviewed exact dependency without an artifact or automatic task effect', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const captured = finish(store, submit(store, admitted, grant));
    const before = JSON.stringify(store.read(admitted.id, identity));
    const selection = store.nightshift.select(
      captured.id,
      {
        schema_version: 'haze.nightshift.job.select.v1',
        ...authority(admitted),
        expected_chain_revision: store.nightshift.chain(grant.id, identity)
          .revision,
        expected_job_revision: captured.revision,
        candidate: captured.receipt!.artifact,
        input_refs: [],
      },
      'select',
      identity,
    );
    expect(selection.requires_independent_review).toBe(true);
    expect(JSON.stringify(store.read(admitted.id, identity))).toBe(before);
    expect(store.nightshift.job(captured.id, identity).review_status).toBe(
      'unreviewed',
    );
  });
  it('exposes selected text only to the exact current critic and blocks ordinary context/applicability bypasses', () => {
    const store = open();
    let admitted = task(store);
    const grant = chain(store, admitted);
    const captured = finish(store, submit(store, admitted, grant));
    const candidate = captured.receipt!.artifact;
    expect(() =>
      store.admit(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: 'Use the generated draft.',
          context_refs: [candidate],
        }),
        identity,
        'bypass',
      ),
    ).toThrow('explicit selection');
    expect(() =>
      store.recordApplicability(
        admitted.id,
        identity,
        candidate,
        true,
        'Treat judge as approval',
        'Manager',
      ),
    ).toThrow('explicit selection');
    const assignments = store.createAssignments(
      admitted.id,
      admitted.current_run_id,
      admitted.objective_revision,
      [
        {
          role: 'EvidenceCritic',
          definition_id: 'test.review',
          capability: 'test',
          definition_version: '1',
          brief: 'Independently review the selected candidate.',
          inputs: [candidate],
          max_model_calls: 4,
        },
        {
          role: 'Manager',
          definition_id: 'test.manager',
          capability: 'test',
          definition_version: '1',
          brief: 'Observe exact candidate metadata only.',
        },
      ],
    );
    const critic = assignments[0]!;
    const manager = assignments[1]!;
    admitted = store.read(admitted.id, identity);
    expect(
      store.nightshift.selectedDependencies(
        admitted.id,
        admitted.current_run_id,
        admitted.generation,
        admitted.objective_revision,
        critic.id,
        critic.revision,
        critic.role,
      ),
    ).toEqual([]);
    store.nightshift.select(
      captured.id,
      {
        schema_version: 'haze.nightshift.job.select.v1',
        ...authority(admitted),
        expected_chain_revision: store.nightshift.chain(grant.id, identity)
          .revision,
        expected_job_revision: captured.revision,
        candidate,
        input_refs: [],
      },
      'selection',
      identity,
    );
    const criticInputs = store.nightshift.selectedDependencies(
      admitted.id,
      admitted.current_run_id,
      admitted.generation,
      admitted.objective_revision,
      critic.id,
      critic.revision,
      critic.role,
    );
    expect(criticInputs[0]).toMatchObject({
      artifact: candidate,
      text: 'A derived candidate with uncertainty.',
      requires_independent_review: true,
    });
    const managerInputs = store.nightshift.selectedDependencies(
      admitted.id,
      admitted.current_run_id,
      admitted.generation,
      admitted.objective_revision,
      manager.id,
      manager.revision,
      manager.role,
    );
    expect(managerInputs[0]?.text).toBeUndefined();
    const acquired = store.acquireAssignment(admitted.id, critic.id)!;
    const review = store.saveArtifact(admitted.id, identity, {
      kind: 'test.review',
      producer: { kind: 'assignment', id: critic.id },
      generation: acquired.generation,
      assignment_revision: acquired.revision,
      content: {
        note: 'Unreviewed candidate examined; numerical/scientific approval is not established.',
      },
      dependencies: [candidate],
    });
    expect(review.dependencies).toEqual([candidate]);
    expect(
      store.db
        .prepare(
          'SELECT body FROM applicability WHERE task_id=? AND artifact_id=?',
        )
        .get(admitted.id, candidate.id),
    ).toBeUndefined();
    admitted = store.read(admitted.id, identity);
    control(store, admitted, 'pause');
    admitted = store.read(admitted.id, identity);
    expect(
      store.nightshift.selectedDependencies(
        admitted.id,
        admitted.current_run_id,
        admitted.generation,
        admitted.objective_revision,
        critic.id,
        critic.revision,
        critic.role,
      ),
    ).toEqual([]);
  });
  it('oversized output is a visible retrieval failure and cannot become a candidate', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, 'oversized');
    const captured = store.nightshift.capture(
      job.id,
      'oversized',
      result('x'.repeat(65_537)),
      outcome,
    );
    expect(captured.receipt).toBeNull();
    expect(captured.retrieval_error?.code).toBe('result_retrieval_failed');
    expect(
      (
        store.db.prepare('SELECT COUNT(*) count FROM ns_deliveries').get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });
  it('expired grants retain late receipts and their reservations without allowing selection or new submission', () => {
    const store = open();
    const admitted = task(store);
    const initial = chain(store, admitted);
    const job = submit(store, admitted, initial);
    store.nightshift.acknowledge(job.id, 'expired-late');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 86_401_000);
    const expired = store.nightshift.chain(initial.id, identity);
    expect(expired.status).toBe('expired');
    const captured = store.nightshift.capture(
      job.id,
      'expired-late',
      result(),
      outcome,
    );
    expect(captured.receipt?.artifact).toBeDefined();
    expect(expired.usage.requested_attempts).toBe(4);
    expect(() => submit(store, admitted, expired, 'after-expiry')).toThrow(
      'expiry',
    );
    expect(() =>
      store.nightshift.select(
        job.id,
        {
          schema_version: 'haze.nightshift.job.select.v1',
          ...authority(admitted),
          expected_chain_revision: expired.revision,
          expected_job_revision: captured.revision,
          candidate: captured.receipt!.artifact,
          input_refs: [],
        },
        'selection',
        identity,
      ),
    ).toThrow('expiry');
  });
  it('missing or mismatched remote privacy cannot become a usable selected dependency', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, 'policy');
    store.nightshift.observation(job.id, 'policy', {
      remote_id: 'policy',
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 4,
      privacy: null,
      fleet: null,
      runtime_version: null,
    });
    const captured = store.nightshift.capture(
      job.id,
      'policy',
      result(),
      outcome,
    );
    expect(captured.receipt).not.toBeNull();
    expect(() =>
      store.nightshift.select(
        job.id,
        {
          schema_version: 'haze.nightshift.job.select.v1',
          ...authority(admitted),
          expected_chain_revision: store.nightshift.chain(grant.id, identity)
            .revision,
          expected_job_revision: captured.revision,
          candidate: captured.receipt!.artifact,
          input_refs: [],
        },
        'selection',
        identity,
      ),
    ).toThrow('policy');
    const terminal = store.nightshift.observation(job.id, 'policy', {
      remote_id: 'policy',
      execution_state: 'running',
      terminal: false,
      generated: 1,
      requested_attempts: 4,
      privacy: 'local-only',
      fleet: null,
      runtime_version: null,
    });
    expect(terminal.execution_state).toBe('completed');
    expect(
      (
        store.db
          .prepare('SELECT capacity_held FROM ns_reservations WHERE job_id=?')
          .get(job.id) as { capacity_held: number }
      ).capacity_held,
    ).toBe(0);
  });
  it('retains safe native failure diagnostics separately from later result or polling failures', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, 'diagnostic');
    const remote = {
      remote_id: 'diagnostic',
      execution_state: 'failed',
      terminal: true,
      generated: 0,
      requested_attempts: 4,
      privacy: 'local-only',
      fleet: null,
      runtime_version: null,
      native_execution_state: 'errored',
      failure_code: 'privacy_floor_refuses_pinned_model',
    };
    store.nightshift.observation(job.id, 'diagnostic', remote);
    store.nightshift.captureFailure(job.id, 'The result is unavailable.', null);
    store.nightshift.pollingFailure(job.id, 'A later read failed.', null);
    const retained = store.nightshift.job(job.id, identity);
    expect(retained.remote_diagnostic).toEqual({
      execution_state: 'errored',
      failure_code: 'privacy_floor_refuses_pinned_model',
    });
    expect(retained.retrieval_error?.code).toBe('observation_failed');
    expect(
      (
        store.db
          .prepare('SELECT capacity_held FROM ns_reservations WHERE job_id=?')
          .get(job.id) as { capacity_held: number }
      ).capacity_held,
    ).toBe(0);
  });
  it('a verified rejection releases reservations while an ambiguous dispatch remains charged', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const first = submit(store, admitted, grant);
    store.nightshift.rejectBeforeAcceptance(
      first.id,
      'Verified schema rejection.',
    );
    const after = store.nightshift.chain(grant.id, identity);
    expect(after.usage.requested_attempts).toBe(0);
    expect(after.usage.retention_reserved).toBe(0);
    const second = submit(store, admitted, after, 'unknown');
    store.nightshift.markDispatched(second.id);
    store.nightshift.submissionUnknown(second.id);
    expect(
      store.nightshift.chain(grant.id, identity).usage.requested_attempts,
    ).toBe(4);
  });
  it('rejects future migrations and preserves the original grant bytes', () => {
    const store = open();
    const admitted = task(store);
    const grant = chain(store, admitted);
    const before = (
      store.db
        .prepare('SELECT body FROM ns_grants WHERE chain_id=?')
        .get(grant.id) as { body: string }
    ).body;
    const directory = store.directory;
    store.db
      .prepare('INSERT INTO nightshift_migrations VALUES(3,?)')
      .run(new Date().toISOString());
    store.close();
    expect(() => new TaskStore(directory, { recover: false })).toThrow(
      'Unsupported Nightshift migration',
    );
    const inspect = new DatabaseSync(join(directory, 'tasks.sqlite'), {
      readOnly: true,
    });
    try {
      expect(
        (
          inspect
            .prepare('SELECT body FROM ns_grants WHERE chain_id=?')
            .get(grant.id) as { body: string }
        ).body,
      ).toBe(before);
    } finally {
      inspect.close();
    }
  });
  it('correction invalidates authority while later receipts remain historical and unknown metadata stays null', () => {
    const store = open();
    let admitted = task(store);
    const grant = chain(store, admitted);
    const job = submit(store, admitted, grant);
    store.nightshift.acknowledge(job.id, 'late');
    store.update(admitted.id, identity, 'correction', {
      schema_version: 'haze.task.update.v3',
      ...authority(admitted),
      kind: 'correction',
      passage: 'The objective now excludes that draft.',
    });
    admitted = store.read(admitted.id, identity);
    expect(store.nightshift.chain(grant.id, identity).status).toBe(
      'invalidated',
    );
    const captured = store.nightshift.capture(
      job.id,
      'late',
      result(),
      outcome,
    );
    expect(captured.authority.objective_revision).toBe(1);
    expect(captured.receipt?.attempts[0]).toMatchObject({
      model: null,
      input_tokens: null,
    });
    expect(admitted.objective_revision).toBe(2);
  });
});
