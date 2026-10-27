import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  nightshiftPolicyReady,
  nightshiftVerificationPolicy,
  verifiedNativeAttempts,
} from './nightshift-verification-support.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    output: { type: 'string' },
    'timeout-seconds': { type: 'string', default: '300' },
  },
});
const timeoutSeconds = Number(values['timeout-seconds']);
if (
  !Number.isInteger(timeoutSeconds) ||
  timeoutSeconds < 60 ||
  timeoutSeconds > 600
)
  throw new Error('--timeout-seconds must be between 60 and 600.');
const directory = resolve(
  values.output ?? '.state/nightshift-live-verification',
  randomUUID(),
);
const stateDirectory = join(directory, 'state');
await mkdir(directory, { recursive: true });
const { createNightshiftJobAdapter } = await import('../dist/composition.js');
const { TaskRuntime, localTaskIdentity: identity } =
  await import('../dist/tasks/runtime.js');
const { ExecutionRegistry } = await import('../dist/orchestration/ports.js');
const { createNightshiftTools } =
  await import('../dist/tasks/nightshift-tools.js');
const { managerAgent } = await import('../dist/agents/manager/index.js');
const { INITIAL_AUTOMATIC_SCOPE } =
  await import('../dist/contracts/nightshift-automatic.js');
const { NVIDIA_ULTRA_MODEL, loadRelease, createNightshiftReleasePolicy } =
  await import('../dist/release/nightshift-release.js');
const { resolveAgentModel } = await import('../dist/adapters/agent-model.js');
const policy = nightshiftVerificationPolicy('cloud-ok');
const env = {
  ...process.env,
  STATE_DIR: stateDirectory,
  HAZE_TASK_STATE_DIR: stateDirectory,
  SAMPLE_MODE: 'false',
  HAZE_NIGHTSHIFT_MAX_JOBS: '1',
  HAZE_NIGHTSHIFT_MAX_CHAINS: '1',
};
const adapter = createNightshiftJobAdapter(env);
const report = {
  version: 1,
  mode: values.live
    ? 'provisional-live-cloud-lifecycle'
    : 'read-only-inspection',
  evidence_kind: 'provisional-live',
  production_release_evidence: false,
  started_at: new Date().toISOString(),
  passed: false,
  policy,
  scope: structuredClone(INITIAL_AUTOMATIC_SCOPE),
  readiness: await adapter.readiness(),
  model_calls_by_role: { Manager: 0, EvidenceCritic: 0 },
  scripted_decisions_by_role: {},
  limitations: [
    'Manager and specialist lifecycle decisions are scripted, with synthetic receipts. They do not establish strict role quality or domain demonstration success.',
    'Only the native candidate job and the separate interactive latency probe use genuine inference.',
    'This isolated provisional policy never publishes or qualifies as production release evidence.',
  ],
};
const path = join(directory, 'report.json');
const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n');
await save();
let runtime,
  taskId = '',
  chainId = '',
  initialRun = '',
  sourceRef;
let interrupted = false,
  submitCalls = 0,
  initialTurns = 0,
  successorTurns = 0;
