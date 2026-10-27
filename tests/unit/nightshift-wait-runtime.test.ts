import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managerAgent } from '../../app/agents/manager/index.js';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import type {
  ManagerContext,
  ManagerAction,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type { NightshiftJobReadiness } from '../../app/contracts/nightshift.js';
import {
  ExecutionRegistry,
  type NightshiftJobPort,
} from '../../app/orchestration/ports.js';
import { createNightshiftTools } from '../../app/tasks/nightshift-tools.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until<T>(
  read: () => T,
  predicate: (value: T) => boolean,
): Promise<T> {
  // Expiry scenarios advance Date; the test's own bound stays on a monotonic clock.
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(
    `Isolated external-wait trace did not settle: ${JSON.stringify(read())}`,
  );
}
const authority = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});

async function fixture(resultBeforePark = false, totalRuns = 1) {
  const directory = await mkdtemp(
    join(tmpdir(), 'haze-external-wait-runtime-'),
  );
  let finished = false;
  const ready: NightshiftJobReadiness = {
    schema_version: 'haze.nightshift.jobs.readiness.v1',
    checked_at: new Date().toISOString(),
    cli_available: true,
    schema_compatible: true,
    runtime_reachable: true,
    local_only_enforced: true,
    local_compute_available: false,
    cloud_compute_available: true,
    cloud_enforced: true,
    ready: true,
    runtime_version: 'fixture-only',
    adapter_version: 'fixture-only',
    schema_hash: 'fixture-only',
    can_reconcile: false,
    cancellation_idempotent: false,
    reason: null,
    options: {
      judges: ['accuracy'],
      budgets: ['low'],
      windows: ['now'],
      max_attempts: 16,
      fleets: [],
    },
  };
  const submit = vi.fn(() =>
    Promise.resolve({ remote_id: 'fixture-external-job' }),
  );
  const adapter: NightshiftJobPort = {
    readiness: vi.fn(() => Promise.resolve(ready)),
    submit,
    inspect: vi.fn(() =>
      Promise.resolve({
        remote_id: 'fixture-external-job',
        execution_state: finished ? 'completed' : 'running',
        terminal: finished,
        generated: finished ? 1 : 0,
        requested_attempts: 1,
        privacy: 'cloud-ok',
        fleet: null,
        runtime_version: 'fixture-only',
      }),
    ),
    outcome: vi.fn(() =>
      Promise.resolve({
        status: 'accepted' as const,
        basis: 'fixture only',
        explanation: null,
      }),
    ),
    result: vi.fn(() =>
      Promise.resolve({
        text: 'A synthetic evidence-linked critique; it establishes no scientific finding.',
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
  };
  const registry = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent({
      id: 'EvidenceCritic',
      version: 'fixture.v1',
      instructions: 'Exercise explicit external-wait control flow only.',
    })
    .registerCapability({
      card: {
        id: 'test.external-wait',
        version: '1',
        purpose: 'Exercise external-wait authority.',
        work_products: [],
        required_tools: [],
        roles: ['EvidenceCritic'],
        readiness: 'implemented',
        limitations: ['Synthetic fixture only.'],
      },
      matches: () => true,
      assignments: () => [],
    })
    .registerAssignment({
      id: 'test.external-wait.critic',
      version: '1',
      capability: 'test.external-wait',
      agent: 'EvidenceCritic',
      tools: ['nightshift.submit', 'nightshift.result'],
      instructions:
        'Use exact registered source references. Await the acknowledged candidate before consuming it.',
    });
  for (const tool of createNightshiftTools('live')) registry.registerTool(tool);
  let chainId = '';
  let specialistTurns = 0;
  const correctedContexts: unknown[] = [];
  let taskId = '';
  const model: AgentModel = {
    selection: { provider: 'scripted', model: 'external-wait-fixture' },
    async complete(input) {
      if (input.role === 'Manager') {
        const context = input.context as ManagerContext;
        const planned = context.assignments.some(
          (item) => item.definition_id === 'test.external-wait.critic',
        );
        const specialistComplete = context.assignments.some(
          (item) =>
            item.definition_id === 'test.external-wait.critic' &&
            item.status === 'completed',
        );
        const action: ManagerAction = specialistComplete
          ? {
              type: 'finalize',
              answer:
                'The synthetic candidate was delivered and consumed from the supplied source [S1]. This fixture establishes no scientific evidence.',
              work_products: [],
              sources: context.request.context_refs,
              uncertainty: [
                'Independent evidence acceptance remains outside this fixture.',
              ],
              unfinished: ['Scientific review and evidence acceptance.'],
            }
          : planned
            ? {
                type: 'wait',
                reason:
                  'The exact external dependency and specialist outcome remain governed by the existing run.',
              }
            : {
                type: 'apply_plan',
                assignments: [
                  {
                    key: 'critic',
                    definition_id: 'test.external-wait.critic',
                    brief: 'Produce one bounded synthetic critique candidate.',
                    depends_on: [],
                    max_model_calls: 8,
                  },
                ],
                retain_assignment_ids: [],
                reason: 'Admit the explicitly granted fixture assignment.',
              };
        return Promise.resolve(
          JSON.stringify({
            id: randomUUID(),
            run_id: context.run_id,
            generation: context.generation,
            objective_revision: context.objective_revision,
            plan_revision: context.plan_revision,
            event_cursor: context.event_cursor,
            explanation: 'Fixture decision for the exact current run.',
            references: [],
            ...(!context.interpretation
              ? {
                  interpretation: {
                    scope: context.request.objective,
                    deliverables: ['A synthetic critique candidate.'],
                    assumptions: [],
                    intended_use: 'Runtime control-flow verification.',
                    stopping_conditions: [
                      'Consume the exact delivered candidate under current authority.',
                    ],
                  },
                }
              : {}),
            action,
          }),
        );
      }
      const task = instance.store.read(taskId, localTaskIdentity);
      if (task.objective_revision > 1) {
        correctedContexts.push(input.context);
        return JSON.stringify({
          id: 'clarify-revised-objective',
          type: 'question',
          prompt: 'Which revised evidence should the corrected assignment use?',
        });
      }
      specialistTurns++;
      const chain = instance.store.nightshift.chain(chainId, localTaskIdentity);
      const job = instance.store.nightshift.jobs(localTaskIdentity)[0];
      if (specialistTurns === 2 && resultBeforePark) {
        finished = true;
        instance.store.nightshift.schedulePoll(
          job!.id,
          new Date(0).toISOString(),
        );
        await instance.nightshift.pollNow();
        await until(
          () => instance.store.nightshift.job(job!.id, localTaskIdentity),
          (value) => value.receipt !== null,
        );
        expect(
          instance.store.externalWaits.view(taskId, localTaskIdentity).waits,
        ).toHaveLength(0);
      }
      const action =
        specialistTurns === 1
          ? {
              id: 'submit-once',
              type: 'tool',
              tool: 'nightshift.submit',
              input: {
                schema_version: 'haze.nightshift.tool.submit.v1',
                chain_id: chainId,
                expected_chain_revision: chain.revision,
                purpose: 'critique_candidate',
                prompt:
                  'Draft a bounded critique of the supplied synthetic source.',
                n: 1,
                judge: 'accuracy',
                budget: 'low',
                window: 'now',
                privacy: chain.grant.privacy,
                max_spend_usd: chain.grant.max_spend_usd,
                input_refs: task.original_request.context_refs,
              },
            }
          : specialistTurns === 2
            ? {
                id: 'park-on-external',
                type: 'external_wait',
                schema_version: 'haze.external.wait.action.v1',
                dependencies: [{ job_id: job!.id, required: true }],
              }
            : specialistTurns === 3
              ? {
                  id: 'consume-exact-result',
                  type: 'tool',
                  tool: 'nightshift.result',
                  input: {
                    schema_version: 'haze.nightshift.tool.result.v1',
                    job_id: job!.id,
                    decision: 'use_candidate',
                    reason:
                      'Consume this exact synthetic critique candidate without declaring evidence acceptance.',
                  },
                }
              : {
                  id: 'complete-fixture',
                  type: 'finish',
                  summary:
                    'The exact synthetic candidate was received through the controlled result tool.',
                  support: 'gap',
                  uncertainty: [
                    'Fixture output establishes no scientific evidence or review acceptance.',
                  ],
                  outputs: [],
                };
      return Promise.resolve(JSON.stringify(action));
    },
  };
  let dispatch: (() => void) | undefined;
  const instance = new TaskRuntime({
    stateDirectory: directory,
    registry,
    // Exercise model-driven Manager routing with injected, explicitly synthetic providers.
    mode: 'live',
    model,
    nightshiftJobs: adapter,
    nightshiftPollIntervalMs: 10,
    env: {},
    limits: { max_model_calls: 30, max_tool_calls: 8 },
    dispatchTask: (_id, start) => {
      dispatch = start;
    },
  });
  cleanups.push(async () => {
    await instance.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (!inside || inside.startsWith('..'))
      throw new Error('Unsafe isolated wait-state cleanup.');
    await rm(directory, { recursive: true, force: true });
  });
  const source = instance.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'synthetic-notes.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(
        'Synthetic source: every conclusion still requires independent checking.',
      ).toString('base64'),
    },
    'fixture-source',
  );
  taskId = instance.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Exercise a bounded external-wait critique.',
      context_refs: [
        { id: source.id, version: source.version, sha256: source.sha256 },
      ],
      nightshift_tools: ['nightshift.submit', 'nightshift.result'],
    },
    'fixture-task',
  ).task_id;
  const admitted = instance.store.read(taskId, localTaskIdentity);
  const chain = await instance.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: taskId,
      ...authority(admitted),
      total_runs: totalRuns,
      max_jobs: 1,
      max_attempts: 1,
    },
    'fixture-chain',
    localTaskIdentity,
  );
  chainId = chain.id;
  const readView = () => {
    const task = instance.store.read(taskId, localTaskIdentity);
    if (['failed', 'paused', 'timed_out', 'cancelled'].includes(task.status))
      throw new Error(`External-wait fixture stopped: ${JSON.stringify(task)}`);
    return {
      ...instance.store.externalWaits.view(taskId, localTaskIdentity),
      trace: {
        assignments: task.assignments.map(
          ({ id, definition_id, status, lease_token }) => ({
            id,
            definition_id,
            status,
            lease_token,
          }),
        ),
        graph_waits: instance.store.db
          .prepare('SELECT body FROM graph_waits')
          .all(),
        operations: instance.store.db
          .prepare(
            "SELECT body FROM graph_operations WHERE json_extract(body,'$.status') IN ('dispatched','unknown')",
          )
          .all(),
        attempts: instance.store
          .attempts(taskId, localTaskIdentity)
          .filter((item) => ['started', 'unknown'].includes(item.status)),
      },
    };
  };
  return {
    instance,
    taskId,
    chainId,
    admitted,
    submit,
    start: () => {
      expect(dispatch).toBeTypeOf('function');
      dispatch!();
    },
    finishRemote: async () => {
      finished = true;
      const job = instance.store.nightshift.jobs(localTaskIdentity)[0]!;
      instance.store.nightshift.schedulePoll(job.id, new Date(0).toISOString());
      await instance.nightshift.pollNow();
      return until(
        () => instance.store.nightshift.job(job.id, localTaskIdentity),
        (value) => value.receipt !== null,
      );
    },
    turns: () => specialistTurns,
    correctedContexts,
    readView,
    readTask: () => instance.store.read(taskId, localTaskIdentity),
  };
}

