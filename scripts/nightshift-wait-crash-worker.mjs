import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1';
const server = source
  ? await (
      await import('../frontend/node_modules/vite/dist/node/index.js')
    ).createServer({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: false,
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
      logLevel: 'error',
    })
  : null;
const load = (path) =>
  server
    ? server.ssrLoadModule(`/app/${path}.ts`)
    : import(`../dist/${path}.js`);
const { TaskStore } = await load('tasks/store');
const { taskRequestSchema } = await load('contracts/tasks');
const { graphThreadId } = await load('tasks/graph-ledger');
const [directory, stage, phase] = process.argv.slice(2);
if (!process.send || !directory || !['crash', 'recover'].includes(phase))
  throw new Error('Use verify-nightshift-waits.mjs.');
const identity = { principal: 'local-user', workspace: 'local-workspace' };
const path = join(directory, 'fixture.json');
let fixture = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const save = () => writeFileSync(path, JSON.stringify(fixture, null, 2));
const store = new TaskStore(directory, { recover: false });
const expected = (task) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
function barrier() {
  writeFileSync(
    join(directory, 'barrier.json'),
    JSON.stringify({ stage, pid: process.pid }),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
function authority(task, assignment) {
  return {
    task_id: task.id,
    run_id: task.current_run_id,
    generation: task.generation,
    objective_revision: task.objective_revision,
    ...(assignment
      ? {
          assignment_id: assignment.id,
          assignment_revision: assignment.revision,
        }
      : {}),
  };
}
function count(table, condition = '') {
  return Number(
    store.db.prepare(`SELECT count(*) AS n FROM ${table} ${condition}`).get().n,
  );
}
function snapshot() {
  const queue = store.db
    .prepare(
      'SELECT sequence,body FROM external_ready_queue ORDER BY sequence DESC LIMIT 1',
    )
    .get();
  const job = store.nightshift.job(fixture.job_id, identity);
  return {
    remote_dispatches: 0,
    submission_attempts: count('ns_submission_attempts'),
    submission_dispatch_records: count(
      'ns_events',
      "WHERE json_extract(body,'$.type')='submission_dispatched'",
    ),
    job_count: count('ns_jobs'),
    charged_jobs: Number(
      store.db
        .prepare('SELECT COALESCE(sum(charged),0) AS n FROM ns_reservations')
        .get().n,
    ),
    requested_attempts: Number(
      store.db
        .prepare(
          'SELECT COALESCE(sum(requested_attempts),0) AS n FROM ns_reservations',
        )
        .get().n,
    ),
    permits: count('task_capacity_permits', "WHERE status='held'"),
    delivery_count: count('external_result_deliveries'),
    result_events: count(
      'events',
      "WHERE json_extract(body,'$.type')='external_result'",
    ),
    ready_events: count(
      'events',
      "WHERE json_extract(body,'$.type')='external_result_ready'",
    ),
    queue_count: count('external_ready_queue'),
    queue_sequence: queue?.sequence ?? null,
    queue_state: queue ? JSON.parse(queue.body).status : null,
    receipt_count: count(
      'artifacts',
      "WHERE json_extract(body,'$.kind')='nightshift.candidate'",
    ),
    pending_graph_jobs: count(
      'graph_jobs',
      "WHERE status IN ('pending','running') AND json_extract(body,'$.kind')='assignment'",
    ),
    request_fingerprint: job.request_fingerprint,
  };
}
function complete() {
  let job = store.nightshift.job(fixture.job_id, identity);
  if (job.receipt) return;
  const outcome = {
    status: 'accepted',
    basis: 'Synthetic judge; independent review required.',
    explanation: null,
  };
  store.nightshift.observation(
    job.id,
    job.remote_id,
    {
      remote_id: job.remote_id,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: 1,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'synthetic.fixture',
    },
    outcome,
  );
  store.nightshift.capture(
    job.id,
    job.remote_id,
    {
      text: 'Synthetic unreviewed candidate retained independently from current delivery.',
      attempts: [],
      winner_seq: null,
      retrieval_error: null,
      truncated: false,
    },
    outcome,
  );
}
function setup() {
  let task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Isolated external wait crash fixture.',
    }),
    identity,
    'carrier',
    {
      mode: 'fixture',
      tools: ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'],
      limits: {
        deadline: new Date(Date.now() + 300000).toISOString(),
        max_artifacts: 8,
        max_assignments: 8,
        max_model_calls: 8,
        max_tool_calls: 8,
      },
    },
  ).task;
  const manager = store.ensureManager(task.id, task.current_run_id, {
    role: 'Manager',
    definition_id: 'core.manager.coordinator',
    definition_version: 'fixture.v1',
    capability: 'general',
    brief: 'Park until exact external work completes.',
    tools: [],
  });
  store.acquireAssignment(task.id, manager.id);
  const assignment = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'WorkerShield',
        definition_id: 'fixture.external',
        definition_version: 'fixture.v1',
        capability: 'general',
        brief: 'Consume one bounded unreviewed draft.',
        tools: ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'],
      },
    ],
  )[0];
  store.acquireAssignment(task.id, assignment.id);
  task = store.read(task.id, identity);
  const chain = store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v1',
      task_id: task.id,
      ...expected(task),
    },
    'chain',
    identity,
  ).chain;
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      chain_id: chain.id,
      ...expected(task),
      expected_assignment_id: assignment.id,
      expected_assignment_revision: assignment.revision,
      expected_chain_revision: chain.revision,
      prompt: 'Synthetic candidate; no provider dispatch.',
      n: 1,
      input_refs: [],
      role: 'WorkerShield',
    },
    'job',
    identity,
    {
      adapter_version: 'fixture',
      runtime_version: 'fixture',
      schema_hash: 'fixture',
    },
  ).job;
  store.nightshift.markDispatched(job.id);
  store.nightshift.acknowledge(job.id, 'fixture-acknowledged-1');
  const target = authority(task, assignment),
    thread = graphThreadId('assignment', target);
  const cursor = store.events(task.id, identity).next_cursor;
  store.externalWaits.wait(
    {
      ...target,
      thread_id: thread,
      after_cursor: cursor,
      dependencies: [{ job_id: job.id, required: true }],
    },
    identity,
  );
  store.patchAssignment(task.id, assignment.id, task.generation, {
    status: 'waiting',
  });
  task = store.read(task.id, identity);
  store.waitForManagerEvent(
    task.id,
    {
      run_id: task.current_run_id,
      generation: task.generation,
      objective_revision: task.objective_revision,
      plan_revision: task.manager.plan_revision,
    },
    'Only the acknowledged external job is pending.',
  );
  store.graph.park({
    ...target,
    kind: 'assignment',
    thread_id: thread,
    cursor,
    after_cursor: cursor,
    event_types: ['external_result', 'external_result_ready'],
  });
  const managerTarget = authority(task);
  store.graph.park({
    ...managerTarget,
    kind: 'manager',
    thread_id: graphThreadId('manager', managerTarget),
    cursor,
    after_cursor: cursor,
    event_types: ['manager_fixture_only'],
  });
  fixture = { task_id: task.id, job_id: job.id, target, thread, cursor };
  save();
  if (!store.externalWaits.tryReleaseExternalOnly(managerTarget))
    throw new Error('Fixture was not a verified external-only wait.');
}
function deliver() {
  complete();
  store.externalWaits.reconcileDeliveries();
}
function dispatchReady() {
  const ready = store.externalWaits.drainReady();
  for (const entry of ready)
    store.graph.enqueue({ ...entry, kind: 'assignment' });
}
process.on('message', async ({ id, action }) => {
  try {
    let result;
    if (action === 'begin') {
      setup();
      if (stage === 'after-permit-release') barrier();
      if (stage === 'during-queue-insertion') {
        const original = store.externalWaits.enqueue.bind(store.externalWaits);
        store.externalWaits.enqueue = (...args) => {
          const value = original(...args);
          barrier();
          return value;
        };
      }
      deliver();
      if (stage === 'after-result-event-commit') barrier();
      store.externalWaits.drainReady();
      if (stage === 'after-permit-acquisition') barrier();
      throw new Error('Unknown crash stage.');
    } else if (action === 'read') result = snapshot();
    else if (action === 'recover') {
      complete();
      store.externalWaits.recover();
      dispatchReady();
      result = snapshot();
    } else if (action === 'close') {
      store.close();
      await server?.close();
      process.send({ id, result: true }, () => process.exit(0));
      return;
    } else throw new Error('Unknown fixture command.');
    process.send({ id, result });
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.send({ id, error: error.stack ?? String(error) });
  }
});
process.send({ ready: true });
