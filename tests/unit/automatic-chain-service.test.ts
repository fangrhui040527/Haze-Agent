import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import {
  AutomaticChainService,
  type AutomaticSuccessorRequest,
  type AutomaticAdmissionResult,
} from '../../app/tasks/automatic-chain-service.js';
import {
  automaticReleaseBlocked,
  type AutomaticReadiness,
} from '../../app/contracts/nightshift-automatic.js';
import {
  taskRequestSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type { NightshiftJob } from '../../app/contracts/nightshift-records.js';
import { graphThreadId } from '../../app/tasks/graph-ledger.js';

const identity = { principal: 'local-user', workspace: 'local-workspace' };
const tools = ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'];
const stores: TaskStore[] = [],
  directories: string[] = [];
const supervisors: AutomaticChainService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of supervisors.splice(0)) await service.close();
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..'))
      throw new Error('Unsafe automatic fixture cleanup.');
    rmSync(directory, { recursive: true, force: true });
  }
});
const authority = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
const verified: AutomaticReadiness = {
  schema_version: 'haze.nightshift.automatic.readiness.v1',
  released: true,
  ready: true,
  reason: null,
  evidence_id: 'fixture-control-flow-only',
  evidence_kind: 'fixture',
  gates: [
    {
      id: 'fixture-invariants',
      label: 'Synthetic control flow only',
      passed: true,
      reason: null,
    },
  ],
};
function fixture(
  automatic = true,
  assigned = false,
  existing?: TaskStore,
  grant = { totalRuns: 3, automaticRuns: 2 },
) {
  const directory =
    existing?.directory ??
    mkdtempSync(join(tmpdir(), 'haze-automatic-service-'));
  if (!existing) directories.push(directory);
  const store = existing ?? new TaskStore(directory, { recover: false });
  if (!existing) stores.push(store);
  const fixtureKey = randomUUID();
  store.nightshift.configureAutomatic({
    enabled: true,
    evidence_id: verified.evidence_id,
  });
  const source = store.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'fixture.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(
        'Synthetic fixture source, not a measured scientific result.',
      ).toString('base64'),
    },
    identity,
    `source-${fixtureKey}`,
  ).artifact;
  const ref = { id: source.id, version: source.version, sha256: source.sha256 };
  let task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Review the supplied fixture source.',
      context_refs: [ref],
      nightshift_tools: tools,
    }),
    identity,
    `task-${fixtureKey}`,
    {
      mode: 'fixture',
      tools,
      limits: {
        deadline: new Date(Date.now() + 120000).toISOString(),
        max_model_calls: 12,
        max_tool_calls: 12,
        max_assignments: 8,
        max_artifacts: 12,
        reserved_model_calls: 2,
      },
    },
  ).task;
  const assignment = assigned
    ? store.createAssignments(
        task.id,
        task.current_run_id,
        task.objective_revision,
        [
          {
            role: 'HazeOps',
            definition_id: 'fixture.waiter',
            definition_version: 'fixture.v1',
            capability: 'fixture',
            brief: 'Inspect exact external results.',
            inputs: [ref],
            tools,
          },
        ],
      )[0]
    : undefined;
  if (assignment) {
    store.acquireAssignment(task.id, assignment.id);
    task = store.read(task.id, identity);
  }
  const progress = {
    schema_version: 'haze.nightshift.progress.v1',
    purpose: 'critique_candidate',
    instruction:
      'Inspect one retained critique and preserve independent review.',
    unresolved_deliverables: ['objective'],
    input_refs: [ref],
    output_refs: [],
    review_objections: [],
    failure_causes: [],
    last_consumed_result_cursor: 0,
  };
  const chain = store.nightshift.admitChain(
    {
      schema_version: automatic
        ? 'haze.nightshift.chain.admission.v2'
        : 'haze.nightshift.chain.admission.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      task_id: task.id,
      ...authority(task),
      total_runs: grant.totalRuns,
      max_jobs: 4,
      max_attempts: 4,
      lifetime_seconds: 600,
      ...(automatic
        ? {
            automatic_opt_in: true,
            automatic_followup_runs: grant.automaticRuns,
            initial_progress: progress,
          }
        : {}),
    },
    `chain-${fixtureKey}`,
    identity,
  ).chain;
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      chain_id: chain.id,
      ...authority(task),
      expected_chain_revision: chain.revision,
      ...(assignment
        ? {
            expected_assignment_id: assignment.id,
            expected_assignment_revision: assignment.revision,
          }
        : {}),
      prompt: 'A bounded synthetic critique.',
      purpose: 'critique_candidate',
      input_refs: [ref],
      n: 1,
      role: assignment ? 'HazeOps' : 'Manager',
    },
    `job-${fixtureKey}`,
    identity,
    {
      adapter_version: 'fixture',
      runtime_version: 'fixture',
      schema_hash: 'fixture',
    },
  ).job;
  return { directory, store, task, chain, job, ref, assignment };
}
const outcome = {
  status: 'accepted' as const,
  basis: 'Fixture judge is not evidence review.',
  explanation: null,
};
function finish(f: ReturnType<typeof fixture>, job: NightshiftJob = f.job) {
  if (!f.store.nightshift.job(job.id, identity).remote_id)
    f.store.nightshift.acknowledge(job.id, `fixture-${job.id}`);
  f.store.nightshift.observation(
    job.id,
    `fixture-${job.id}`,
    {
      remote_id: `fixture-${job.id}`,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'fixture',
    },
    outcome,
  );
  f.store.nightshift.capture(
    job.id,
    `fixture-${job.id}`,
    {
      text: 'Synthetic candidate requiring independent review.',
      attempts: [],
      winner_seq: null,
      retrieval_error: null,
      truncated: false,
    },
    outcome,
  );
}
function service(
  f: ReturnType<typeof fixture>,
  overrides: {
    gate?: () => Promise<AutomaticReadiness>;
    admit?: (request: AutomaticSuccessorRequest) => AutomaticAdmissionResult;
    routes?: () => Promise<boolean>;
  } = {},
) {
  const admitted = vi.fn(
    overrides.admit ??
      (() => ({
        run_id: randomUUID(),
        decision_id: randomUUID(),
        reused: false,
      })),
  );
  const kick = vi.fn(),
    suspend = vi.fn();
  const value = new AutomaticChainService(f.store, {
    releaseGate: overrides.gate ?? (() => Promise.resolve(verified)),
    admitSuccessor: admitted,
    routesAvailable: overrides.routes ?? (() => Promise.resolve(true)),
    kick,
    suspend,
  });
  supervisors.push(value);
  return { value, admitted, kick, suspend };
}
function expire(f: ReturnType<typeof fixture>) {
  f.store.stop(
    f.task.id,
    'timed_out',
    'deadline_exceeded',
    'Fixture predecessor ended; receipts remain historical.',
  );
}

