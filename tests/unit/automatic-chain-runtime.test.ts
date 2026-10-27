import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managerAgent } from '../../app/agents/manager/index.js';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import type {
  ManagerAction,
  ManagerContext,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import {
  automaticReadinessSchema,
  automaticReleaseBlocked,
} from '../../app/contracts/nightshift-automatic.js';
import {
  ExecutionRegistry,
  type NightshiftJobPort,
} from '../../app/orchestration/ports.js';
import { createNightshiftTools } from '../../app/tasks/nightshift-tools.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function until<T>(
  read: () => T,
  test: (value: T) => boolean,
): Promise<T> {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const value = read();
    if (test(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(
    `Automatic chain fixture did not settle: ${JSON.stringify(read())}`,
  );
}
const authority = (task: TaskRecord) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
const releasedFixture = () =>
  Promise.resolve(
    automaticReadinessSchema.parse({
      schema_version: 'haze.nightshift.automatic.readiness.v1',
      released: true,
      ready: true,
      reason: 'Synthetic control-flow evidence only.',
      evidence_id: 'automatic-runtime-fixture',
      evidence_kind: 'fixture',
      gates: [
        {
          id: 'isolated-fixture',
          label: 'Synthetic prerequisite fixture',
          passed: true,
          reason: null,
        },
      ],
    }),
  );

async function fixture(released = true) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-automatic-runtime-'));
  let finished = false,
    chainId = '',
    taskId = '',
    initialRun = '',
    initialTurns = 0,
    successorTurns = 0;
  const successorModelInputs: unknown[] = [];
  const submit = vi.fn(() =>
    Promise.resolve({ remote_id: 'automatic-fixture-job' }),
  );
  const port: NightshiftJobPort = {
    readiness: () =>
      Promise.resolve({
        schema_version: 'haze.nightshift.jobs.readiness.v1',
        checked_at: new Date().toISOString(),
        cli_available: true,
        schema_compatible: true,
        runtime_reachable: true,
        local_only_enforced: true,
        local_compute_available: true,
        cloud_enforced: false,
        ready: true,
        runtime_version: 'fixture',
        adapter_version: 'fixture',
        schema_hash: 'fixture',
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
      }),
    submit,
    inspect: () =>
      Promise.resolve({
        remote_id: 'automatic-fixture-job',
        execution_state: finished ? 'completed' : 'running',
        terminal: finished,
        generated: finished ? 1 : 0,
        requested_attempts: 1,
        privacy: 'local-only',
        fleet: null,
        runtime_version: 'fixture',
      }),
    outcome: () =>
      Promise.resolve({
        status: 'accepted',
        basis: 'Synthetic judge only.',
        explanation: null,
      }),
    result: () =>
      Promise.resolve({
        text: 'Synthetic critique candidate; this is not independent evidence acceptance.',
        attempts: [],
        winner_seq: null,
        retrieval_error: null,
        truncated: false,
      }),
    cancel: () => Promise.resolve({ acknowledged: true }),
    verifyReconciliation: () =>
      Promise.resolve({ verified: false, reason: null }),
  };
  const registry = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent({
      id: 'EvidenceCritic',
      version: 'fixture.v1',
      instructions:
        'Exercise bounded candidate delivery without claiming scientific support.',
    })
    .registerCapability({
      card: {
        id: 'test.automatic-chain',
        version: '1',
        purpose: 'Verify linked-run control flow.',
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
      id: 'test.automatic-chain.critic',
      version: '1',
      capability: 'test.automatic-chain',
      agent: 'EvidenceCritic',
      tools: ['nightshift.submit', 'nightshift.result'],
      instructions:
        'Produce or inspect an exact unreviewed critique candidate.',
    });
  for (const tool of createNightshiftTools('live')) registry.registerTool(tool);
  const model: AgentModel = {
    selection: { provider: 'scripted', model: 'automatic-fixture' },
    complete(input) {
      const task = instance.store.read(taskId, localTaskIdentity);
      const isSuccessor = task.current_run_id !== initialRun;
      if (input.role === 'Manager') {
        const context = input.context as ManagerContext & {
          nightshift_successor_inbox?: { job_id: string }[];
        };
        if (isSuccessor) successorModelInputs.push(input.context);
        const planned = context.assignments.some(
          (a) => a.definition_id === 'test.automatic-chain.critic',
        );
        const complete = context.assignments.some(
          (a) =>
            a.definition_id === 'test.automatic-chain.critic' &&
            a.status === 'completed',
        );
        const source = context.request.context_refs[0]!;
        let action: ManagerAction;
        if (
          isSuccessor &&
          !context.source_applicability.some(
            (a) => a.id === source.id && a.current,
          )
        ) {
          action = context.inspections.some((i) => i.artifact.id === source.id)
            ? {
                type: 'applicability',
                artifact: source,
                applicable: true,
                reason:
                  'The exact synthetic source remains relevant to this same objective.',
              }
            : { type: 'inspect', artifacts: [source] };
        } else if (complete)
          action = {
            type: 'finalize',
            answer:
              'The synthetic candidate was inspected against the exact retained source [S1]. Scientific acceptance remains unresolved.',
            work_products: [],
            sources: [source],
            uncertainty: [
              'Synthetic control flow does not establish independent evidence support.',
            ],
            unfinished: ['Independent scientific review.'],
          };
        else if (planned)
          action = {
            type: 'wait',
            reason:
              'Await the exact specialist dependency under its existing grant.',
          };
        else {
          const inbox = context.nightshift_successor_inbox ?? [];
          if (isSuccessor)
            expect(inbox.map((item) => item.job_id)).toEqual([
              instance.store.nightshift.jobs(localTaskIdentity)[0]!.id,
            ]);
          action = {
            type: 'apply_plan',
            assignments: [
              {
                key: 'critic',
                definition_id: 'test.automatic-chain.critic',
                brief: isSuccessor
                  ? 'Inspect the delegated retained critique candidate.'
                  : 'Produce one bounded critique candidate.',
                depends_on: [],
                max_model_calls: 8,
                ...(isSuccessor
                  ? {
                      input: {
                        nightshift_job_ids: inbox.map((item) => item.job_id),
                      },
                    }
                  : {}),
              },
            ],
            retain_assignment_ids: [],
            reason: 'Admit only the exact explicitly granted specialist work.',
          };
        }
        return Promise.resolve(
          JSON.stringify({
            id: randomUUID(),
            run_id: context.run_id,
            generation: context.generation,
            objective_revision: context.objective_revision,
            plan_revision: context.plan_revision,
            event_cursor: context.event_cursor,
            explanation: 'Synthetic Manager decision under current authority.',
            references: [],
            ...(!context.interpretation
              ? {
                  interpretation: {
                    scope: context.request.objective,
                    deliverables: ['A bounded critique candidate.'],
                    assumptions: [],
                    intended_use: 'Control-flow verification only.',
                    stopping_conditions: [
                      'Inspect an exact candidate or report the missing evidence.',
                    ],
                  },
                }
              : {}),
            action,
          }),
        );
      }
      const job = instance.store.nightshift.jobs(localTaskIdentity)[0];
      if (isSuccessor) {
        successorTurns++;
        successorModelInputs.push(input.context);
        return Promise.resolve(
          JSON.stringify(
            successorTurns === 1
              ? {
                  id: 'consume-delegated-result',
                  type: 'tool',
                  tool: 'nightshift.result',
                  input: {
                    schema_version: 'haze.nightshift.tool.result.v1',
                    job_id: job!.id,
                    decision: 'use_candidate',
                    reason:
                      'Inspect this delegated exact candidate without treating its judge as scientific acceptance.',
                  },
                }
              : {
                  id: 'finish-successor',
                  type: 'finish',
                  summary:
                    'The delegated synthetic candidate was inspected under current authority.',
                  support: 'gap',
                  uncertainty: [
                    'Independent scientific review remains required.',
                  ],
                  outputs: [],
                },
          ),
        );
      }
      initialTurns++;
      const chain = instance.store.nightshift.chain(chainId, localTaskIdentity);
      return Promise.resolve(
        JSON.stringify(
          initialTurns === 1
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
                    'Write one bounded synthetic critique of the supplied source.',
                  input_refs: task.original_request.context_refs,
                  n: 1,
                  judge: 'accuracy',
                  budget: 'low',
                  window: 'now',
                  privacy: 'local-only',
                  max_spend_usd: 0,
                },
              }
            : {
                id: 'wait-before-expiry',
                type: 'external_wait',
                schema_version: 'haze.external.wait.action.v1',
                dependencies: [{ job_id: job!.id, required: true }],
              },
        ),
      );
    },
  };
  let dispatch: (() => void) | undefined;
  let dispatchReleased = false;
  const instance = new TaskRuntime({
    stateDirectory: directory,
    registry,
    mode: 'live',
    model,
    nightshiftJobs: port,
    nightshiftPollIntervalMs: 10,
    nightshiftAutomaticRelease: released
      ? releasedFixture
      : () =>
          Promise.resolve(automaticReleaseBlocked('Live gates remain unmet.')),
    env: {},
    limits: {
      deadline: new Date(Date.now() + 60000).toISOString(),
      max_model_calls: 30,
      max_tool_calls: 8,
    },
    dispatchTask: (_id, start) => {
      if (dispatchReleased) start();
      else dispatch = start;
    },
  });
  cleanup.push(async () => {
    await instance.close();
    const target = relative(resolve(tmpdir()), resolve(directory));
    if (!target || target.startsWith('..'))
      throw new Error('Unsafe automatic fixture cleanup target.');
    await rm(directory, { recursive: true, force: true });
  });
  const source = instance.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'synthetic-source.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(
        'Synthetic source: generated critiques require independent checking.',
      ).toString('base64'),
    },
    randomUUID(),
  );
  taskId = instance.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Inspect a bounded synthetic critique candidate.',
      context_refs: [
        { id: source.id, version: source.version, sha256: source.sha256 },
      ],
      nightshift_tools: ['nightshift.submit', 'nightshift.result'],
    },
    randomUUID(),
  ).task_id;
  initialRun = instance.store.read(taskId, localTaskIdentity).current_run_id;
  const admission = (automatic: boolean) => {
    const task = instance.store.read(taskId, localTaskIdentity);
    return {
      schema_version: automatic
        ? 'haze.nightshift.chain.admission.v2'
        : 'haze.nightshift.chain.admission.v1',
      task_id: task.id,
      ...authority(task),
      total_runs: 2,
      max_jobs: 2,
      max_attempts: 2,
      lifetime_seconds: 3600,
      privacy: 'local-only',
      max_spend_usd: 0,
      automatic_followup_runs: automatic ? 1 : 0,
      ...(automatic
        ? {
            automatic_opt_in: true,
            initial_progress: {
              schema_version: 'haze.nightshift.progress.v1',
              purpose: 'critique_candidate',
              instruction:
                'Inspect the exact critique candidate when it becomes available.',
              unresolved_deliverables: ['objective'],
              input_refs: task.original_request.context_refs,
              output_refs: [],
              review_objections: [],
              failure_causes: [],
              last_consumed_result_cursor: 0,
            },
          }
        : {}),
    };
  };
  return {
    instance,
    taskId,
    initialRun,
    source,
    submit,
    successorModelInputs,
    admission,
    async admit(automatic: boolean) {
      const chain = await instance.nightshift.admitChain(
        admission(automatic),
        randomUUID(),
        localTaskIdentity,
      );
      chainId = chain.id;
      return chain;
    },
    start() {
      expect(dispatch).toBeTypeOf('function');
      dispatchReleased = true;
      dispatch!();
    },
    async parked() {
      return until(
        () => {
          const task = instance.store.read(taskId, localTaskIdentity);
          if (['failed', 'paused', 'timed_out'].includes(task.status))
            throw new Error(
              `Pre-park task stopped: ${JSON.stringify({ task, chain: instance.store.nightshift.chain(chainId, localTaskIdentity), decisions: instance.automaticChains.decisions(chainId, localTaskIdentity) })}`,
            );
          return instance.store.externalWaits.view(taskId, localTaskIdentity);
        },
        (view) =>
          view.capacity.permit === 'released' && view.waits.length === 1,
      );
    },
    expire() {
      const task = instance.store.read(taskId, localTaskIdentity);
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse(task.limits.deadline) + 1,
      );
    },
    async finish() {
      finished = true;
      const job = instance.store.nightshift.jobs(localTaskIdentity)[0]!;
      instance.store.nightshift.schedulePoll(job.id, new Date(0).toISOString());
      await instance.nightshift.pollNow();
      await until(
        () => instance.store.nightshift.job(job.id, localTaskIdentity),
        (value) => value.receipt !== null,
      );
    },
  };
}