it.each([false, true])(
  'receipts one specialist submission and consumes its exact result with result-before-park=%s',
  async (resultBeforePark) => {
    const {
      instance,
      taskId,
      chainId,
      admitted,
      submit,
      start,
      finishRemote,
      turns,
      readView,
    } = await fixture(resultBeforePark);
    start();
    const parked = await until(readView, (view) =>
      resultBeforePark
        ? view.waits.length > 0
        : view.waits.some((wait) => wait.state === 'waiting') &&
          view.capacity.permit === 'released',
    );
    const specialist = instance.store
      .read(taskId, localTaskIdentity)
      .assignments.find(
        (item) => item.definition_id === 'test.external-wait.critic',
      )!;
    if (!resultBeforePark) {
      expect(specialist.status).toBe('waiting');
      expect(specialist.lease_token).toBeUndefined();
      expect(parked.capacity.wait_reason).toBe('compute');
    }
    expect(parked.waits[0]!.authority.assignment_id).toBe(specialist.id);
    const job = instance.store.nightshift.jobs(localTaskIdentity)[0]!;
    expect(job.remote_id).toBe('fixture-external-job');
    expect(submit).toHaveBeenCalledOnce();
    await finishRemote();
    const delivered = await until(readView, (view) =>
      view.deliveries.some((delivery) => delivery.state === 'consumed'),
    );
    const completed = await until(
      () => instance.store.read(taskId, localTaskIdentity),
      (task) =>
        task.assignments.some(
          (item) => item.id === specialist.id && item.status === 'completed',
        ),
    );
    const final = await until(
      () => instance.store.read(taskId, localTaskIdentity),
      (task) => ['completed', 'failed', 'paused'].includes(task.status),
    );
    expect(final.status, final.error?.message).toBe('completed');
    expect(final.result?.completion).toBe('partial');
    expect(delivered.deliveries).toHaveLength(1);
    expect(delivered.deliveries[0]!.job_id).toBe(job.id);
    expect(delivered.deliveries[0]!.artifact).toEqual(
      instance.store.nightshift.job(job.id, localTaskIdentity).receipt!
        .artifact,
    );
    expect(delivered.waits[0]!.authority.assignment_revision).toBe(
      specialist.revision,
    );
    expect(delivered.waits[0]!.state).toBe('consumed');
    expect(submit).toHaveBeenCalledOnce();
    expect(completed.current_run_id).toBe(admitted.current_run_id);
    expect(completed.generation).toBe(admitted.generation);
    expect(
      instance.store.nightshift.chain(chainId, localTaskIdentity).usage,
    ).toMatchObject({ jobs: 1, requested_attempts: 1 });
    expect(turns()).toBe(4);
  },
  30_000,
);

