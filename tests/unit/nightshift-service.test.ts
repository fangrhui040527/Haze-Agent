import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  taskRequestSchema,
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type { NightshiftJob } from '../../app/contracts/nightshift-records.js';
import type {
  NightshiftJobReadiness,
  NightshiftRemoteJob,
  NightshiftSubmitRequest,
} from '../../app/contracts/nightshift.js';
import {
  NightshiftJobTransportError,
  type NightshiftJobPort,
} from '../../app/orchestration/ports.js';
import { TaskStore } from '../../app/tasks/store.js';
import { NightshiftJobService } from '../../app/tasks/nightshift-service.js';
import {
  automaticReadinessSchema,
  automaticReleaseBlocked,
  INITIAL_AUTOMATIC_SCOPE,
  type AutomaticReleasePolicy,
} from '../../app/contracts/nightshift-automatic.js';

const identity: TaskIdentity = {
  principal: 'local-user',
  workspace: 'local-workspace',
};
const paths: string[] = [];
const stores: TaskStore[] = [];
const services: NightshiftJobService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const path of paths.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(path));
    if (!inside || inside.startsWith('..'))
      throw new Error('Unsafe test cleanup path.');
    rmSync(path, { recursive: true, force: true });
  }
});
function port(overrides: Partial<NightshiftJobPort> = {}) {
  const ready: NightshiftJobReadiness = {
    schema_version: 'haze.nightshift.jobs.readiness.v1',
    checked_at: new Date().toISOString(),
    cli_available: true,
    schema_compatible: true,
    runtime_reachable: true,
    local_only_enforced: true,
    cloud_enforced: false,
    ready: true,
    runtime_version: 'fixture-only',
    adapter_version: 'fixture-only',
    schema_hash: 'fixture-schema',
    can_reconcile: false,
    cancellation_idempotent: false,
    reason: null,
    options: {
      judges: ['accuracy'],
      budgets: ['low'],
      windows: ['now', 'quiet'],
      fleets: ['fixture-fleet'],
      max_attempts: 16,
    },
  };
  const remote: NightshiftRemoteJob = {
    remote_id: 'remote-1',
    execution_state: 'running',
    terminal: false,
    generated: 0,
    requested_attempts: 4,
    privacy: 'local-only',
    fleet: null,
    runtime_version: 'fixture-only',
  };
  return {
    readiness: vi.fn(() => Promise.resolve(ready)),
    submit: vi.fn(() => Promise.resolve({ remote_id: 'remote-1' })),
    inspect: vi.fn(() => Promise.resolve(remote)),
    outcome: vi.fn(() =>
      Promise.resolve({
        status: 'accepted' as const,
        basis: 'synthetic judge',
        explanation: null,
      }),
    ),
    result: vi.fn(() =>
      Promise.resolve({
        text: 'Synthetic draft; independent review required.',
        attempts: [],
        winner_seq: null,
        retrieval_error: null,
        truncated: false as const,
      }),
    ),
    cancel: vi.fn(() => Promise.resolve({ acknowledged: true })),
    verifyReconciliation: vi.fn(() =>
      Promise.resolve({ verified: false, reason: null }),
    ),
    ...overrides,
  } satisfies NightshiftJobPort;
}
function setup(
  adapter: NightshiftJobPort,
  existing?: string,
  automaticReadiness?: AutomaticReleasePolicy,
) {
  const path = existing ?? mkdtempSync(join(tmpdir(), 'haze-job-service-'));
  if (!existing) paths.push(path);
  const store = new TaskStore(path);
  stores.push(store);
  const service = new NightshiftJobService(
    store,
    adapter,
    (principal) => {
      if (
        principal.principal !== identity.principal ||
        principal.workspace !== identity.workspace
      )
        throw new TaskError(
          403,
          'local_identity_required',
          'Local identity required.',
        );
    },
    {
      env: {},
      pollIntervalMs: 60_000,
      ...(automaticReadiness ? { automaticReadiness } : {}),
    },
  );
  services.push(service);
  return { path, store, service };
}
const authority = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
function automaticAdmission(store: TaskStore) {
  const source = store.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'source.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(
        'Synthetic source for admission only.',
      ).toString('base64'),
    },
    identity,
    'source',
  ).artifact;
  const ref = { id: source.id, version: source.version, sha256: source.sha256 };
  const tools = ['nightshift.submit', 'nightshift.result'];
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Prepare a bounded unreviewed draft.',
      context_refs: [ref],
      nightshift_tools: tools,
    }),
    identity,
    'automatic-task',
    { tools },
  ).task;
  return {
    task,
    body: {
      schema_version: 'haze.nightshift.chain.admission.v2',
      privacy: INITIAL_AUTOMATIC_SCOPE.privacy[0],
      max_spend_usd: null,
      task_id: task.id,
      ...authority(task),
      total_runs: INITIAL_AUTOMATIC_SCOPE.max_total_runs,
      automatic_followup_runs: INITIAL_AUTOMATIC_SCOPE.max_automatic_followups,
      max_jobs: INITIAL_AUTOMATIC_SCOPE.max_jobs,
      max_attempts:
        INITIAL_AUTOMATIC_SCOPE.max_jobs *
        INITIAL_AUTOMATIC_SCOPE.max_attempts_per_job,
      lifetime_seconds: INITIAL_AUTOMATIC_SCOPE.max_lifetime_seconds,
      automatic_opt_in: true,
      initial_progress: {
        schema_version: 'haze.nightshift.progress.v1',
        purpose: 'evidence_linked_draft',
        instruction:
          'Inspect the exact source without accepting generated claims.',
        input_refs: [ref],
      },
    },
  };
}
function releasedFixture() {
  const blocked = automaticReleaseBlocked('Fixture prerequisites only.');
  return automaticReadinessSchema.parse({
    ...blocked,
    released: true,
    ready: true,
    evidence_id: 'synthetic-release-no-live-claim',
    evidence_kind: 'fixture',
    reason: null,
    gates: blocked.gates.map((gate) => ({
      ...gate,
      passed: true,
      reason: null,
    })),
  });
}
async function admission(
  adapter: NightshiftJobPort = port(),
  privacy: NightshiftSubmitRequest['privacy'] = 'local-only',
) {
  const state = setup(adapter);
  const policy = {
    privacy,
    max_spend_usd: privacy === 'local-only' ? 0 : null,
  };
  const task = state.store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Produce an explicitly synthetic draft.',
    }),
    identity,
    'task',
  ).task;
  const chain = await state.service.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      ...policy,
      task_id: task.id,
      ...authority(task),
    },
    'chain',
    identity,
  );
  const body = {
    schema_version: 'haze.nightshift.job.submit.v1',
    ...policy,
    chain_id: chain.id,
    expected_chain_revision: chain.revision,
    ...authority(task),
    prompt: 'Draft a synthetic explanation without invented evidence.',
  };
  return { ...state, task, chain, body };
}
function control(job: NightshiftJob, store: TaskStore) {
  return {
    ...authority(store.read(job.task_id, identity)),
    expected_chain_revision: store.nightshift.chain(job.chain_id, identity)
      .revision,
    expected_job_revision: job.revision,
  };
}