const stop = () => {
  interrupted = true;
};
process.once('SIGINT', stop);
const authority = (task) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
const until = async (read, accept, label) => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!interrupted && Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error(`Verification did not complete: ${label}.`);
};
const model = {
  selection: {
    provider: 'scripted',
    model: 'isolated-native-lifecycle-verifier',
  },
  async complete(input) {
    report.scripted_decisions_by_role[input.role] =
      (report.scripted_decisions_by_role[input.role] ?? 0) + 1;
    const task = runtime.store.read(taskId, identity);
    const successor = task.current_run_id !== initialRun;
    if (input.role === 'Manager') {
      const context = input.context;
      const assignment = context.assignments.find(
        (entry) => entry.definition_id === 'verification.native-candidate',
      );
      let action;
      if (
        successor &&
        !context.source_applicability.some(
          (entry) => entry.id === sourceRef.id && entry.current,
        )
      )
        action = context.inspections.some(
          (entry) => entry.artifact.id === sourceRef.id,
        )
          ? {
              type: 'applicability',
              artifact: sourceRef,
              applicable: true,
              reason:
                'The same exact source defines the verification objective.',
            }
          : { type: 'inspect', artifacts: [sourceRef] };
      else if (assignment?.status === 'completed')
        action = {
          type: 'finalize',
          answer: successor
            ? 'The retained candidate was explicitly inspected against the supplied verification source [S1]. Independent scientific review remains required.'
            : 'The native candidate remains available for explicit inspection under the admitted follow-up grant [S1].',
          work_products: [],
          sources: [sourceRef],
          uncertainty: [
            'This synthetic brief and scripted review do not establish scientific support.',
          ],
          unfinished: ['Independent scientific review.'],
        };
      else if (assignment)
        action = {
          type: 'wait',
          reason: 'Await the exact parked specialist dependency.',
        };
      else {
        const inbox = context.nightshift_successor_inbox ?? [];
        if (successor)
          assert.equal(
            inbox.length,
            1,
            'The successor must inherit exactly one native result.',
          );
        action = {
          type: 'apply_plan',
          assignments: [
            {
              key: 'native-candidate',
              definition_id: 'verification.native-candidate',
              brief: successor
                ? 'Inspect the exact delegated native candidate without scientific acceptance.'
                : 'Submit one bounded native critique and park.',
              depends_on: [],
              max_model_calls: 8,
              ...(successor
                ? {
                    input: {
                      nightshift_job_ids: inbox.map((entry) => entry.job_id),
                    },
                  }
                : {}),
            },
          ],
          retain_assignment_ids: [],
          reason: 'Exercise the explicitly opted-in finite native lifecycle.',
        };
      }
      return JSON.stringify({
        id: randomUUID(),
        run_id: context.run_id,
        generation: context.generation,
        objective_revision: context.objective_revision,
        plan_revision: context.plan_revision,
        event_cursor: context.event_cursor,
        explanation: 'Scripted isolated verification decision.',
        references: [],
        ...(!context.interpretation
          ? {
              interpretation: {
                scope: context.request.objective,
                deliverables: ['An explicitly inspected native candidate.'],
                assumptions: [],
                intended_use: 'Provisional lifecycle verification.',
                stopping_conditions: [
                  'Report the missing independent scientific evidence.',
                ],
              },
            }
          : {}),
        action,
      });
    }
    const job = runtime.store.nightshift.jobs(identity)[0];
    if (successor) {
      successorTurns++;
      if (successorTurns === 1)
        return JSON.stringify({
          id: 'consume-native-candidate',
          type: 'tool',
          tool: 'nightshift.result',
          input: {
            schema_version: 'haze.nightshift.tool.result.v1',
            job_id: job.id,
            decision: 'use_candidate',
            reason:
              'Inspect the exact retained candidate against the verification source. The native judge supplies no independent scientific approval.',
          },
        });
      report.candidate_explicitly_reviewed = true;
      return JSON.stringify({
        id: 'finish-native-review',
        type: 'finish',
        summary:
          'The exact native candidate was inspected; scientific support remains a gap.',
        support: 'gap',
        uncertainty: ['No independent scientific qualification was attempted.'],
        outputs: [],
      });
    }
    initialTurns++;
    if (initialTurns === 1) {
      const chain = runtime.store.nightshift.chain(chainId, identity);
      return JSON.stringify({
        id: 'submit-native-once',
        type: 'tool',
        tool: 'nightshift.submit',
        input: {
          schema_version: 'haze.nightshift.tool.submit.v1',
          chain_id: chainId,
          expected_chain_revision: chain.revision,
          purpose: 'critique_candidate',
          prompt:
            'Write a brief critique of this source explaining why a generated candidate requires independent evidence review. Cite only the supplied source. Invent no measurements.',
          input_refs: [sourceRef],
          n: 1,
          judge: 'accuracy',
          budget: 'low',
          window: 'now',
          ...policy,
        },
      });
    }
    if (initialTurns === 2)
      return JSON.stringify({
        id: 'park-native-dependency',
        type: 'external_wait',
        schema_version: 'haze.external.wait.action.v1',
        // This optional draft wakes the producer but remains unconsumed until
        // the explicitly granted follow-up inspects it. Required-result fences
        // continue to be covered by the existing crash/runtime suites.
        dependencies: [{ job_id: job.id, required: false }],
      });
    return JSON.stringify({
      id: 'retain-for-followup',
      type: 'finish',
      summary:
        'The candidate has arrived and remains unconsumed for the explicitly admitted follow-up inspection.',
      support: 'gap',
      uncertainty: [
        'Explicit follow-up inspection and independent scientific review remain required.',
      ],
      outputs: [],
    });
  },
};
function registry() {
  const value = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent({
      id: 'EvidenceCritic',
      version: 'verification.v1',
      instructions:
        'Exercise one native lifecycle; do not claim scientific approval.',
    })
    .registerCapability({
      card: {
        id: 'verification.native-lifecycle',
        version: '1',
        purpose: 'Verify a bounded native cloud lifecycle.',
        work_products: [],
        required_tools: [],
        roles: ['EvidenceCritic'],
        readiness: 'implemented',
        limitations: ['Scripted provisional verification only.'],
      },
      matches: () => true,
      assignments: () => [],
    })
    .registerAssignment({
      id: 'verification.native-candidate',
      version: '1',
      capability: 'verification.native-lifecycle',
      agent: 'EvidenceCritic',
      tools: ['nightshift.submit', 'nightshift.result'],
      instructions:
        'Submit or explicitly inspect the exact unreviewed native candidate.',
    });
  for (const tool of createNightshiftTools('live')) value.registerTool(tool);
  return value;
}
const provisionalPolicy = async () => ({
  schema_version: 'haze.nightshift.automatic.readiness.v2',
  released: true,
  ready: true,
  reason: 'Isolated provisional verification; never production evidence.',
  evidence_id: `provisional:${directory}`,
  evidence_kind: 'fixture',
  scope: structuredClone(INITIAL_AUTOMATIC_SCOPE),
  gates: [
    {
      id: 'isolated-provisional',
      label: 'Bounded verification scenario only',
      passed: true,
      reason: null,
    },
  ],
});
const port = new Proxy(adapter, {
  get(target, key) {
    // Discovery is already retained above. Avoid a second slow discovery between
    // initial task admission and grant admission; submit itself still uses the
    // real adapter's current source/privacy checks before native dispatch.
    if (key === 'readiness') return () => Promise.resolve(report.readiness);
    if (key === 'submit')
      return async (...args) => {
        submitCalls++;
        return target.submit(...args);
      };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let dispatch;
let dispatchReleased = false;
const boot = (hold = false) =>
  new TaskRuntime({
    stateDirectory,
    registry: registry(),
    mode: 'live',
    model,
    nightshiftJobs: port,
    nightshiftPollIntervalMs: 1000,
    nightshiftAutomaticRelease: provisionalPolicy,
    env: {
      ...env,
      HAZE_PROVIDER: 'offline',
      HAZE_MODEL_ROUTES_JSON: '{"version":1,"profiles":{}}',
      HAZE_AGENT_ROUTES_JSON: '{"version":1,"routes":{}}',
    },
    limits: {
      deadline: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
      max_model_calls: 30,
      max_tool_calls: 8,
    },
    ...(hold
      ? {
          dispatchTask: (_id, start) => {
            if (dispatchReleased) start();
            else dispatch = start;
          },
        }
      : {}),
  });
try {
  report.policy_ready = nightshiftPolicyReady(report.readiness, policy);
  if (!values.live) report.passed = report.policy_ready;
  else {
    assert.equal(
      report.policy_ready,
      true,
      'Verified cloud compute is required before any native submission.',
    );
    runtime = boot(true);
    const source = runtime.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'verification-source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'Verification source: generated critiques are unreviewed drafts and must be checked independently. No scientific measurements are supplied.',
        ).toString('base64'),
      },
      randomUUID(),
    );
    sourceRef = {
      id: source.id,
      version: source.version,
      sha256: source.sha256,
    };
    taskId = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Inspect one bounded native critique under a finite follow-up grant.',
        context_refs: [sourceRef],
        nightshift_tools: ['nightshift.submit', 'nightshift.result'],
      },
      randomUUID(),
    ).task_id;
    let task = runtime.store.read(taskId, identity);
    initialRun = task.current_run_id;
    const chain = await runtime.nightshift.admitChain(
      {
        schema_version: 'haze.nightshift.chain.admission.v2',
        task_id: taskId,
        ...authority(task),
        total_runs: 2,
        automatic_followup_runs: 1,
        automatic_opt_in: true,
        max_jobs: 2,
        max_attempts: 2,
        lifetime_seconds: 1800,
        ...policy,
        initial_progress: {
          schema_version: 'haze.nightshift.progress.v1',
          purpose: 'critique_candidate',
          instruction:
            'Inspect the exact retained critique candidate when it becomes available.',
          input_refs: [sourceRef],
        },
      },
      randomUUID(),
      identity,
    );
    chainId = chain.id;
    report.task_id = taskId;
    report.chain_id = chainId;
    report.original_grant = chain;
    await save();
    assert.equal(typeof dispatch, 'function');
    dispatchReleased = true;
    dispatch();
    report.parked = await until(
      () => runtime.store.externalWaits.view(taskId, identity),
      (view) => view.capacity.permit === 'released' && view.waits.length === 1,
      'specialist parking and released capacity',
    );
    let job = runtime.store.nightshift.jobs(identity)[0];
    assert.ok(
      job.remote_id,
      'Native acknowledgement must retain a remote identity.',
    );
    report.job_id = job.id;
    report.remote_id = job.remote_id;
    await save();
    // A real strict-model call runs while the native job is independently active.
    const before = await adapter.inspect(
      job.remote_id,
      AbortSignal.timeout(20_000),
    );
    assert.equal(
      before.terminal,
      false,
      'Latency must be measured while native work is active.',
    );
    const interactive = resolveAgentModel({
      ...process.env,
      SAMPLE_MODE: 'false',
      HAZE_PROVIDER: 'nvidia',
      HAZE_MODEL: NVIDIA_ULTRA_MODEL,
      HAZE_PROVIDER_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      HAZE_PROVIDER_API_KEY:
        process.env.NVIDIA_API_KEY ?? process.env.HAZE_PROVIDER_API_KEY,
    });
    const started = performance.now();
    report.model_calls_by_role.Manager++;
    const probe = await interactive.completeWithReceipt(
      {
        role: 'Manager',
        instruction:
          'Answer briefly: what must happen before a generated draft can count as evidence?',
        context: {
          purpose:
            'Interactive latency measurement during native background work.',
        },
        max_output_tokens: 128,
      },
      AbortSignal.timeout(90_000),
    );
    report.interactive_latency = {
      samples_ms: [performance.now() - started],
      gate_ms: 90_000,
      native_before: before,
      native_after: await adapter.inspect(
        job.remote_id,
        AbortSignal.timeout(20_000),
      ),
      output: probe.text,
      receipt: probe.receipt,
    };
    assert.equal(
      probe.receipt.synthetic,
      undefined,
      'The latency probe requires a genuine provider receipt.',
    );
    assert.equal(
      probe.receipt.response_model,
      NVIDIA_ULTRA_MODEL,
      'The interactive probe must return the exact Ultra identity.',
    );
    assert.ok(report.interactive_latency.samples_ms[0] <= 90_000);
    await save();
    task = await until(
      () => runtime.store.read(taskId, identity),
      (value) =>
        value.current_run_id !== initialRun &&
        ['completed', 'failed', 'paused', 'timed_out'].includes(value.status),
      'one linked successor and explicit review',
    );
    report.task = task;
    report.chain = runtime.store.nightshift.chain(chainId, identity);
    report.decisions = runtime.automaticChains.decisions(chainId, identity);
    report.waits = runtime.store.externalWaits.view(taskId, identity);
    report.inbox = runtime.store.nightshiftTransfers.inbox(taskId, identity);
    job = runtime.store.nightshift.job(job.id, identity);
    report.job = job;
    report.native_attempts = verifiedNativeAttempts(
      job.receipt,
      report.readiness.cloud_lanes ?? [],
    );
    report.raw_attempts = runtime.store.db
      .prepare('SELECT body FROM attempts WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => JSON.parse(row.body));
    assert.equal(task.status, 'completed', 'The successor must complete.');
    assert.equal(
      task.runs.length,
      2,
      'Exactly one successor must be admitted.',
    );
    assert.equal(report.candidate_explicitly_reviewed, true);
    assert.equal(submitCalls, 1, 'Native submission must never repeat.');
    assert.equal(
      report.inbox[0]?.resolved,
      true,
      'The delegated candidate requires explicit consumption.',
    );
    assert.deepEqual(
      report.chain.grant,
      chain.grant,
      'The original grant is immutable.',
    );
    assert.equal(
      report.chain.expires_at,
      chain.expires_at,
      'The absolute grant lifetime cannot renew.',
    );
    assert.deepEqual(
      {
        runs: report.chain.usage.runs,
        jobs: report.chain.usage.jobs,
        requested_attempts: report.chain.usage.requested_attempts,
      },
      { runs: 2, jobs: 1, requested_attempts: 1 },
    );
    await runtime.close();
    runtime = undefined;
    runtime = boot();
    const restoredTask = runtime.store.read(taskId, identity),
      restoredJob = runtime.store.nightshift.job(job.id, identity);
    const restoredChain = runtime.store.nightshift.chain(chainId, identity);
    assert.deepEqual(
      restoredTask.result,
      task.result,
      'Restart must preserve the saved result.',
    );
    assert.equal(restoredTask.current_run_id, task.current_run_id);
    assert.equal(restoredJob.remote_id, job.remote_id);
    assert.deepEqual(restoredJob.receipt, job.receipt);
    assert.deepEqual(restoredChain.grant, chain.grant);
    assert.deepEqual(restoredChain.usage, report.chain.usage);
    await runtime.automaticChains.tick();
    assert.equal(runtime.store.read(taskId, identity).runs.length, 2);
    assert.equal(submitCalls, 1);
    report.restart_readback = {
      identities_preserved: true,
      accounting_preserved: true,
      results_preserved: true,
    };
    assert.equal(
      loadRelease(stateDirectory),
      null,
      'Provisional verification cannot install production evidence.',
    );
    report.production_readiness = await createNightshiftReleasePolicy({
      stateDirectory,
      bindings: async () => null,
    })();
    assert.equal(report.production_readiness.released, false);
    report.passed = true;
  }
} catch (error) {
  report.error = error?.code ?? 'verification_not_passed';
  // Only our assertions and verifier phase errors have safe, known messages.
  if (
    error?.code === 'ERR_ASSERTION' ||
    error?.message?.startsWith('Verification did not complete:')
  )
    report.failed_gate = error.message.split('\n')[0];
} finally {
  if (runtime) {
    if (taskId) {
      report.final_task = runtime.store.read(taskId, identity);
      report.final_jobs = runtime.store.nightshift.jobs(identity);
    }
    await runtime.close();
  }
  process.removeListener('SIGINT', stop);
  report.native_submit_calls = submitCalls;
  report.finished_at = new Date().toISOString();
  await save();
}
console.log(
  JSON.stringify({
    report: path,
    passed: report.passed,
    mode: report.mode,
    error: report.error ?? null,
    failed_gate: report.failed_gate ?? null,
  }),
);
if (!report.passed) process.exitCode = 1;