it.each(['task', 'chain'] as const)(
  'retains a late result after %s pause and consumes it only after explicit task Resume',
  async (target) => {
    const state = await fixture();
    state.start();
    await until(state.readView, (view) => view.capacity.permit === 'released');
    const before = state.readTask();
    const originalChain = state.instance.store.nightshift.chain(
      state.chainId,
      localTaskIdentity,
    );
    const chainControl = (action: 'pause' | 'resume', key: string) => {
      const task = state.readTask();
      const chain = state.instance.store.nightshift.chain(
        state.chainId,
        localTaskIdentity,
      );
      return state.instance.nightshift.controlChain(
        state.chainId,
        {
          schema_version: 'haze.nightshift.chain.control.v1',
          action,
          ...authority(task),
          expected_chain_revision: chain.revision,
        },
        key,
        localTaskIdentity,
      );
    };
    if (target === 'chain') chainControl('pause', 'chain-pause');
    else
      state.instance.control(
        state.taskId,
        {
          schema_version: 'haze.task.control.v3',
          action: 'pause',
          ...authority(before),
        },
        'task-pause',
      );
    const paused = state.readTask();
    expect(paused.status).toBe('paused');
    expect(paused.limits.deadline).toBe(before.limits.deadline);
    const receipt = await state.finishRemote();
    await until(
      () =>
        state.instance.store.externalWaits.view(
          state.taskId,
          localTaskIdentity,
        ),
      (view) => view.deliveries.length === 1,
    );
    expect(state.turns()).toBe(2);
    expect(state.readTask().status).toBe('paused');
    expect(
      state.instance.store.externalWaits.view(state.taskId, localTaskIdentity)
        .deliveries[0]!.state,
    ).toBe('fenced');
    expect(receipt.authority.generation).toBe(before.generation);
    if (target === 'chain') {
      chainControl('resume', 'chain-resume');
      await new Promise((done) => setTimeout(done, 150));
      expect(state.readTask().status).toBe('paused');
      expect(state.turns()).toBe(2);
    }
    const current = state.readTask();
    state.instance.control(
      state.taskId,
      {
        schema_version: 'haze.task.control.v3',
        action: 'resume',
        ...authority(current),
      },
      'task-resume',
    );
    state.start();
    const final = await until(state.readTask, (task) =>
      ['completed', 'failed', 'paused'].includes(task.status),
    );
    expect(final.status, final.error?.message).toBe('completed');
    expect(final.current_run_id).toBe(before.current_run_id);
    expect(final.limits.deadline).toBe(before.limits.deadline);
    expect(state.turns()).toBe(4);
    expect(state.submit).toHaveBeenCalledOnce();
    const chain = state.instance.store.nightshift.chain(
      state.chainId,
      localTaskIdentity,
    );
    expect(chain.grant).toEqual(originalChain.grant);
    expect(chain.expires_at).toBe(originalChain.expires_at);
    expect(chain.usage.jobs).toBe(1);
    expect(chain.usage.requested_attempts).toBe(1);
    const view = state.instance.store.externalWaits.view(
      state.taskId,
      localTaskIdentity,
    );
    expect(
      view.waits.some(
        (wait) =>
          wait.authority.generation === final.generation &&
          wait.state === 'consumed',
      ),
    ).toBe(true);
    expect(
      view.deliveries.filter((delivery) => delivery.state === 'consumed'),
    ).toHaveLength(1);
  },
  30_000,
);