describe('automatic chain successor decisions', () => {
  it('keeps production release blocked and never dispatches an admitted automatic grant through an unmet gate', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f, {
      gate: () =>
        Promise.resolve(automaticReleaseBlocked('Live gates are unmet.')),
    });
    await s.value.tick();
    expect(s.admitted).not.toHaveBeenCalled();
    expect(s.suspend).toHaveBeenCalledOnce();
    expect(s.value.decisions(f.chain.id, identity)).toEqual([]);
    expect(
      (
        f.store.db
          .prepare('SELECT count(*) n FROM automatic_chain_result_events')
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
  it('does not silently upgrade a historical manual-only chain', async () => {
    const f = fixture(false);
    finish(f);
    expire(f);
    const s = service(f);
    await s.value.tick();
    expect(s.admitted).not.toHaveBeenCalled();
    expect(
      f.store.nightshift.chain(f.chain.id, identity).grant
        .automatic_followup_runs,
    ).toBe(0);
  });
  it('closes promptly when a trusted gate dependency ignores cancellation', async () => {
    const f = fixture();
    const s = service(f, { gate: () => new Promise(() => {}) });
    const tick = s.value.tick();
    await Promise.resolve();
    await s.value.close();
    await tick;
    expect(s.admitted).not.toHaveBeenCalled();
  });
  it('keeps a completed result in the active run inbox without interrupting work or treating started operations as unknown', async () => {
    const f = fixture();
    finish(f);
    const [assignment] = f.store.createAssignments(
      f.task.id,
      f.task.current_run_id,
      f.task.objective_revision,
      [
        {
          role: 'HazeOps',
          definition_id: 'fixture.active',
          definition_version: 'fixture.v1',
          capability: 'fixture',
          brief: 'Legitimate active computation.',
          tools,
        },
      ],
    );
    const leased = f.store.acquireAssignment(f.task.id, assignment!.id)!;
    f.store.chargeAttempt(
      f.task.id,
      leased.id,
      'tool',
      { tool: 'nightshift.result' },
      {
        generation: leased.generation,
        assignment_revision: leased.revision,
        lease_token: leased.lease_token!,
      },
    );
    const pending = f.store.graph.pending();
    const s = service(f);
    await s.value.tick();
    await s.value.tick();
    expect(s.admitted).not.toHaveBeenCalled();
    expect(s.value.decisions(f.chain.id, identity)).toMatchObject([
      { code: 'active_run_inbox', state: 'observing' },
    ]);
    expect(f.store.nightshift.chain(f.chain.id, identity).status).toBe(
      'active',
    );
    expect(
      (
        f.store.db
          .prepare('SELECT count(*) n FROM automatic_chain_result_events')
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(f.store.graph.pending()).toEqual(pending);
  });
  it('records one stable service decision for a terminal receipt and coalesces simultaneous ticks', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f);
    const original = f.store.nightshift.chain(f.chain.id, identity);
    await Promise.all([s.value.tick(), s.value.tick(), s.value.tick()]);
    await s.value.tick();
    expect(s.admitted).toHaveBeenCalledOnce();
    expect(s.kick).toHaveBeenCalledOnce();
    const request = s.admitted.mock.calls[0]![0];
    expect(request).toMatchObject({
      actor: { kind: 'service', id: 'Nightshift' },
      mode: 'automatic',
      predecessor_run_id: f.task.current_run_id,
      purpose: 'critique_candidate',
    });
    expect(request.delivery_ids).toEqual([
      f.store.nightshift.job(f.job.id, identity).receipt!.artifact.id,
    ]);
    expect(request.trigger_cursor).toBeGreaterThan(0);
    expect(s.value.decisions(f.chain.id, identity)).toMatchObject([
      { state: 'admitted', actor: 'service:Nightshift' },
    ]);
    const current = f.store.nightshift.chain(f.chain.id, identity);
    expect(current.expires_at).toBe(original.expires_at);
    expect(current.usage).toEqual(original.usage);
  });
  it('retains the same bounded waiting decision and FIFO ticket while capacity is occupied', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f, {
      admit: () => ({
        waiting: true,
        sequence: 7,
        reason: 'Waiting for Haze capacity.',
      }),
    });
    await s.value.tick();
    const first = s.value.decisions(f.chain.id, identity)[0]!;
    await s.value.tick();
    const next = s.value.decisions(f.chain.id, identity)[0]!;
    expect(next).toEqual(first);
    expect(next.queue_sequence).toBe(7);
    expect(s.kick).not.toHaveBeenCalled();
    expect(f.store.read(f.task.id, identity).runs).toHaveLength(1);
  });
  it('does not replace the original pinned routes when they are unavailable', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f, { routes: () => Promise.resolve(false) });
    await s.value.tick();
    expect(s.admitted).not.toHaveBeenCalled();
    expect(
      f.store.nightshift.automationView(f.chain.id, identity).stops[0]?.code,
    ).toBe('route_unavailable');
    expect(f.store.read(f.task.id, identity).runs).toHaveLength(1);
  });
  it('rechecks authority after asynchronous route availability and leaves a newer manual run untouched', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    let resolveRoutes!: (available: boolean) => void;
    const s = service(f, {
      routes: () =>
        new Promise((done) => {
          resolveRoutes = done;
        }),
    });
    const pending = s.value.tick();
    await vi.waitFor(() => expect(resolveRoutes).toBeTypeOf('function'));
    const current = f.store.read(f.task.id, identity);
    f.store.control(f.task.id, identity, 'manual-wins', {
      schema_version: 'haze.task.control.v3',
      ...authority(current),
      action: 'continue',
    });
    const next = f.store.read(f.task.id, identity);
    resolveRoutes(true);
    await pending;
    expect(s.admitted).not.toHaveBeenCalled();
    expect(f.store.read(f.task.id, identity).current_run_id).toBe(
      next.current_run_id,
    );
    expect(f.store.nightshift.chain(f.chain.id, identity).status).toBe(
      'active',
    );
  });
  it('retains an unknown submission charge and pauses automatic continuation without replay', async () => {
    const f = fixture();
    f.store.nightshift.markDispatched(f.job.id);
    f.store.nightshift.submissionUnknown(f.job.id);
    expire(f);
    const s = service(f);
    await s.value.tick();
    expect(s.admitted).not.toHaveBeenCalled();
    expect(
      f.store.nightshift.automationView(f.chain.id, identity).stops[0]?.code,
    ).toBe('unknown_outcome');
    expect(f.store.nightshift.chain(f.chain.id, identity).usage.jobs).toBe(1);
    expect(f.store.nightshift.job(f.job.id, identity).execution_state).toBe(
      'submission_unknown',
    );
  });
  it('validates identity on decision readback', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f);
    await s.value.tick();
    expect(() =>
      s.value.decisions(f.chain.id, {
        ...identity,
        workspace: 'another-workspace',
      }),
    ).toThrow();
  });
  it('admits through the shared lifecycle once, with atomic graph delivery and retained inbox provenance', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const before = f.store.nightshift.chain(f.chain.id, identity);
    const s = service(f, {
      admit: (request) => f.store.linkedRuns.admit(request),
    });
    await s.value.tick();
    await s.value.tick();
    const current = f.store.read(f.task.id, identity);
    expect(
      current.runs,
      JSON.stringify({
        decisions: s.value.decisions(f.chain.id, identity),
        stops: f.store.nightshift.automationView(f.chain.id, identity).stops,
      }),
    ).toHaveLength(2);
    expect(current.current_run_id).not.toBe(f.task.current_run_id);
    expect(current.runs.at(-1)?.predecessor_run_id).toBe(f.task.current_run_id);
    const after = f.store.nightshift.chain(f.chain.id, identity);
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.usage.runs).toBe(2);
    expect(after.usage.jobs).toBe(1);
    expect(after.usage.requested_attempts).toBe(1);
    expect(
      f.store.nightshift.automationView(f.chain.id, identity).used_followups,
    ).toBe(1);
    const inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
    expect(inbox).toMatchObject([
      {
        job_id: f.job.id,
        target_run_id: current.current_run_id,
        original_authority: { run_id: f.task.current_run_id },
        resolved: false,
      },
    ]);
    expect(inbox[0]!.cursor).toBeGreaterThan(0);
    expect(
      f.store.graph
        .pending()
        .filter((job) => job.run_id === current.current_run_id),
    ).toHaveLength(1);
    expect(s.admitted).toHaveBeenCalledOnce();
  });
  it('does not spend a second successor on the same unconsumed transferred result and unchanged purpose', async () => {
    const f = fixture();
    finish(f);
    expire(f);
    const s = service(f, {
      admit: (request) => f.store.linkedRuns.admit(request),
    });
    await s.value.tick();
    f.store.stop(
      f.task.id,
      'timed_out',
      'deadline_exceeded',
      'The first successor expired without useful progress.',
    );
    await s.value.tick();
    expect(f.store.read(f.task.id, identity).runs).toHaveLength(2);
    expect(
      f.store.nightshift.automationView(f.chain.id, identity).stops[0]?.code,
    ).toBe('no_progress');
  });
  it.each(['expired', 'reported_unresolved'] as const)(
    'carries every required pending job after %s and admits the later new result with original provenance',
    async (ending) => {
      const f = fixture(true, true),
        assignment = f.assignment!;
      f.store.nightshift.acknowledge(f.job.id, `fixture-${f.job.id}`);
      const source = f.store.importArtifact(
        {
          schema_version: 'haze.artifact.import.v3',
          filename: 'changed-source.txt',
          media_type: 'text/plain',
          content_base64: Buffer.from(
            'A second genuinely distinct fixture source.',
          ).toString('base64'),
        },
        identity,
        'source-2',
      ).artifact;
      const ref = {
        id: source.id,
        version: source.version,
        sha256: source.sha256,
      };
      f.store.recordApplicability(
        f.task.id,
        identity,
        ref,
        true,
        'Explicitly inspected second fixture source.',
        'Runtime',
      );
      f.store.pinAssignmentInput(
        f.task.id,
        assignment.id,
        f.task.generation,
        ref,
      );
      let current = f.store.read(f.task.id, identity),
        chain = f.store.nightshift.chain(f.chain.id, identity);
      const prior = f.store.nightshift.progress(chain.id, identity)!;
      f.store.nightshift.proposeProgress(
        chain.id,
        {
          schema_version: 'haze.nightshift.chain.progress.proposal.v1',
          ...authority(current),
          expected_chain_revision: chain.revision,
          progress: { ...prior.progress, input_refs: [ref] },
        },
        'changed-source',
        identity,
      );
      chain = f.store.nightshift.chain(chain.id, identity);
      current = f.store.read(f.task.id, identity);
      const second = f.store.nightshift.reserveJob(
        {
          schema_version: 'haze.nightshift.job.submit.v1',
          privacy: 'local-only',
          max_spend_usd: 0,
          chain_id: chain.id,
          ...authority(current),
          expected_assignment_id: assignment.id,
          expected_assignment_revision: assignment.revision,
          expected_chain_revision: chain.revision,
          prompt: 'A critique of the distinct second source.',
          purpose: 'critique_candidate',
          input_refs: [ref],
          n: 1,
          role: 'HazeOps',
        },
        'job-2',
        identity,
        {
          adapter_version: 'fixture',
          runtime_version: 'fixture',
          schema_hash: 'fixture',
        },
      ).job;
      f.store.nightshift.acknowledge(second.id, `fixture-${second.id}`);
      const target = {
        task_id: f.task.id,
        run_id: f.task.current_run_id,
        generation: f.task.generation,
        objective_revision: f.task.objective_revision,
        assignment_id: assignment.id,
        assignment_revision: assignment.revision,
      };
      const thread = graphThreadId('assignment', target),
        cursor = f.store.events(f.task.id, identity).next_cursor;
      f.store.externalWaits.wait(
        {
          ...target,
          thread_id: thread,
          after_cursor: cursor,
          dependencies: [
            { job_id: f.job.id, required: true },
            { job_id: second.id, required: true },
          ],
        },
        identity,
      );
      f.store.completeAssignment(f.task.id, assignment.id, f.task.generation, {
        status: 'waiting',
        support: 'gap',
        gaps: ['Both exact results remain required.'],
      });
      f.store.graph.park({
        ...target,
        kind: 'assignment',
        thread_id: thread,
        cursor,
        after_cursor: cursor,
        event_types: ['external_result_ready'],
      });
      finish(f);
      f.store.externalWaits.reconcileDeliveries();
      expire(f);
      const s = service(f, {
        admit: (request) => f.store.linkedRuns.admit(request),
      });
      await s.value.tick();
      let inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
      expect(inbox).toHaveLength(2);
      expect(inbox.every((item) => item.required)).toBe(true);
      expect(
        inbox.find((item) => item.job_id === second.id)?.execution_state,
      ).toBe('queued');
      let owner = f.store.read(f.task.id, identity);
      expect(() =>
        f.store.nightshiftTransfers.assertFinalizable({
          task_id: owner.id,
          run_id: owner.current_run_id,
          generation: owner.generation,
          objective_revision: owner.objective_revision,
        }),
      ).toThrow('Required');
      if (ending === 'reported_unresolved') {
        for (const sourceRef of [f.ref, ref])
          f.store.recordApplicability(
            f.task.id,
            identity,
            sourceRef,
            true,
            'Manager rechecked exact source applicability for the unchanged objective.',
            'Runtime',
          );
        const [consumer] = f.store.createAssignments(
          owner.id,
          owner.current_run_id,
          owner.objective_revision,
          [
            {
              role: 'HazeOps',
              definition_id: 'fixture.consume',
              definition_version: 'fixture.v1',
              capability: 'fixture',
              brief: 'Explicitly resolve the inspected first candidate.',
              tools,
              input: { nightshift_job_ids: [f.job.id] },
            },
          ],
        );
        const leased = f.store.acquireAssignment(owner.id, consumer!.id)!;
        const consumptionAuthority = {
          task_id: owner.id,
          run_id: owner.current_run_id,
          generation: owner.generation,
          objective_revision: owner.objective_revision,
          assignment_id: leased.id,
          assignment_revision: leased.revision,
        };
        f.store.externalWaits.wait(
          {
            ...consumptionAuthority,
            thread_id: graphThreadId('assignment', consumptionAuthority),
            after_cursor: f.store.events(owner.id, identity).next_cursor,
            dependencies: [{ job_id: f.job.id, required: true }],
          },
          identity,
        );
        f.store.externalWaits.resolve(
          f.job.id,
          consumptionAuthority,
          identity,
          {
            decision: 'replan',
            reason:
              'The inspected candidate does not establish accepted evidence.',
          },
        );
        f.store.nightshiftTransfers.resolve(
          {
            task_id: owner.id,
            run_id: owner.current_run_id,
            generation: owner.generation,
            objective_revision: owner.objective_revision,
            assignment_id: leased.id,
            assignment_revision: leased.revision,
          },
          f.job.id,
          identity,
          'replan',
        );
        f.store.completeAssignment(owner.id, leased.id, owner.generation, {
          status: 'completed',
          support: 'gap',
          gaps: ['The candidate establishes no accepted finding.'],
        });
        const manager = f.store.ensureManager(owner.id, owner.current_run_id, {
          role: 'Manager',
          definition_id: 'core.manager.coordinator',
          definition_version: 'fixture.v1',
          capability: 'core.manager',
          brief: 'Report the exact remaining deliverable gap.',
          tools,
        });
        f.store.acquireAssignment(owner.id, manager.id);
        f.store.nightshiftTransfers.reportUnresolved(
          {
            task_id: owner.id,
            run_id: owner.current_run_id,
            generation: owner.generation,
            objective_revision: owner.objective_revision,
          },
          identity,
          [second.id],
          'The second required external result is still pending; it is an unresolved deliverable.',
        );
        f.store.completeAssignment(owner.id, manager.id, owner.generation, {
          status: 'completed',
          support: 'gap',
          gaps: ['Second required result is pending.'],
        });
        f.store.saveResult(owner.id, owner.current_run_id, owner.generation, {
          schema_version: 'haze.task.result.v3',
          answer: 'The second result remains pending; no finding is accepted.',
          completion: 'partial',
          work_products: [],
          sources: [],
          covered_scope: {},
          uncertainty: ['Required external work is unresolved.'],
          review: {
            status: 'needs_review',
            scope: 'No completed evidence review.',
            limitations: ['The pending candidate is not accepted evidence.'],
          },
          currency: 'current',
          next_requirements: [
            'Inspect the second required result when it arrives.',
          ],
          provenance: {
            mode: 'fixture',
            model_calls: 0,
            tool_calls: 0,
            capabilities: [],
            receipts: [],
          },
        });
        await s.value.tick();
        expect(f.store.read(owner.id, identity).runs).toHaveLength(2);
        expect(f.store.nightshift.chain(chain.id, identity).status).toBe(
          'active',
        );
      } else
        f.store.stop(
          f.task.id,
          'timed_out',
          'deadline_exceeded',
          'The first successor expired before the second external job completed.',
        );
      finish(f, second);
      await s.value.tick();
      owner = f.store.read(f.task.id, identity);
      inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
      expect(owner.runs).toHaveLength(3);
      expect(inbox).toHaveLength(ending === 'reported_unresolved' ? 1 : 2);
      expect(
        inbox.every(
          (item) =>
            item.required &&
            item.original_authority.run_id === f.task.current_run_id,
        ),
      ).toBe(true);
      expect(
        f.store.nightshift.automationView(chain.id, identity).used_followups,
      ).toBe(2);
      const final = f.store.nightshift.chain(chain.id, identity);
      expect(final.usage.jobs).toBe(2);
      expect(final.usage.requested_attempts).toBe(2);
      expect(final.expires_at).toBe(f.chain.expires_at);
    },
  );
  it('delegates acknowledged optional pending work and waits for current execution before considering its later result', async () => {
    const f = fixture();
    f.store.nightshift.acknowledge(f.job.id, `fixture-${f.job.id}`);
    const source = f.store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'optional-source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'A genuinely changed source for the optional candidate.',
        ).toString('base64'),
      },
      identity,
      'optional-source',
    ).artifact;
    const ref = {
      id: source.id,
      version: source.version,
      sha256: source.sha256,
    };
    f.store.recordApplicability(
      f.task.id,
      identity,
      ref,
      true,
      'Explicitly inspected optional source.',
      'Runtime',
    );
    let task = f.store.read(f.task.id, identity),
      chain = f.store.nightshift.chain(f.chain.id, identity);
    const prior = f.store.nightshift.progress(chain.id, identity)!;
    f.store.nightshift.proposeProgress(
      chain.id,
      {
        schema_version: 'haze.nightshift.chain.progress.proposal.v1',
        ...authority(task),
        expected_chain_revision: chain.revision,
        progress: { ...prior.progress, input_refs: [ref] },
      },
      'optional-purpose',
      identity,
    );
    task = f.store.read(f.task.id, identity);
    chain = f.store.nightshift.chain(chain.id, identity);
    const second = f.store.nightshift.reserveJob(
      {
        schema_version: 'haze.nightshift.job.submit.v1',
        privacy: 'local-only',
        max_spend_usd: 0,
        chain_id: chain.id,
        ...authority(task),
        expected_chain_revision: chain.revision,
        prompt: 'Inspect the optional changed source.',
        purpose: 'critique_candidate',
        input_refs: [ref],
        n: 1,
        role: 'Manager',
      },
      'optional-job',
      identity,
      {
        adapter_version: 'fixture',
        runtime_version: 'fixture',
        schema_hash: 'fixture',
      },
    ).job;
    f.store.nightshift.acknowledge(second.id, `fixture-${second.id}`);
    finish(f);
    expire(f);
    const s = service(f, {
      admit: (request) => f.store.linkedRuns.admit(request),
    });
    await s.value.tick();
    const successor = f.store.read(f.task.id, identity).current_run_id;
    let inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
    expect(inbox).toHaveLength(2);
    expect(inbox.every((item) => !item.required)).toBe(true);
    expect(inbox.find((item) => item.job_id === second.id)).toMatchObject({
      execution_state: 'queued',
      target_run_id: successor,
      original_authority: { run_id: f.task.current_run_id },
    });
    finish(f, second);
    await s.value.tick();
    expect(f.store.read(f.task.id, identity).current_run_id).toBe(successor);
    expect(f.store.read(f.task.id, identity).runs).toHaveLength(2);
    f.store.stop(
      f.task.id,
      'timed_out',
      'deadline_exceeded',
      'Current successor ended after the optional result arrived.',
    );
    await s.value.tick();
    const final = f.store.read(f.task.id, identity);
    inbox = f.store.nightshiftTransfers.inbox(f.task.id, identity);
    expect(final.runs).toHaveLength(3);
    expect(inbox).toHaveLength(2);
    expect(
      inbox.every(
        (item) =>
          !item.required &&
          item.original_authority.run_id === f.task.current_run_id,
      ),
    ).toBe(true);
    expect(
      f.store.nightshift.automationView(chain.id, identity).used_followups,
    ).toBe(2);
    expect(f.store.nightshift.chain(chain.id, identity).usage.jobs).toBe(2);
    expect(f.store.nightshift.chain(chain.id, identity).expires_at).toBe(
      f.chain.expires_at,
    );
  });
  it('shares actual FIFO capacity across two automatic chains without allowing new admissions to jump them', async () => {
    const first = fixture(),
      second = fixture(true, false, first.store);
    finish(first);
    finish(second);
    expire(first);
    expire(second);
    const admitBusy = (key: string) =>
      first.store.admit(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: `Occupy capacity ${key}.`,
        }),
        identity,
        key,
      ).task;
    const busyOne = admitBusy('busy-one'),
      busyTwo = admitBusy('busy-two');
    let s = service(first, {
      admit: (request) => first.store.linkedRuns.admit(request),
    });
    await s.value.tick();
    const firstDecision = s.value.decisions(first.chain.id, identity)[0]!,
      secondDecision = s.value.decisions(second.chain.id, identity)[0]!;
    expect(firstDecision.state).toBe('waiting');
    expect(secondDecision.state).toBe('waiting');
    expect(firstDecision.queue_sequence!).toBeLessThan(
      secondDecision.queue_sequence!,
    );
    await s.value.tick();
    expect(s.value.decisions(first.chain.id, identity)[0]!.queue_sequence).toBe(
      firstDecision.queue_sequence,
    );
    expect(() => admitBusy('cannot-jump')).toThrow('priority');
    await s.value.close();
    first.store.close();
    const reopened = new TaskStore(first.directory);
    stores.push(reopened);
    first.store = reopened;
    second.store = reopened;
    s = service(first, {
      admit: (request) => reopened.linkedRuns.admit(request),
    });
    await s.value.tick();
    expect(s.value.decisions(first.chain.id, identity)[0]!.queue_sequence).toBe(
      firstDecision.queue_sequence,
    );
    expect(
      s.value.decisions(second.chain.id, identity)[0]!.queue_sequence,
    ).toBe(secondDecision.queue_sequence);
    first.store.stop(
      busyOne.id,
      'timed_out',
      'fixture_finished',
      'First occupied permit released.',
    );
    await s.value.tick();
    expect(first.store.read(first.task.id, identity).runs).toHaveLength(2);
    expect(first.store.read(second.task.id, identity).runs).toHaveLength(1);
    expect(
      (
        first.store.db
          .prepare(
            "SELECT count(*) n FROM task_capacity_permits WHERE status='held'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
    expect(
      s.value.decisions(second.chain.id, identity)[0]!.queue_sequence,
    ).toBe(secondDecision.queue_sequence);
    first.store.stop(
      busyTwo.id,
      'timed_out',
      'fixture_finished',
      'Second occupied permit released.',
    );
    await s.value.tick();
    expect(first.store.read(second.task.id, identity).runs).toHaveLength(2);
    expect(
      (
        first.store.db
          .prepare(
            "SELECT count(*) n FROM task_capacity_permits WHERE status='held'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
    expect(
      first.store.nightshift.automationView(first.chain.id, identity)
        .used_followups,
    ).toBe(1);
    expect(
      first.store.nightshift.automationView(second.chain.id, identity)
        .used_followups,
    ).toBe(1);
  });
  it('stops automatic admission at its separate quota while preserving explicitly authorized manual successors', async () => {
    const f = fixture(true, false, undefined, {
      totalRuns: 4,
      automaticRuns: 1,
    });
    finish(f);
    expire(f);
    const s = service(f, {
      admit: (request) => f.store.linkedRuns.admit(request),
    });
    await s.value.tick();
    f.store.stop(
      f.task.id,
      'timed_out',
      'deadline_exceeded',
      'The authorized automatic successor is quiescent.',
    );
    await s.value.tick();
    const before = f.store.nightshift.chain(f.chain.id, identity);
    expect(before.status).toBe('active');
    expect(before.remaining.runs).toBe(2);
    expect(
      f.store.nightshift.automationView(before.id, identity).stops.at(-1)?.code,
    ).toBe('automatic_followups_exhausted');
    const current = f.store.read(f.task.id, identity);
    f.store.control(current.id, identity, 'remaining-manual-continue', {
      schema_version: 'haze.task.control.v3',
      ...authority(current),
      action: 'continue',
    });
    const after = f.store.nightshift.chain(before.id, identity);
    expect(after.usage.runs).toBe(3);
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.grant).toEqual(before.grant);
    expect(f.store.nightshift.automationView(after.id, identity)).toMatchObject(
      { used_followups: 1, remaining_followups: 0, next_purpose: null },
    );
  });
});
