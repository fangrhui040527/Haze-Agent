import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  taskRequestSchema,
  type TaskRecord,
  type RunRecord,
} from '../../app/contracts/tasks.js';
import {
  chainAdmissionSchema,
  chainControlSchema,
} from '../../app/contracts/nightshift.js';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';

const identity = { principal: 'local-user', workspace: 'local-workspace' };
const stores: TaskStore[] = [],
  directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const local = relative(resolve(tmpdir()), resolve(directory));
    if (!local || local.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function open(directory?: string) {
  const target = directory ?? mkdtempSync(join(tmpdir(), 'haze-auto-grants-'));
  if (!directory) directories.push(target);
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
function source(
  store: TaskStore,
  text = 'Observed source facts; uncertainty remains.',
): ArtifactRef {
  const artifact = store.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'source.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(text).toString('base64'),
    },
    identity,
    randomUUID(),
  ).artifact;
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.sha256,
  };
}
function fixture(store: TaskStore, enable = true) {
  if (enable)
    store.nightshift.configureAutomatic({
      enabled: true,
      evidence_id: 'fixture-only-no-live-readiness-claim',
    });
  const ref = source(store);
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Prepare a bounded evidence-linked draft.',
      context_refs: [ref],
      nightshift_tools: [
        'nightshift.submit',
        'nightshift.result',
        'nightshift.cancel',
      ],
    }),
    identity,
    randomUUID(),
    {
      tools: ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'],
      limits: {
        deadline: new Date(Date.now() + 60_000).toISOString(),
        max_model_calls: 8,
        max_tool_calls: 8,
        max_assignments: 8,
        max_artifacts: 16,
      },
    },
  ).task;
  const progress = {
    schema_version: 'haze.nightshift.progress.v1' as const,
    purpose: 'evidence_linked_draft' as const,
    instruction: 'Prepare an unreviewed draft.',
    unresolved_deliverables: ['objective'],
    input_refs: [ref],
    output_refs: [],
    review_objections: [],
    failure_causes: [],
    last_consumed_result_cursor: 0,
  };
  const request = {
    schema_version: 'haze.nightshift.chain.admission.v2',
    task_id: task.id,
    ...authority(task),
    total_runs: 4,
    automatic_followup_runs: 2,
    automatic_opt_in: true,
    initial_progress: progress,
    privacy: 'local-only',
    max_spend_usd: 0,
  };
  return { task, ref, progress, request };
}
const adapter = {
  adapter_version: 'fixture',
  runtime_version: 'fixture',
  schema_hash: 'fixture',
};
function job(
  store: TaskStore,
  f: ReturnType<typeof fixture>,
  chainId: string,
  key = randomUUID(),
) {
  const chain = store.nightshift.chain(chainId, identity);
  return store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      chain_id: chain.id,
      ...authority(store.read(f.task.id, identity)),
      expected_chain_revision: chain.revision,
      prompt: 'Unreviewed source-linked candidate.',
      purpose: 'evidence_linked_draft',
      input_refs: [f.ref],
      n: 1,
      privacy: 'local-only',
      max_spend_usd: 0,
    },
    key,
    identity,
    adapter,
  ).job;
}
function insertRun(
  store: TaskStore,
  task: TaskRecord,
  predecessor: string,
): RunRecord {
  const run: RunRecord = {
    ...task.runs[0]!,
    id: randomUUID(),
    predecessor_run_id: predecessor,
    generation: task.generation + 1,
    usage: { model_calls: 0, tool_calls: 0, assignments: 0, artifacts: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.db
    .prepare('INSERT INTO runs VALUES(?,?,?)')
    .run(run.id, task.id, JSON.stringify(run));
  return run;
}

describe('automatic chain immutable grants and progress', () => {
  it('requires explicit bounded v2 opt-in and preserves manual v1 after upgrade', () => {
    const store = open(),
      f = fixture(store, false);
    expect(() =>
      store.nightshift.admitChain(f.request, 'blocked', identity),
    ).toThrow('not released');
    expect(
      chainAdmissionSchema.safeParse({ ...f.request, automatic_opt_in: false })
        .success,
    ).toBe(false);
    expect(
      chainAdmissionSchema.safeParse({
        ...f.request,
        total_runs: 2,
        automatic_followup_runs: 2,
      }).success,
    ).toBe(false);
    const manual = store.nightshift.admitChain(
      {
        schema_version: 'haze.nightshift.chain.admission.v1',
        task_id: f.task.id,
        ...authority(f.task),
        total_runs: 4,
      },
      'manual',
      identity,
    ).chain;
    store.nightshift.configureAutomatic({
      enabled: true,
      evidence_id: 'fixture',
    });
    expect(store.nightshift.automationView(manual.id, identity)).toMatchObject({
      automatic_enabled: false,
      authorized_followups: 0,
    });
    expect(() =>
      store.nightshift.continuation(f.task.current_run_id, 'automatic'),
    ).toThrow('does not authorize');
    expect(
      chainControlSchema.safeParse({
        schema_version: 'haze.nightshift.chain.control.v2',
        ...authority(f.task),
        expected_chain_revision: manual.revision,
        action: 'resume',
        automatic_opt_in: true,
      }).success,
    ).toBe(false);
  });
  it('pins cumulative profile, exact routes and existing charges without changing enrollment limits', () => {
    const store = open(),
      f = fixture(store);
    const before = JSON.stringify(f.task.limits);
    const row = store.db
      .prepare('SELECT body FROM runs WHERE id=?')
      .get(f.task.current_run_id) as { body: string };
    const run = JSON.parse(row.body) as RunRecord;
    run.usage.model_calls = 3;
    run.usage.artifacts = 2;
    store.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify(run), run.id);
    const chain = store.nightshift.admitChain(
      f.request,
      'enroll',
      identity,
    ).chain;
    expect(chain).toMatchObject({
      schema_version: 'haze.nightshift.chain.v2',
      grant: {
        total_runs: 4,
        automatic_followup_runs: 2,
        max_model_calls: 32,
        max_tool_calls: 32,
        max_assignments: 32,
        max_artifacts: 64,
      },
      usage: { model_calls: 3, artifacts: 2 },
      remaining: { model_calls: 29 },
    });
    expect(JSON.stringify(store.read(f.task.id, identity).limits)).toBe(before);
    expect(() =>
      store.db
        .prepare('UPDATE ns_grants SET body=? WHERE chain_id=?')
        .run('{}', chain.id),
    ).toThrow('immutable');
    expect(
      store.nightshift.automationView(chain.id, identity).run_profile,
    ).toMatchObject({
      reserved_model_calls: 2,
      max_model_output_tokens: f.task.limits.max_model_output_tokens,
    });
    expect(
      store.nightshift.admitChain(f.request, 'enroll', identity).reused,
    ).toBe(true);
  });
  it('manual and automatic successors share predecessor uniqueness and independent automatic quota', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const first = insertRun(store, f.task, f.task.current_run_id);
    store.nightshift.enrollSuccessor(chain.id, first.id, {
      predecessor_run_id: f.task.current_run_id,
      objective_revision: 1,
      actor: 'user',
      mode: 'manual',
      reason: 'Explicit Continue.',
      cursor: 0,
      delivery_ids: [],
    });
    const duplicate = insertRun(store, f.task, f.task.current_run_id);
    expect(() =>
      store.nightshift.enrollSuccessor(chain.id, duplicate.id, {
        predecessor_run_id: f.task.current_run_id,
        objective_revision: 1,
        actor: 'service',
        mode: 'automatic',
        reason: 'A terminal result is available.',
        cursor: 1,
        delivery_ids: [],
      }),
    ).toThrow('already has');
    expect(
      store.nightshift.successorFor(chain.id, f.task.current_run_id, 1)?.run_id,
    ).toBe(first.id);
    const second = insertRun(store, f.task, first.id);
    store.nightshift.enrollSuccessor(chain.id, second.id, {
      predecessor_run_id: first.id,
      objective_revision: 1,
      actor: 'service',
      mode: 'automatic',
      reason: 'New required result.',
      cursor: 2,
      delivery_ids: [],
    });
    const view = store.nightshift.automationView(chain.id, identity);
    expect(view).toMatchObject({
      admitted_runs: 3,
      used_followups: 1,
      remaining_followups: 1,
      maximum_runs: 4,
    });
    expect(view.lineage.map((item) => item.mode)).toEqual([
      'manual',
      'automatic',
    ]);
    const third = insertRun(store, f.task, second.id);
    store.nightshift.enrollSuccessor(chain.id, third.id, {
      predecessor_run_id: second.id,
      objective_revision: 1,
      actor: 'service',
      mode: 'automatic',
      reason: 'A second permitted result.',
      cursor: 3,
      delivery_ids: [],
    });
    expect(store.nightshift.automationView(chain.id, identity)).toMatchObject({
      admitted_runs: 4,
      used_followups: 2,
      remaining_followups: 0,
    });
    expect(() => store.nightshift.continuation(third.id, 'automatic')).toThrow(
      'automatic follow-up allowance',
    );
    expect(() => store.nightshift.continuation(third.id, 'manual')).toThrow(
      'run allowance',
    );
  });
  it('rejects unchanged prose, output UUIDs and invented deliverables as progress', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const request = {
      schema_version: 'haze.nightshift.chain.progress.proposal.v1',
      ...authority(f.task),
      expected_chain_revision: chain.revision,
      progress: {
        ...f.progress,
        instruction: 'Different prose and a new UUID ' + randomUUID(),
      },
    };
    expect(() =>
      store.nightshift.proposeProgress(
        chain.id,
        request,
        'prose',
        identity,
        'agent',
      ),
    ).toThrow('not useful progress');
    expect(() =>
      store.nightshift.proposeProgress(
        chain.id,
        {
          ...request,
          progress: {
            ...f.progress,
            unresolved_deliverables: ['Invented revised purpose'],
          },
        },
        'deliverable',
        identity,
        'agent',
      ),
    ).toThrow('admitted outstanding');
    expect(() =>
      store.nightshift.proposeProgress(
        chain.id,
        {
          ...request,
          progress: { ...f.progress, last_consumed_result_cursor: 999999 },
        },
        'cursor',
        identity,
        'agent',
      ),
    ).toThrow('server-recorded');
  });
  it('pauses same-purpose repeat jobs without releasing their charges, then accepts exact changed inputs', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const first = job(store, f, chain.id);
    store.nightshift.acknowledge(first.id, 'remote-' + first.id);
    store.nightshift.observation(first.id, 'remote-' + first.id, {
      remote_id: 'remote-' + first.id,
      execution_state: 'failed',
      terminal: true,
      generated: 0,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    });
    expect(() => job(store, f, chain.id)).toThrow('supported changed cause');
    expect(store.nightshift.chain(chain.id, identity)).toMatchObject({
      status: 'paused',
      usage: { jobs: 1, requested_attempts: 1 },
    });
    expect(
      store.nightshift.automationView(chain.id, identity).stops.at(-1)?.code,
    ).toBe('no_progress');
    const stopped = store.nightshift.chain(chain.id, identity);
    expect(() =>
      store.nightshift.controlChain(
        chain.id,
        {
          schema_version: 'haze.nightshift.chain.control.v2',
          ...authority(store.read(f.task.id, identity)),
          expected_chain_revision: stopped.revision,
          action: 'resume',
        },
        'cannot-resume-without-progress',
        identity,
      ),
    ).toThrow('validated refinement');
    const pausedAgain = store.nightshift.controlChain(
      chain.id,
      {
        schema_version: 'haze.nightshift.chain.control.v2',
        ...authority(store.read(f.task.id, identity)),
        expected_chain_revision: stopped.revision,
        action: 'pause',
      },
      'redundant-user-pause',
      identity,
    );
    expect(pausedAgain.stop_reason).toBe(stopped.stop_reason);
    expect(() =>
      store.nightshift.controlChain(
        chain.id,
        {
          schema_version: 'haze.nightshift.chain.control.v2',
          ...authority(store.read(f.task.id, identity)),
          expected_chain_revision: pausedAgain.revision,
          action: 'resume',
        },
        'cannot-resume-after-redundant-pause',
        identity,
      ),
    ).toThrow('validated refinement');
    const ref = source(
      store,
      'A changed exact source with supported additional evidence.',
    );
    store.recordApplicability(
      f.task.id,
      identity,
      ref,
      true,
      'Fixture explicitly revalidated the new exact source.',
      'Runtime',
    );
    const paused = store.nightshift.chain(chain.id, identity);
    store.nightshift.proposeProgress(
      chain.id,
      {
        schema_version: 'haze.nightshift.chain.progress.proposal.v1',
        ...authority(store.read(f.task.id, identity)),
        expected_chain_revision: paused.revision,
        progress: { ...f.progress, input_refs: [ref] },
      },
      'new-input',
      identity,
      'agent',
    );
    expect(store.nightshift.chain(chain.id, identity).status).toBe('active');
    expect(
      store.nightshift.progress(chain.id, identity)?.progress.input_refs,
    ).toEqual([ref]);
  });
  it('re-enforces a duplicate accepted stop without duplicating records or refreshing the grant', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const stop = {
      code: 'no_progress',
      message: 'Identical admitted work has no supported changed cause.',
      cursor: 0,
      refs: [f.ref],
    };
    store.nightshift.stopAutomatic(chain.id, stop);
    const original = store.nightshift.chain(chain.id, identity);
    const accepted = store.nightshift.automationView(chain.id, identity).stops;
    const eventCursor = store.events(f.task.id, identity, 0).next_cursor;
    const taskUsage = store.read(f.task.id, identity).usage;
    // Recreate the mutable state left by the old pause/Resume bypass. The
    // immutable stop ledger remains the authority when the same fence returns.
    store.db
      .prepare('UPDATE ns_chains SET body=? WHERE id=?')
      .run(
        JSON.stringify({ ...original, status: 'active', stop_reason: null }),
        chain.id,
      );
    store.nightshift.stopAutomatic(chain.id, {
      ...stop,
      message: 'Redelivery must not rewrite the accepted explanation.',
    });
    const restored = store.nightshift.chain(chain.id, identity);
    expect(restored).toMatchObject({
      status: 'paused',
      stop_reason: original.stop_reason,
      expires_at: original.expires_at,
      grant: original.grant,
      usage: original.usage,
      remaining: original.remaining,
    });
    expect(store.nightshift.automationView(chain.id, identity).stops).toEqual(
      accepted,
    );
    expect(store.events(f.task.id, identity, eventCursor).events).toEqual([]);
    expect(store.read(f.task.id, identity).usage).toEqual(taskUsage);
    expect(
      store.db
        .prepare('SELECT COUNT(*) count FROM ns_chain_stops WHERE chain_id=?')
        .get(chain.id),
    ).toMatchObject({ count: 1 });
    store.nightshift.stopAutomatic(chain.id, stop);
    expect(store.nightshift.chain(chain.id, identity)).toEqual(restored);
  });
  it('duplicate observational stops preserve an independent user pause and never reopen a closed grant', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const stop = {
      code: 'automatic_followups_exhausted',
      message: 'Only separately authorized manual authority remains.',
      cursor: 0,
      refs: [],
      status: 'active' as const,
    };
    store.nightshift.stopAutomatic(chain.id, stop);
    const control = (action: 'pause' | 'close') =>
      store.nightshift.controlChain(
        chain.id,
        {
          schema_version: 'haze.nightshift.chain.control.v2',
          ...authority(store.read(f.task.id, identity)),
          expected_chain_revision: store.nightshift.chain(chain.id, identity)
            .revision,
          action,
        },
        action,
        identity,
      );
    const paused = control('pause');
    expect(paused.stop_reason).toBe('Manual submission paused.');
    store.nightshift.stopAutomatic(chain.id, stop);
    expect(store.nightshift.chain(chain.id, identity)).toEqual(paused);
    const closed = control('close');
    store.nightshift.stopAutomatic(chain.id, stop);
    expect(store.nightshift.chain(chain.id, identity)).toEqual(closed);
  });
  it('unknown submission and cancellation pending outcomes block further jobs and all continuation paths', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const first = job(store, f, chain.id);
    store.nightshift.submissionUnknown(first.id);
    expect(() => store.nightshift.continuation(f.task.current_run_id)).toThrow(
      'Unknown external',
    );
    expect(() =>
      store.nightshift.continuation(f.task.current_run_id, 'automatic'),
    ).toThrow('Unknown external');
    expect(() => job(store, f, chain.id)).toThrow('reconciliation');
    expect(
      store.nightshift.chain(chain.id, identity).usage.requested_attempts,
    ).toBe(1);
  });
  it('successor slices retain expiry, per-call bounds and synthesis/review reservations', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(
        { ...f.request, lifetime_seconds: 1 },
        'chain',
        identity,
      ).chain;
    const slice = store.nightshift.continuation(
      f.task.current_run_id,
      'automatic',
    )!;
    expect(Date.parse(slice.limits.deadline)).toBeLessThanOrEqual(
      Date.parse(chain.expires_at),
    );
    expect(slice.limits.max_model_input_bytes).toBe(
      f.task.limits.max_model_input_bytes,
    );
    expect(slice.limits.max_model_output_tokens).toBe(
      f.task.limits.max_model_output_tokens,
    );
    const row = store.db
      .prepare('SELECT body FROM runs WHERE id=?')
      .get(f.task.current_run_id) as { body: string };
    const run = JSON.parse(row.body) as RunRecord;
    run.usage.model_calls = chain.grant.max_model_calls - 2;
    store.db
      .prepare('UPDATE runs SET body=? WHERE id=?')
      .run(JSON.stringify(run), run.id);
    expect(() => store.nightshift.continuation(run.id, 'automatic')).toThrow(
      'bounded Haze run',
    );
  });
  it('reopening never grants automatic release and cannot rewrite manual grant counters', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const snapshot = JSON.stringify(
        store.nightshift.chain(chain.id, identity).grant,
      ),
      expiry = chain.expires_at,
      directory = store.directory;
    store.close();
    const recovered = open(directory);
    expect(() =>
      recovered.nightshift.continuation(f.task.current_run_id, 'automatic'),
    ).toThrow('not released');
    expect(
      JSON.stringify(recovered.nightshift.chain(chain.id, identity).grant),
    ).toBe(snapshot);
    expect(recovered.nightshift.chain(chain.id, identity).expires_at).toBe(
      expiry,
    );
  });
  it('duplicate references and new source UUIDs with identical content cannot manufacture useful progress', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const same = source(store);
    store.recordApplicability(
      f.task.id,
      identity,
      same,
      true,
      'Same exact bytes checked.',
      'Runtime',
    );
    const proposal = {
      schema_version: 'haze.nightshift.chain.progress.proposal.v1',
      ...authority(f.task),
      expected_chain_revision: chain.revision,
      progress: { ...f.progress, input_refs: [same, same] },
    };
    expect(same.id).not.toBe(f.ref.id);
    expect(same.sha256).toBe(f.ref.sha256);
    expect(() =>
      store.nightshift.proposeProgress(
        chain.id,
        proposal,
        'duplicates',
        identity,
        'agent',
      ),
    ).toThrow('not useful progress');
  });
  it('records absolute expiry once without extending it or resurrecting queued work', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(
        { ...f.request, lifetime_seconds: 1 },
        'chain',
        identity,
      ).chain;
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(chain.expires_at) + 1);
    expect(store.nightshift.pendingAutomaticChains()).toEqual([]);
    expect(store.nightshift.pendingAutomaticChains()).toEqual([]);
    const view = store.nightshift.automationView(chain.id, identity);
    expect(view.original_expires_at).toBe(chain.expires_at);
    expect(
      view.stops.filter((stop) => stop.code === 'absolute_expiry'),
    ).toHaveLength(1);
    expect(view.admitted_runs).toBe(1);
    expect(() =>
      store.nightshift.continuation(f.task.current_run_id, 'automatic'),
    ).toThrow('expiry');
  });
  it('admits a separately authorized larger grant only after closing its same-owner predecessor grant', () => {
    const store = open(),
      first = fixture(store),
      old = store.nightshift.admitChain(first.request, 'first', identity).chain;
    const next = fixture(store);
    expect(() =>
      store.nightshift.admitChain(
        { ...next.request, previous_chain_id: old.id },
        'must-close',
        identity,
      ),
    ).toThrow('Close the previous grant');
    store.nightshift.controlChain(
      old.id,
      {
        schema_version: 'haze.nightshift.chain.control.v2',
        ...authority(store.read(first.task.id, identity)),
        expected_chain_revision: old.revision,
        action: 'close',
      },
      'close-old',
      identity,
    );
    const current = store.nightshift.admitChain(
      { ...next.request, previous_chain_id: old.id },
      'new-grant',
      identity,
    ).chain;
    expect(
      store.nightshift.automationView(current.id, identity).previous_chain_id,
    ).toBe(old.id);
    expect(store.nightshift.chain(old.id, identity).grant).toEqual(old.grant);
    expect(() =>
      store.nightshift.admitChain(
        { ...next.request, previous_chain_id: old.id },
        'foreign',
        { ...identity, workspace: 'different-workspace' },
      ),
    ).toThrow();
    expect(
      store.nightshift.automationView(current.id, identity).admitted_runs,
    ).toBe(1);
  });
  it('requires verified reconciliation for an actual charged unknown Haze attempt before Resume', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    const assignment = store.createAssignments(
      f.task.id,
      f.task.current_run_id,
      f.task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'fixture.unknown',
          definition_version: 'fixture',
          capability: 'fixture',
          brief: 'Attempt a bounded operation.',
          tools: ['nightshift.result'],
        },
      ],
    )[0]!;
    const leased = store.acquireAssignment(f.task.id, assignment.id)!;
    const expectation = {
      generation: leased.generation,
      assignment_revision: leased.revision,
      lease_token: leased.lease_token!,
    };
    const attempt = store.chargeAttempt(
      f.task.id,
      leased.id,
      'model',
      {},
      expectation,
    );
    store.interruptUnknown(
      f.task.id,
      attempt.id,
      { outcome: 'unknown' },
      expectation,
    );
    const paused = store.read(f.task.id, identity);
    expect(() =>
      store.nightshift.assertResumeAuthority(paused.current_run_id),
    ).toThrow('Verified reconciliation');
    expect(store.nightshift.chain(chain.id, identity).usage.model_calls).toBe(
      1,
    );
    store.nightshift.controlChain(
      chain.id,
      {
        schema_version: 'haze.nightshift.chain.control.v2',
        ...authority(paused),
        expected_chain_revision: store.nightshift.chain(chain.id, identity)
          .revision,
        action: 'pause',
      },
      'pause-unknown-grant',
      identity,
    );
    expect(() =>
      store.nightshift.controlChain(
        chain.id,
        {
          schema_version: 'haze.nightshift.chain.control.v2',
          ...authority(paused),
          expected_chain_revision: store.nightshift.chain(chain.id, identity)
            .revision,
          action: 'resume',
        },
        'resume-unknown-grant',
        identity,
      ),
    ).toThrow('Verified reconciliation');
  });
  it('records permission revocation as a machine-readable closed grant without changing its immutable envelope', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(f.request, 'chain', identity).chain;
    store.control(f.task.id, identity, 'revoke-result', {
      schema_version: 'haze.task.control.v3',
      ...authority(f.task),
      action: 'revoke',
      revoked_tools: ['nightshift.result'],
    });
    const view = store.nightshift.automationView(chain.id, identity);
    expect(view.stops.at(-1)?.code).toBe('permission_revoked');
    expect(store.nightshift.chain(chain.id, identity)).toMatchObject({
      status: 'closed',
      grant: chain.grant,
    });
    expect(() =>
      store.nightshift.assertResumeAuthority(f.task.current_run_id),
    ).toThrow('closed, expired or invalidated');
  });
  it('exhausting only the automatic quota leaves the separately authorized manual run allowance available', () => {
    const store = open(),
      f = fixture(store),
      chain = store.nightshift.admitChain(
        { ...f.request, automatic_followup_runs: 1, total_runs: 4 },
        'chain',
        identity,
      ).chain;
    const successor = insertRun(store, f.task, f.task.current_run_id);
    store.nightshift.enrollSuccessor(chain.id, successor.id, {
      predecessor_run_id: f.task.current_run_id,
      objective_revision: 1,
      actor: 'service',
      mode: 'automatic',
      reason: 'Inspect one new required result.',
      cursor: 1,
      delivery_ids: [],
    });
    store.nightshift.stopAutomatic(chain.id, {
      code: 'automatic_followups_exhausted',
      message:
        'Automatic follow-ups exhausted; explicit user continuation remains subject to the original remaining grant.',
      cursor: 1,
      refs: [],
      status: 'active',
    });
    expect(() =>
      store.nightshift.continuation(successor.id, 'automatic'),
    ).toThrow('automatic follow-up allowance');
    const manual = store.nightshift.continuation(successor.id, 'manual');
    expect(manual?.chain_id).toBe(chain.id);
    const view = store.nightshift.automationView(chain.id, identity);
    expect(view).toMatchObject({
      automatic_enabled: true,
      authorized_followups: 1,
      used_followups: 1,
      remaining_followups: 0,
      admitted_runs: 2,
      maximum_runs: 4,
      next_purpose: null,
    });
    expect(store.nightshift.chain(chain.id, identity)).toMatchObject({
      status: 'active',
      remaining: { runs: 2 },
    });
  });
});