describe('browser-independent Nightshift supervisor', () => {
  it('dispatches cloud candidates without requiring any local model or adding a dollar cap', async () => {
    const baseline = port();
    const ready = await baseline.readiness();
    const remote = await baseline.inspect('remote-1');
    const adapter = port({
      readiness: vi.fn(() =>
        Promise.resolve({
          ...ready,
          cloud_enforced: true,
          cloud_compute_available: true,
          local_compute_available: false,
        }),
      ),
      inspect: vi.fn(() => Promise.resolve({ ...remote, privacy: 'cloud-ok' })),
    });
    const state = await admission(adapter, 'cloud-ok');
    expect(state.chain.grant).toMatchObject({
      privacy: 'cloud-ok',
      max_spend_usd: null,
      automatic_followup_runs: 0,
    });
    const job = await state.service.submitJob(
      state.body,
      'cloud-job',
      identity,
    );
    expect(job.remote_id).toBe('remote-1');
    expect(adapter.submit).toHaveBeenCalledWith(
      expect.objectContaining({ privacy: 'cloud-ok', max_spend_usd: null }),
      expect.any(AbortSignal),
    );
    await expect(
      state.service.admitChain(
        {
          schema_version: 'haze.nightshift.chain.admission.v1',
          task_id: state.task.id,
          ...authority(state.store.read(state.task.id, identity)),
          privacy: 'local-only',
          max_spend_usd: 0,
        },
        'unavailable-local-chain',
        identity,
      ),
    ).rejects.toMatchObject({ code: 'nightshift_unavailable' });
  });
  it('admits v2 only while both release checks remain ready', async () => {
    const ready = await port().readiness();
    const adapter = port({
      readiness: vi.fn(() =>
        Promise.resolve({
          ...ready,
          cloud_enforced: true,
          cloud_compute_available: true,
        }),
      ),
    });
    const gate = vi.fn(() => Promise.resolve(releasedFixture()));
    const state = setup(adapter, undefined, gate);
    const f = automaticAdmission(state.store);
    const chain = await state.service.admitChain(
      f.body,
      'automatic-chain',
      identity,
    );
    expect(chain.schema_version).toBe('haze.nightshift.chain.v2');
    expect(gate).toHaveBeenCalledTimes(2);
    expect(adapter.readiness).toHaveBeenCalledOnce();
    expect(state.service.listChains(identity).chains).toHaveLength(1);
    expect(adapter.submit).not.toHaveBeenCalled();
  });
  it('keeps v1 admission independent of the automatic release policy', async () => {
    const adapter = port();
    const gate = vi.fn(() =>
      Promise.resolve(automaticReleaseBlocked('Automatic mode is closed.')),
    );
    const state = setup(adapter, undefined, gate);
    const task = state.store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Prepare a manual-only draft.',
      }),
      identity,
      'manual-task',
    ).task;
    const chain = await state.service.admitChain(
      {
        schema_version: 'haze.nightshift.chain.admission.v1',
        privacy: 'local-only',
        max_spend_usd: 0,
        task_id: task.id,
        ...authority(task),
      },
      'manual-chain',
      identity,
    );
    expect(chain.schema_version).toBe('haze.nightshift.chain.v1');
    expect(chain.grant.automatic_followup_runs).toBe(0);
    expect(gate).not.toHaveBeenCalled();
    expect(adapter.readiness).toHaveBeenCalledOnce();
    expect(adapter.submit).not.toHaveBeenCalled();
  });
  it('rechecks automatic release after deferred runtime discovery before creating any grant', async () => {
    const initialAdapter = port();
    const ready = {
      ...(await initialAdapter.readiness()),
      cloud_enforced: true,
      cloud_compute_available: true,
    };
    let finishReadiness!: (value: NightshiftJobReadiness) => void;
    const adapter = port({
      readiness: vi.fn(
        () =>
          new Promise<NightshiftJobReadiness>((done) => {
            finishReadiness = done;
          }),
      ),
    });
    let release = releasedFixture();
    const gate = vi.fn(() => Promise.resolve(release));
    const state = setup(adapter, undefined, gate);
    const f = automaticAdmission(state.store);
    const before = state.store.read(f.task.id, identity).usage;
    const pending = state.service.admitChain(
      f.body,
      'automatic-chain',
      identity,
    );
    await vi.waitFor(() => expect(adapter.readiness).toHaveBeenCalledOnce());
    release = automaticReleaseBlocked(
      'Release evidence was revoked during discovery.',
    );
    const rejection = expect(pending).rejects.toMatchObject({
      status: 503,
      code: 'nightshift_automatic_release_blocked',
    });
    finishReadiness(ready);
    await rejection;
    expect(gate).toHaveBeenCalledTimes(2);
    expect(state.service.listChains(identity).chains).toEqual([]);
    expect(state.service.listJobs(identity).jobs).toEqual([]);
    expect(state.store.read(f.task.id, identity).usage).toEqual(before);
    expect(adapter.submit).not.toHaveBeenCalled();
  });
  it('keeps a known judge outcome when output retrieval fails, then preserves it on capture', async () => {
    let outputAvailable = false;
    let outcomeAvailable = true;
    const adapter = port({
      inspect: vi.fn(() =>
        Promise.resolve({
          remote_id: 'remote-1',
          execution_state: 'completed',
          terminal: true,
          generated: 4,
          requested_attempts: 4,
          privacy: 'local-only',
          fleet: null,
          runtime_version: 'fixture-only',
        }),
      ),
      outcome: vi.fn(() =>
        outcomeAvailable
          ? Promise.resolve({
              status: 'accepted' as const,
              basis: 'synthetic judge',
              explanation: null,
            })
          : Promise.reject(new Error('read failed')),
      ),
      result: vi.fn(() =>
        outputAvailable
          ? Promise.resolve({
              text: 'Recovered original candidate.',
              attempts: [],
              winner_seq: null,
              retrieval_error: null,
              truncated: false as const,
            })
          : Promise.reject(new Error('read failed')),
      ),
    });
    const state = await admission(adapter);
    const submitted = await state.service.submitJob(
      state.body,
      'job',
      identity,
    );
    await state.service.pollNow();
    const failed = state.service.job(submitted.id, identity);
    expect(failed.receipt).toBeNull();
    expect(failed.judge_outcome.status).toBe('accepted');
    outputAvailable = true;
    outcomeAvailable = false;
    state.store.nightshift.schedulePoll(
      submitted.id,
      '2000-01-01T00:00:00.000Z',
    );
    await state.service.pollNow();
    const captured = state.service.job(submitted.id, identity);
    expect(captured.receipt?.output).toBe('Recovered original candidate.');
    expect(captured.judge_outcome.status).toBe('accepted');
  });
  it('continues observing judge state after capture without rewriting the immutable receipt', async () => {
    let outcomeAvailable = false;
    const adapter = port({
      inspect: vi.fn(() =>
        Promise.resolve({
          remote_id: 'remote-1',
          execution_state: 'completed',
          terminal: true,
          generated: 4,
          requested_attempts: 4,
          privacy: 'local-only',
          fleet: null,
          runtime_version: 'fixture-only',
        }),
      ),
      outcome: vi.fn(() =>
        outcomeAvailable
          ? Promise.resolve({
              status: 'accepted' as const,
              basis: 'synthetic judge',
              explanation: null,
            })
          : Promise.reject(new Error('read failed')),
      ),
    });
    const state = await admission(adapter);
    const submitted = await state.service.submitJob(
      state.body,
      'job',
      identity,
    );
    await state.service.pollNow();
    const captured = state.service.job(submitted.id, identity);
    expect(captured.receipt).not.toBeNull();
    expect(captured.judge_outcome.status).toBe('unknown');
    const receipt = JSON.stringify(captured.receipt);
    outcomeAvailable = true;
    state.store.nightshift.schedulePoll(
      submitted.id,
      '2000-01-01T00:00:00.000Z',
    );
    await state.service.pollNow();
    const observed = state.service.job(submitted.id, identity);
    expect(observed.judge_outcome.status).toBe('accepted');
    expect(JSON.stringify(observed.receipt)).toBe(receipt);
  });
  it('accepts only verified reconciliation and replays its recorded receipt before rechecking transport', async () => {
    let proofAvailable = true;
    const adapter = port({
      submit: vi.fn(() =>
        Promise.reject(
          new NightshiftJobTransportError('unknown', 'fixture-timeout', 'safe'),
        ),
      ),
      verifyReconciliation: vi.fn(() =>
        Promise.resolve({ verified: proofAvailable, reason: null }),
      ),
    });
    const state = await admission(adapter);
    const unknown = await state.service.submitJob(state.body, 'job', identity);
    const body = {
      schema_version: 'haze.nightshift.job.reconcile.v1',
      ...control(unknown, state.store),
      remote_id: 'remote-1',
    };
    const reconciled = await state.service.reconcileJob(
      unknown.id,
      body,
      'reconcile',
      identity,
    );
    expect(reconciled.remote_id).toBe('remote-1');
    proofAvailable = false;
    expect(
      (
        await state.service.reconcileJob(
          unknown.id,
          body,
          'reconcile',
          identity,
        )
      ).remote_id,
    ).toBe('remote-1');
    expect(adapter.verifyReconciliation).toHaveBeenCalledTimes(1);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('deduplicates concurrent delivery before dispatch and retains original request conflicts', async () => {
    let acknowledge!: (value: { remote_id: string }) => void;
    const adapter = port({
      submit: vi.fn(
        () =>
          new Promise<{ remote_id: string }>((resolve) => {
            acknowledge = resolve;
          }),
      ),
    });
    const { service, body } = await admission(adapter);
    const submitted = service.submitJob(body, 'job', identity);
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledTimes(1));
    const duplicate = await service.submitJob(body, 'job', identity);
    expect(duplicate.execution_state).toBe('submitting');
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    await expect(
      service.submitJob(
        { ...body, prompt: 'Changed intent.' },
        'job',
        identity,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    acknowledge({ remote_id: 'remote-1' });
    expect((await submitted).id).toBe(duplicate.id);
    await service.pollNow();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps ambiguous submissions reserved across restart and never replays them', async () => {
    const adapter = port({
      submit: vi.fn(() =>
        Promise.reject(
          new NightshiftJobTransportError('unknown', 'fixture-timeout', 'safe'),
        ),
      ),
    });
    const state = await admission(adapter);
    const unknown = await state.service.submitJob(state.body, 'job', identity);
    expect(unknown.execution_state).toBe('submission_unknown');
    expect(
      state.store.nightshift.chain(state.chain.id, identity).usage
        .requested_attempts,
    ).toBe(4);
    await state.service.close();
    state.store.close();
    const replacement = port();
    const restarted = setup(replacement, state.path);
    await restarted.service.pollNow();
    expect(
      (await restarted.service.submitJob(state.body, 'job', identity)).id,
    ).toBe(unknown.id);
    expect(replacement.submit).not.toHaveBeenCalled();
    expect(replacement.inspect).not.toHaveBeenCalled();
  });
  it('retains late output after cancellation without applicability or automatic task effects', async () => {
    let terminal = false;
    const adapter = port({
      inspect: vi.fn(() =>
        Promise.resolve({
          remote_id: 'remote-1',
          execution_state: terminal ? 'completed' : 'running',
          terminal,
          generated: terminal ? 4 : 0,
          requested_attempts: 4,
          privacy: 'local-only',
          fleet: null,
          runtime_version: 'fixture-only',
        }),
      ),
    });
    const state = await admission(adapter);
    const job = await state.service.submitJob(state.body, 'job', identity);
    await state.service.pollNow();
    const task = state.store.read(state.task.id, identity);
    state.store.control(task.id, identity, 'cancel-task', {
      schema_version: 'haze.task.control.v3',
      action: 'cancel',
      ...authority(task),
    });
    const before = JSON.stringify(state.store.read(task.id, identity));
    terminal = true;
    state.store.nightshift.schedulePoll(job.id, '2000-01-01T00:00:00.000Z');
    await state.service.pollNow();
    const captured = state.service.job(job.id, identity);
    expect(captured.receipt?.output).toContain('Synthetic draft');
    expect(captured.authority.run_id).toBe(task.current_run_id);
    expect(captured.review_status).toBe('unreviewed');
    expect(captured.selections).toEqual([]);
    expect(JSON.stringify(state.store.read(task.id, identity))).toBe(before);
    expect(
      state.store.db
        .prepare(
          'SELECT body FROM applicability WHERE task_id=? AND artifact_id=? AND objective_revision=?',
        )
        .get(task.id, captured.receipt!.artifact.id, task.objective_revision),
    ).toBeUndefined();
    const artifacts = state.store.db
      .prepare('SELECT COUNT(*) n FROM artifacts')
      .get() as { n: number };
    await state.service.pollNow();
    expect(
      (
        state.store.db.prepare('SELECT COUNT(*) n FROM artifacts').get() as {
          n: number;
        }
      ).n,
    ).toBe(artifacts.n);
  });
  it('acknowledges cancellation once while preserving unconfirmed capacity and restart fencing', async () => {
    const adapter = port();
    const state = await admission(adapter);
    const first = await state.service.submitJob(state.body, 'job', identity);
    await state.service.pollNow();
    const current = state.service.job(first.id, identity);
    const cancelled = await state.service.cancelJob(
      first.id,
      {
        schema_version: 'haze.nightshift.job.cancel.v1',
        ...control(current, state.store),
      },
      'cancel',
      identity,
    );
    expect(cancelled.cancellation).toEqual({
      requested: true,
      acknowledged: true,
      remote_termination_confirmed: false,
    });
    expect(adapter.cancel).toHaveBeenCalledTimes(1);
    expect(
      (
        state.store.db
          .prepare('SELECT capacity_held n FROM ns_reservations WHERE job_id=?')
          .get(first.id) as { n: number }
      ).n,
    ).toBe(1);
    await state.service.close();
    state.store.close();
    const replacement = port();
    const restarted = setup(replacement, state.path);
    await restarted.service.pollNow();
    expect(replacement.cancel).not.toHaveBeenCalled();
    expect(replacement.submit).not.toHaveBeenCalled();
  });
  it('persists sanitized read failures and backs off across reload/restart', async () => {
    const adapter = port({
      inspect: vi.fn(() =>
        Promise.reject(new Error('sensitive transport diagnostic')),
      ),
    });
    const state = await admission(adapter);
    const job = await state.service.submitJob(state.body, 'job', identity);
    await state.service.pollNow();
    const failed = state.service.job(job.id, identity);
    expect(failed.read_failures).toBe(1);
    expect(Date.parse(failed.next_poll_at!)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(failed)).not.toContain('sensitive transport');
    await state.service.pollNow();
    expect(adapter.inspect).toHaveBeenCalledTimes(1);
    await state.service.close();
    state.store.close();
    const replacement = port();
    const restarted = setup(replacement, state.path);
    await restarted.service.pollNow();
    expect(replacement.inspect).not.toHaveBeenCalled();
  });
  it('shutdown fences an in-flight unacknowledged submission even if the adapter ignores abort', async () => {
    const adapter = port({
      submit: vi.fn(() => new Promise<{ remote_id: string }>(() => undefined)),
    });
    const state = await admission(adapter);
    const work = state.service.submitJob(state.body, 'job', identity);
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledTimes(1));
    await state.service.close();
    expect((await work).execution_state).toBe('submission_unknown');
  });
  it('rejects unenforceable dollar caps and unsupported options before remote submission', async () => {
    const adapter = port();
    const state = await admission(adapter);
    await expect(
      state.service.submitJob(
        { ...state.body, privacy: 'cloud-ok', max_spend_usd: 1 },
        'cloud',
        identity,
      ),
    ).rejects.toMatchObject({ code: 'invalid_nightshift_request' });
    await expect(
      state.service.submitJob(
        { ...state.body, fleet: 'unknown-fleet' },
        'fleet',
        identity,
      ),
    ).rejects.toMatchObject({ code: 'nightshift_unsupported_option' });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(state.service.listJobs(identity).jobs).toEqual([]);
  });
});
