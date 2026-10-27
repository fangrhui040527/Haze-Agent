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
const { AutomaticChainService } = await load('tasks/automatic-chain-service');
const { taskRequestSchema } = await load('contracts/tasks');
const { graphThreadId } = await load('tasks/graph-ledger');
const [directory, stage, phase] = process.argv.slice(2);
if (!process.send || !directory || !['crash', 'recover'].includes(phase))
  throw new Error('Use verify-nightshift-chains.mjs.');
const identity = { principal: 'local-user', workspace: 'local-workspace' };
const tools = ['nightshift.submit', 'nightshift.result', 'nightshift.cancel'];
const gate = {
  schema_version: 'haze.nightshift.automatic.readiness.v1',
  released: true,
  ready: true,
  reason: null,
  evidence_id: 'synthetic-crash-fixture-only',
  evidence_kind: 'fixture',
  gates: [
    {
      id: 'fixture',
      label: 'Control-flow fixture, no live release',
      passed: true,
      reason: null,
    },
  ],
};
const fixturePath = join(directory, 'fixture.json');
let fixture = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, 'utf8'))
  : {};
const save = () => writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
const store = new TaskStore(directory, { recover: phase === 'recover' });
store.nightshift.configureAutomatic({
  enabled: true,
  evidence_id: gate.evidence_id,
});
const expected = (task) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
const authority = (task, assignment) => ({
  task_id: task.id,
  run_id: task.current_run_id,
  generation: task.generation,
  objective_revision: task.objective_revision,
  ...(assignment
    ? { assignment_id: assignment.id, assignment_revision: assignment.revision }
    : {}),
});
function barrier() {
  writeFileSync(
    join(directory, 'barrier.json'),
    JSON.stringify({
      stage,
      pid: process.pid,
      transaction_open: store.db.isTransaction ?? null,
    }),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
function setup() {
  const source = store.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'fixture.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from(
        'Synthetic source for crash control-flow verification.',
      ).toString('base64'),
    },
    identity,
    'source',
  ).artifact;
  const ref = { id: source.id, version: source.version, sha256: source.sha256 };
  let task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective:
        'Inspect a bounded critique, with independent review still required.',
      context_refs: [ref],
      nightshift_tools: tools,
    }),
    identity,
    'task',
    {
      mode: 'fixture',
      tools,
      limits: {
        deadline: new Date(Date.now() + 300000).toISOString(),
        max_model_calls: 12,
        max_tool_calls: 12,
        max_assignments: 8,
        max_artifacts: 12,
      },
    },
  ).task;
  const assignment = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'HazeOps',
        definition_id: 'fixture.external',
        definition_version: 'fixture.v1',
        capability: 'fixture',
        brief: 'Await one original exact result.',
        inputs: [ref],
        tools,
      },
    ],
  )[0];
  store.acquireAssignment(task.id, assignment.id);
  task = store.read(task.id, identity);
  const chain = store.nightshift.admitChain(
    {
      schema_version: 'haze.nightshift.chain.admission.v2',
      privacy: 'local-only',
      max_spend_usd: 0,
      task_id: task.id,
      ...expected(task),
      total_runs: 3,
      automatic_opt_in: true,
      automatic_followup_runs: 2,
      max_jobs: 4,
      max_attempts: 4,
      lifetime_seconds: 600,
      initial_progress: {
        schema_version: 'haze.nightshift.progress.v1',
        purpose: 'critique_candidate',
        instruction:
          'Inspect the retained candidate without accepting its judge as evidence.',
        unresolved_deliverables: ['objective'],
        input_refs: [ref],
      },
    },
    'chain',
    identity,
  ).chain;
  const job = store.nightshift.reserveJob(
    {
      schema_version: 'haze.nightshift.job.submit.v1',
      privacy: 'local-only',
      max_spend_usd: 0,
      chain_id: chain.id,
      ...expected(task),
      expected_assignment_id: assignment.id,
      expected_assignment_revision: assignment.revision,
      expected_chain_revision: chain.revision,
      prompt: 'Synthetic candidate, never sent to a provider.',
      purpose: 'critique_candidate',
      input_refs: [ref],
      n: 1,
      role: 'HazeOps',
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
  store.nightshift.acknowledge(job.id, 'fixture-acknowledged-chain');
  const target = authority(task, assignment),
    thread = graphThreadId('assignment', target),
    cursor = store.events(task.id, identity).next_cursor;
  store.externalWaits.wait(
    {
      ...target,
      thread_id: thread,
      after_cursor: cursor,
      dependencies: [{ job_id: job.id, required: true }],
    },
    identity,
  );
  store.completeAssignment(task.id, assignment.id, task.generation, {
    status: 'waiting',
    support: 'gap',
    gaps: ['Required fixture result.'],
  });
  store.graph.park({
    ...target,
    kind: 'assignment',
    thread_id: thread,
    cursor,
    after_cursor: cursor,
    event_types: ['external_result_ready'],
  });
  const outcome = {
    status: 'accepted',
    basis: 'Fixture judge only.',
    explanation: null,
  };
  store.nightshift.observation(
    job.id,
    'fixture-acknowledged-chain',
    {
      remote_id: 'fixture-acknowledged-chain',
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
  store.nightshift.capture(
    job.id,
    'fixture-acknowledged-chain',
    {
      text: 'Synthetic unreviewed candidate; no scientific conclusion.',
      attempts: [],
      winner_seq: null,
      retrieval_error: null,
      truncated: false,
    },
    outcome,
  );
  store.externalWaits.reconcileDeliveries();
  store.stop(
    task.id,
    'timed_out',
    'deadline_exceeded',
    'Original predecessor ended; retained results do not extend its authority.',
  );
  fixture = {
    task_id: task.id,
    predecessor_run_id: task.current_run_id,
    chain_id: chain.id,
    job_id: job.id,
    expires_at: chain.expires_at,
    request_fingerprint: job.request_fingerprint,
  };
  save();
}
const supervisor = new AutomaticChainService(store, {
  releaseGate: () => Promise.resolve(gate),
  routesAvailable: () => Promise.resolve(true),
  admitSuccessor: (request) => {
    if (phase === 'crash' && stage === 'before-successor-reservation')
      barrier();
    return store.linkedRuns.admit(request);
  },
  kick: () => {
    if (phase === 'crash' && stage === 'after-successor-commit-before-dispatch')
      barrier();
  },
});
function installBarrier() {
  if (phase !== 'crash') return;
  if (stage === 'during-successor-reservation') {
    const original = store.nightshift.enrollSuccessor.bind(store.nightshift);
    store.nightshift.enrollSuccessor = (...args) => {
      const value = original(...args);
      barrier();
      return value;
    };
  }
  if (stage === 'during-result-assignment') {
    const original = store.nightshiftTransfers.attach.bind(
      store.nightshiftTransfers,
    );
    store.nightshiftTransfers.attach = (...args) => {
      const value = original(...args);
      barrier();
      return value;
    };
  }
  if (stage === 'during-graph-enqueue') {
    const original = store.graph.enqueue.bind(store.graph);
    store.graph.enqueue = (input) => {
      const value = original(input);
      if (input.run_id !== fixture.predecessor_run_id) barrier();
      return value;
    };
  }
}
const count = (table, where = '', ...args) =>
  Number(
    store.db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get(...args).n,
  );
function snapshot() {
  const task = store.read(fixture.task_id, identity),
    chain = store.nightshift.chain(fixture.chain_id, identity),
    job = store.nightshift.job(fixture.job_id, identity);
  const successor = store.nightshift.successorFor(
    chain.id,
    fixture.predecessor_run_id,
    task.objective_revision,
  );
  let dependencyBlocked = false;
  if (successor)
    try {
      store.nightshiftTransfers.assertFinalizable(authority(task));
    } catch {
      dependencyBlocked = true;
    }
  return {
    current_run_id: task.current_run_id,
    predecessor_run_id: fixture.predecessor_run_id,
    run_count: task.runs.length,
    successor_run_id: successor?.run_id ?? null,
    admitted_successors: count('ns_successors'),
    linked_admissions: count('linked_run_admissions'),
    automatic_decisions: count('automatic_chain_decisions'),
    admitted_decisions: count(
      'automatic_chain_decisions',
      "WHERE json_extract(body,'$.state')='admitted'",
    ),
    result_events: count('automatic_chain_result_events'),
    transfers: count('ns_run_transfers'),
    required_transfers: count(
      'ns_run_transfers',
      "WHERE json_extract(body,'$.required')=1",
    ),
    dependency_blocked: dependencyBlocked,
    pending_graph_jobs: count(
      'graph_jobs',
      "WHERE status IN ('pending','running') AND json_extract(body,'$.run_id')=?",
      task.current_run_id,
    ),
    held_permits: count('task_capacity_permits', "WHERE status='held'"),
    requested_attempts: chain.usage.requested_attempts,
    charged_jobs: chain.usage.jobs,
    used_runs: chain.usage.runs,
    job_count: count('ns_jobs'),
    submission_attempts: count('ns_submission_attempts'),
    submission_dispatch_records: count(
      'ns_events',
      "WHERE json_extract(body,'$.type')='submission_dispatched'",
    ),
    remote_dispatches: 0,
    receipt_count: count(
      'artifacts',
      "WHERE json_extract(body,'$.kind')='nightshift.candidate'",
    ),
    candidate_applicable: count(
      'applicability',
      "WHERE artifact_id=? AND json_extract(body,'$.current')=1",
      job.receipt.artifact.id,
    ),
    request_fingerprint: job.request_fingerprint,
    original_expires_at: fixture.expires_at,
    current_expires_at: chain.expires_at,
    original_routes: store.modelRoutes.snapshot(fixture.predecessor_run_id),
    current_routes: store.modelRoutes.snapshot(task.current_run_id),
    queue: store.db
      .prepare(
        'SELECT sequence,status,body FROM external_ready_queue ORDER BY sequence',
      )
      .all()
      .map((row) => ({
        sequence: row.sequence,
        status: row.status,
        mode: JSON.parse(row.body).admission_mode ?? 'wait',
      })),
  };
}
process.on('message', async (message) => {
  try {
    let result;
    if (message.action === 'begin') {
      setup();
      installBarrier();
      await supervisor.tick();
      if (stage === 'after-graph-claim') {
        const task = store.read(fixture.task_id, identity),
          oldThreads = store.graph
            .pending()
            .filter((job) => job.run_id !== task.current_run_id)
            .map((job) => job.thread_id);
        const claimed = store.graph.claim(
          'fixture-claim-before-execution',
          oldThreads,
        );
        if (!claimed || claimed.run_id !== task.current_run_id)
          throw new Error('Missing committed successor graph job.');
        barrier();
      }
      result = snapshot();
    } else if (message.action === 'read') result = snapshot();
    else if (message.action === 'recover') {
      await supervisor.tick();
      result = snapshot();
    } else if (message.action === 'close') {
      await supervisor.close();
      store.close();
      await server?.close();
      process.send({ id: message.id, result: true });
      process.exit(0);
    } else throw new Error('Unknown crash fixture action.');
    process.send({ id: message.id, result });
  } catch (error) {
    process.send({ id: message.id, error: error.stack ?? String(error) });
  }
});
process.send({ ready: true });