it('fences original delivery authority after objective correction and assignment supersession', async () => {
  const state = await fixture();
  state.start();
  const parked = await until(
    state.readView,
    (view) => view.capacity.permit === 'released',
  );
  const before = state.readTask();
  const assignment = before.assignments.find(
    (item) => item.definition_id === 'test.external-wait.critic',
  )!;
  state.instance.update(
    state.taskId,
    {
      schema_version: 'haze.task.update.v3',
      kind: 'correction',
      passage:
        'Use the corrected objective; old candidate output is historical.',
      affected_assignment_ids: [assignment.id],
      ...authority(before),
    },
    'correct-objective',
  );
  const corrected = state.readTask();
  expect(corrected.objective_revision).toBe(before.objective_revision + 1);
  expect(
    corrected.assignments.find((item) => item.id === assignment.id)!.revision,
  ).toBe(assignment.revision + 1);
  const retained = await state.finishRemote();
  await until(
    () =>
      state.instance.store.externalWaits.view(state.taskId, localTaskIdentity),
    (view) => view.deliveries.length === 1,
  );
  await new Promise((done) => setTimeout(done, 150));
  const view = state.instance.store.externalWaits.view(
    state.taskId,
    localTaskIdentity,
  );
  expect(view.waits).toHaveLength(1);
  expect(view.waits[0]!.authority).toEqual(parked.waits[0]!.authority);
  expect(view.waits[0]!.state).toBe('fenced');
  expect(view.deliveries[0]!.state).toBe('fenced');
  expect(view.capacity.queue?.status).not.toBe('eligible');
  expect(retained.authority.objective_revision).toBe(before.objective_revision);
  expect(retained.authority.assignment_revision).toBe(assignment.revision);
  expect(state.turns()).toBe(2);
  // The corrected objective needs a separately admitted grant; the old chain
  // cannot spend its original objective's allowance on revised execution.
  expect(state.readTask().status).toBe('paused');
  expect(state.correctedContexts).toHaveLength(0);
  for (const context of state.correctedContexts)
    expect(context).toMatchObject({ nightshift_delivered_candidates: [] });
  expect(state.submit).toHaveBeenCalledOnce();
  expect(
    state.instance.store.nightshift.chain(state.chainId, localTaskIdentity)
      .status,
  ).toBe('invalidated');
}, 30_000);