it('admits one automatic successor for a late required result and inspects it through exact Manager and specialist authority', async () => {
  const f = await fixture();
  const chain = await f.admit(true);
  f.start();
  await f.parked();
  f.expire();
  await until(
    () => f.instance.store.read(f.taskId, localTaskIdentity),
    (task) => task.status === 'timed_out',
  );
  await f.finish();
  for (let index = 0; index < 3; index++)
    await f.instance.automaticChains.tick();
  const complete = await until(
    () => f.instance.store.read(f.taskId, localTaskIdentity),
    (task) =>
      task.current_run_id !== f.initialRun &&
      ['completed', 'failed', 'paused'].includes(task.status),
  ).catch((error) => {
    throw new Error(
      `Automatic lifecycle decisions: ${JSON.stringify(f.instance.automaticChains.decisions(chain.id, localTaskIdentity))}; chain: ${JSON.stringify(f.instance.store.nightshift.chain(chain.id, localTaskIdentity))}; ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`,
    );
  });
  expect(complete.status, complete.error?.message).toBe('completed');
  expect(complete.runs).toHaveLength(2);
  const successor = complete.runs.find(
    (run) => run.id === complete.current_run_id,
  )!;
  expect(successor.predecessor_run_id).toBe(f.initialRun);
  expect(Date.parse(successor.limits.deadline)).toBeLessThanOrEqual(
    Date.parse(chain.expires_at),
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
  const original = f.instance.store.nightshift.jobs(localTaskIdentity)[0]!;
  expect(original.authority.run_id).toBe(f.initialRun);
  expect(
    f.instance.store.nightshiftTransfers.inbox(f.taskId, localTaskIdentity),
  ).toMatchObject([{ job_id: original.id, required: true, resolved: true }]);
  expect(
    f.successorModelInputs.some((value) =>
      JSON.stringify(value).includes('nightshift_successor_inbox'),
    ),
  ).toBe(true);
  const deliveredCandidates = f.successorModelInputs.flatMap((value) =>
    typeof value === 'object' &&
    value !== null &&
    'nightshift_delivered_candidates' in value &&
    Array.isArray(value.nightshift_delivered_candidates)
      ? (value.nightshift_delivered_candidates as unknown[])
      : [],
  );
  expect(deliveredCandidates).toContainEqual(
    expect.objectContaining({
      job_id: original.id,
      artifact: original.receipt!.artifact,
      text: original.receipt!.output,
      candidate: true,
      independent_review: 'required',
      judge_is_not_review: true,
    }),
  );
  const finalChain = f.instance.store.nightshift.chain(
    chain.id,
    localTaskIdentity,
  );
  expect(finalChain.expires_at).toBe(chain.expires_at);
  expect(finalChain.grant).toEqual(chain.grant);
  expect(finalChain.usage).toMatchObject({
    runs: 2,
    jobs: 1,
    requested_attempts: 1,
  });
  expect(complete.result?.review.status).not.toBe('supported');
  expect(complete.result?.completion).not.toBe('full');
  await f.instance.automaticChains.tick();
  expect(f.instance.store.read(f.taskId, localTaskIdentity).runs).toHaveLength(
    2,
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
}, 30000);

it('keeps automatic admission blocked by missing live gates and preserves manual-only authority after a late result', async () => {
  const f = await fixture(false);
  await expect(
    f.instance.nightshift.admitChain(
      f.admission(true),
      randomUUID(),
      localTaskIdentity,
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(
    f.instance.store.nightshift.listChains(localTaskIdentity),
  ).toHaveLength(0);
  const chain = await f.admit(false);
  f.start();
  await f.parked();
  f.expire();
  await until(
    () => f.instance.store.read(f.taskId, localTaskIdentity),
    (task) => task.status === 'timed_out',
  );
  await f.finish();
  for (let index = 0; index < 3; index++)
    await f.instance.automaticChains.tick();
  const task = f.instance.store.read(f.taskId, localTaskIdentity);
  expect(task.current_run_id).toBe(f.initialRun);
  expect(task.runs).toHaveLength(1);
  expect(
    f.instance.store.nightshift.chain(chain.id, localTaskIdentity).grant
      .automatic_followup_runs,
  ).toBe(0);
  expect(
    f.instance.store.nightshift.jobs(localTaskIdentity)[0]?.receipt,
  ).not.toBeNull();
  expect(f.submit).toHaveBeenCalledTimes(1);
}, 30000);
