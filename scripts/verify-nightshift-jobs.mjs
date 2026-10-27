import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    output: { type: 'string' },
  },
});
const directory = resolve(
  values.output ?? '.state/nightshift-verification',
  randomUUID(),
);
const stateDirectory = join(directory, 'state');
await mkdir(directory, { recursive: true });
const { createNightshiftJobAdapter, createModelRouteRegistry } =
  await import('../dist/composition.js');
const { TaskStore } = await import('../dist/tasks/store.js');
const { NightshiftJobService } =
  await import('../dist/tasks/nightshift-service.js');
const { acquireRuntimeOwner } = await import('../dist/tasks/runtime-owner.js');
const localTaskIdentity = {
  principal: 'local-user',
  workspace: 'local-workspace',
};
const { taskRequestSchema } = await import('../dist/contracts/tasks.js');
// The verification directory is explicit and never inherited from application state settings.
const env = {
  ...process.env,
  STATE_DIR: stateDirectory,
  HAZE_TASK_STATE_DIR: stateDirectory,
  HAZE_PROVIDER: 'offline',
  HAZE_MODEL_ROUTES_JSON: '{"version":1,"profiles":{}}',
  HAZE_AGENT_ROUTES_JSON: '{"version":1,"routes":{}}',
  SAMPLE_MODE: 'false',
  HAZE_NIGHTSHIFT_MAX_JOBS: '2',
  HAZE_NIGHTSHIFT_MAX_CHAINS: '8',
};
const adapter = createNightshiftJobAdapter(env);
const report = {
  version: 1,
  mode: values.live ? 'live-local-job-synthetic-brief' : 'read-only-inspection',
  started_at: new Date().toISOString(),
  passed: false,
  readiness: await adapter.readiness(),
  live_inference: false,
  remote_accepted: false,
};
const path = join(directory, 'report.json');
const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n');
await save();
let runtime;
let job;
let interrupted = false;
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
const boot = () => {
  const release = acquireRuntimeOwner(stateDirectory);
  let store;
  try {
    store = new TaskStore(stateDirectory);
    const nightshift = new NightshiftJobService(
      store,
      adapter,
      (identity) => {
        assert.deepEqual(identity, localTaskIdentity);
      },
      { env },
    );
    return {
      store,
      nightshift,
      async close() {
        await nightshift.close();
        store.close();
        release();
      },
    };
  } catch (error) {
    store?.close();
    release();
    throw error;
  }
};
try {
  if (!values.live) {
    report.passed = report.readiness.ready;
  } else {
    assert.equal(
      report.readiness.ready,
      true,
      'A verified local-only job contract is required before submission.',
    );
    runtime = boot();
    const task = runtime.store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective:
          'Retain a synthetic draft from a manually admitted local Nightshift job.',
      }),
      localTaskIdentity,
      randomUUID(),
      {
        mode: 'fixture',
        routeSnapshot: createModelRouteRegistry(env).snapshot(),
        limits: { deadline: new Date(Date.now() + 180_000).toISOString() },
      },
    ).task;
    const chain = await runtime.nightshift.admitChain(
      {
        schema_version: 'haze.nightshift.chain.admission.v1',
        task_id: task.id,
        ...authority(task),
        total_runs: 1,
        max_jobs: 1,
        max_attempts: 1,
        lifetime_seconds: 600,
        automatic_followup_runs: 0,
        privacy: 'local-only',
        max_spend_usd: 0,
      },
      randomUUID(),
      localTaskIdentity,
    );
    const request = {
      schema_version: 'haze.nightshift.job.submit.v1',
      chain_id: chain.id,
      ...authority(task),
      expected_chain_revision: chain.revision,
      prompt:
        'Synthetic Haze integration check. Write two brief sentences explaining that generated drafts require independent evidence review. Do not invent measurements, sources or numerical calculations.',
      input_refs: [],
      role: 'Manager',
      n: 1,
      judge: 'accuracy',
      budget: 'low',
      window: 'now',
      privacy: 'local-only',
      max_spend_usd: 0,
    };
    const key = randomUUID();
    report.request = request;
    await save();
    job = await runtime.nightshift.submitJob(request, key, localTaskIdentity);
    report.acknowledgement = job;
    report.remote_accepted = job.remote_id !== null;
    await save();
    assert.ok(
      job.remote_id,
      'An acknowledged remote identity is required; unknown submission is never repeated.',
    );
    assert.equal(
      (await runtime.nightshift.submitJob(request, key, localTaskIdentity)).id,
      job.id,
      'Identical delivery must preserve the local handle.',
    );
    // Stop the Haze owner after acknowledgement. The external job is allowed to continue.
    await runtime.close();
    runtime = undefined;
    runtime = boot();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !interrupted) {
      job = runtime.nightshift.job(job.id, localTaskIdentity);
      if (job.receipt) break;
      if (
        ['failed', 'cancelled', 'rejected', 'submission_unknown'].includes(
          job.execution_state,
        )
      )
        break;
      await delay(300);
    }
    job = runtime.nightshift.job(job.id, localTaskIdentity);
    report.job = job;
    report.events = runtime.nightshift.events(job.id, 0, localTaskIdentity);
    report.chain = runtime.nightshift.chain(chain.id, localTaskIdentity);
    report.task = runtime.store.read(task.id, localTaskIdentity);
    report.restart_readback =
      job.remote_id === report.acknowledgement.remote_id;
    await save();
    if (!job.receipt) {
      if (
        !['failed', 'cancelled', 'rejected', 'submission_unknown'].includes(
          job.execution_state,
        )
      ) {
        const current = runtime.store.read(task.id, localTaskIdentity);
        await runtime.nightshift.cancelJob(
          job.id,
          {
            schema_version: 'haze.nightshift.job.cancel.v1',
            ...authority(current),
            expected_chain_revision: report.chain.revision,
            expected_job_revision: job.revision,
          },
          randomUUID(),
          localTaskIdentity,
        );
        report.job = runtime.nightshift.job(job.id, localTaskIdentity);
      }
      throw new Error(
        'No bounded receipt was captured before the verification deadline; remote termination is not assumed.',
      );
    }
    assert.equal(job.authority.run_id, task.current_run_id);
    assert.equal(job.authority.objective_revision, task.objective_revision);
    assert.equal(job.candidate, true);
    assert.equal(job.review_status, 'unreviewed');
    assert.deepEqual(job.selections, []);
    assert.ok(job.receipt.output.trim());
    report.live_inference = true;
    assert.equal(report.task.usage.model_calls, 0);
    assert.equal(report.task.usage.tool_calls, 0);
    assert.equal(
      runtime.store.db
        .prepare('SELECT body FROM applicability WHERE artifact_id=?')
        .get(job.receipt.artifact.id),
      undefined,
    );
    const count = runtime.store.db
      .prepare('SELECT COUNT(*) n FROM ns_deliveries WHERE job_id=?')
      .get(job.id).n;
    await runtime.nightshift.pollNow();
    assert.equal(
      runtime.store.db
        .prepare('SELECT COUNT(*) n FROM ns_deliveries WHERE job_id=?')
        .get(job.id).n,
      count,
    );
    assert.equal(count, 1);
    report.passed = Boolean(
      report.restart_readback && job.execution_state === 'completed',
    );
  }
} catch (error) {
  report.error = error?.code ?? 'verification_not_passed';
} finally {
  if (runtime) await runtime.close();
  process.removeListener('SIGINT', stop);
  report.finished_at = new Date().toISOString();
  await save();
}
console.log(
  JSON.stringify({
    report: path,
    passed: report.passed,
    mode: report.mode,
    live_inference: report.live_inference,
    remote_accepted: report.remote_accepted,
    remote_id:
      report.job?.remote_id ?? report.acknowledgement?.remote_id ?? null,
    error: report.error ?? null,
  }),
);
if (!report.passed) process.exitCode = 1;