it('retains an expired result without a successor until explicit same-chain Continue preserves the remaining grant', async () => {
  const state = await fixture(false, 2);
  state.start();
  await until(state.readView, (view) => view.capacity.permit === 'released');
  const before = state.readTask();
  const originalChain = state.instance.store.nightshift.chain(
    state.chainId,
    localTaskIdentity,
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(before.limits.deadline) + 1);
  try {
    const expired = await until(
      state.readTask,
      (task) => task.status === 'timed_out',
    );
    expect(expired.runs).toHaveLength(1);
    const retained = await state.finishRemote();
    await until(
      () =>
        state.instance.store.externalWaits.view(
          state.taskId,
          localTaskIdentity,
        ),
      (view) => view.deliveries.length === 1,
    );
    await new Promise((done) => setTimeout(done, 150));
    const stopped = state.readTask();
    expect(stopped.current_run_id).toBe(before.current_run_id);
    expect(stopped.runs).toHaveLength(1);
    expect(stopped.status).toBe('timed_out');
    expect(state.turns()).toBe(2);
    expect(retained.receipt).not.toBeNull();
    expect(
      state.instance.store.externalWaits.view(state.taskId, localTaskIdentity)
        .deliveries[0]!.state,
    ).toBe('fenced');
    expect(() =>
      state.instance.control(
        state.taskId,
        {
          schema_version: 'haze.task.control.v3',
          action: 'resume',
          ...authority(stopped),
        },
        'expired-resume',
      ),
    ).toThrow();
    state.instance.control(
      state.taskId,
      {
        schema_version: 'haze.task.control.v3',
        action: 'continue',
        ...authority(stopped),
      },
      'explicit-continue',
    );
    const successor = state.readTask();
    expect(successor.current_run_id).not.toBe(before.current_run_id);
    expect(successor.runs).toHaveLength(2);
    expect(successor.runs.at(-1)!.predecessor_run_id).toBe(
      before.current_run_id,
    );
    const chain = state.instance.store.nightshift.chain(
      state.chainId,
      localTaskIdentity,
    );
    expect(chain.id).toBe(originalChain.id);
    expect(chain.grant).toEqual(originalChain.grant);
    expect(chain.expires_at).toBe(originalChain.expires_at);
    expect(chain.usage.runs).toBe(2);
    expect(chain.usage.jobs).toBe(1);
    expect(chain.usage.requested_attempts).toBe(1);
    expect(chain.remaining.jobs).toBe(originalChain.remaining.jobs);
    expect(chain.remaining.requested_attempts).toBe(
      originalChain.remaining.requested_attempts,
    );
    expect(chain.usage.model_calls).toBeGreaterThanOrEqual(
      originalChain.usage.model_calls,
    );
    expect(state.submit).toHaveBeenCalledOnce();
    expect(
      state.instance.store.externalWaits
        .view(state.taskId, localTaskIdentity)
        .waits.every((wait) => wait.authority.run_id === before.current_run_id),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
}, 30_000);
