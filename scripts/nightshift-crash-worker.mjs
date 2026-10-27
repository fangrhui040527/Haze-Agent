import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceMode = process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1';
const sourceServer = sourceMode
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
const { TaskStore } = sourceServer
  ? await sourceServer.ssrLoadModule('/app/tasks/store.ts')
  : await import('../dist/tasks/store.js');
const { NightshiftJobService } = sourceServer
  ? await sourceServer.ssrLoadModule('/app/tasks/nightshift-service.ts')
  : await import('../dist/tasks/nightshift-service.js');
const { taskRequestSchema } = sourceServer
  ? await sourceServer.ssrLoadModule('/app/contracts/tasks.ts')
  : await import('../dist/contracts/tasks.js');

const [directory, stage, phase] = process.argv.slice(2);
const stages = [
  'intent-before-dispatch',
  'during-submission',
  'ack-before-persistence',
  'after-ack-persistence',
  'during-receipt-transaction',
  'after-receipt-before-selection',
  'after-selection-before-response',
];
if (
  !process.send ||
  !directory ||
  !stages.includes(stage) ||
  !['crash', 'recover'].includes(phase)
)
  throw new Error('Use verify-nightshift-crashes.mjs to start this worker.');
const identity = { principal: 'local-user', workspace: 'local-workspace' };
const metadataPath = join(directory, 'fixture-authority.json');
const externalPath = join(directory, 'external-daemon.json');
const callsPath = join(directory, 'external-submissions.ndjson');
let metadata = existsSync(metadataPath)
  ? JSON.parse(readFileSync(metadataPath, 'utf8'))
  : {};
const save = () =>
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
const external = () =>
  existsSync(externalPath)
    ? JSON.parse(readFileSync(externalPath, 'utf8'))
    : null;
function barrier(details = {}) {
  writeFileSync(
    join(directory, 'crash-barrier.json'),
    JSON.stringify({ stage, pid: process.pid, ...details }),
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const authority = (task) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});
const ready = {
  schema_version: 'haze.nightshift.jobs.readiness.v1',
  checked_at: new Date().toISOString(),
  cli_available: true,
  schema_compatible: true,
  runtime_reachable: true,
  local_only_enforced: true,
  cloud_enforced: false,
  ready: true,
  runtime_version: 'synthetic.external.v1',
  adapter_version: 'synthetic.port.v1',
  schema_hash: 'synthetic.schema.v1',
  can_reconcile: true,
  cancellation_idempotent: false,
  reason: 'Synthetic process-crash fixture only.',
  options: {
    judges: ['accuracy'],
    budgets: ['low'],
    windows: ['now'],
    max_attempts: 16,
    fleets: [],
  },
};
const result = {
  text: 'Synthetic derived candidate; independent review is required.',
  attempts: [
    {
      seq: 1,
      lane: 'fixture-local',
      model: 'fixture-model',
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      finish_reason: null,
      receipt_id: null,
      prompt_sha256: null,
    },
  ],
  winner_seq: 1,
  retrieval_error: null,
  truncated: false,
};
const port = {
  readiness: () => Promise.resolve(ready),
  submit: (request) => {
    const job = {
      remote_id: 'synthetic-job-1',
      owner: 'isolated-crash-fixture',
      request,
    };
    appendFileSync(
      callsPath,
      JSON.stringify({ remote_id: job.remote_id, request }) + '\n',
    );
    writeFileSync(externalPath, JSON.stringify(job));
    if (phase === 'crash' && stage === 'during-submission')
      barrier({ remote_id: job.remote_id });
    return Promise.resolve({ remote_id: job.remote_id });
  },
  inspect: (id) => {
    const job = external();
    if (!job || id !== job.remote_id)
      return Promise.reject(new Error('Synthetic remote job missing.'));
    return Promise.resolve({
      remote_id: id,
      execution_state: 'completed',
      terminal: true,
      generated: 1,
      requested_attempts: job.request.n,
      privacy: 'local-only',
      fleet: null,
      runtime_version: 'synthetic.external.v1',
    });
  },
  outcome: () =>
    Promise.resolve({
      status: 'accepted',
      basis: 'synthetic judge opinion only',
      explanation: null,
    }),
  result: () => Promise.resolve(result),
  cancel: () => Promise.resolve({ acknowledged: true }),
  verifyReconciliation: (id, request) => {
    const job = external();
    return Promise.resolve({
      verified:
        !!job &&
        job.remote_id === id &&
        job.owner === 'isolated-crash-fixture' &&
        JSON.stringify(job.request) === JSON.stringify(request),
      reason: null,
    });
  },
};
const store = new TaskStore(directory, { recover: false });
if (phase === 'crash') {
  const ns = store.nightshift;
  if (stage === 'ack-before-persistence' || stage === 'after-ack-persistence') {
    const original = ns.acknowledge.bind(ns);
    ns.acknowledge = (...args) => {
      if (stage === 'ack-before-persistence')
        barrier({ job_id: args[0], remote_id: args[1] });
      const job = original(...args);
      barrier({ job_id: job.id, remote_id: job.remote_id });
      return job;
    };
  }
  if (stage === 'during-receipt-transaction') {
    const original = store.insertArtifact.bind(store);
    store.insertArtifact = (artifact) => {
      const value = original(artifact);
      if (artifact.kind === 'nightshift.candidate')
        barrier({ artifact_id: artifact.id, job_id: artifact.content.job_id });
      return value;
    };
  }
  if (stage === 'after-receipt-before-selection') {
    const original = ns.capture.bind(ns);
    ns.capture = (...args) => {
      const job = original(...args);
      if (job.receipt)
        barrier({ job_id: job.id, artifact: job.receipt.artifact });
      return job;
    };
  }
  if (stage === 'after-selection-before-response') {
    const original = ns.select.bind(ns);
    ns.select = (...args) => {
      const selection = original(...args);
      barrier({ selection_id: selection.id });
      return selection;
    };
  }
}
const service = new NightshiftJobService(store, port, () => undefined, {
  pollIntervalMs: 25,
});
if (phase === 'crash' && stage === 'intent-before-dispatch')
  service.dispatch = (job) => {
    barrier({ job_id: job.id });
    return Promise.resolve(job);
  };
function snapshot() {
  const jobs = store.nightshift.jobs(identity);
  const chains = store.nightshift.listChains(identity);
  const count = (table) =>
    Number(store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
  return {
    jobs,
    chains,
    counts: {
      artifacts: Number(
        store.db
          .prepare(
            "SELECT COUNT(*) count FROM artifacts WHERE json_extract(body,'$.kind')='nightshift.candidate'",
          )
          .get().count,
      ),
      deliveries: count('ns_deliveries'),
      selections: count('ns_selections'),
      graph_operations: count('graph_operations'),
      capacity_held: Number(
        store.db
          .prepare(
            'SELECT COALESCE(SUM(capacity_held),0) count FROM ns_reservations',
          )
          .get().count,
      ),
    },
    task: metadata.task_id ? store.read(metadata.task_id, identity) : null,
  };
}
async function select() {
  const job = store.nightshift.jobs(identity)[0];
  if (!job?.receipt) throw new Error('No candidate receipt.');
  if (!metadata.selection) {
    const task = store.read(job.task_id, identity);
    const chain = store.nightshift.chain(job.chain_id, identity);
    metadata.selection = {
      schema_version: 'haze.nightshift.job.select.v1',
      ...authority(task),
      expected_chain_revision: chain.revision,
      expected_job_revision: job.revision,
      candidate: job.receipt.artifact,
      input_refs: job.input_refs,
    };
    save();
  }
  return service.selectResult(
    job.id,
    metadata.selection,
    'stable-selection',
    identity,
  );
}
process.on('message', async ({ id, action }) => {
  try {
    let value;
    if (action === 'begin') {
      const task = store.admit(
        taskRequestSchema.parse({
          schema_version: 'haze.task.request.v3',
          objective: 'Isolated synthetic Nightshift crash verification.',
        }),
        identity,
        'carrier-task',
        {
          mode: 'fixture',
          limits: {
            deadline: new Date(Date.now() + 300_000).toISOString(),
            max_artifacts: 8,
            max_model_calls: 8,
            max_tool_calls: 8,
            max_assignments: 8,
          },
        },
      ).task;
      metadata.task_id = task.id;
      save();
      const chain = await service.admitChain(
        {
          schema_version: 'haze.nightshift.chain.admission.v1',
          privacy: 'local-only',
          max_spend_usd: 0,
          task_id: task.id,
          ...authority(task),
        },
        'carrier-chain',
        identity,
      );
      metadata.submission = {
        schema_version: 'haze.nightshift.job.submit.v1',
        privacy: 'local-only',
        max_spend_usd: 0,
        chain_id: chain.id,
        ...authority(task),
        expected_chain_revision: chain.revision,
        prompt: 'Draft one synthetic candidate. Do not invent measurements.',
        input_refs: [],
        n: 1,
      };
      save();
      value = await service.submitJob(
        metadata.submission,
        'stable-submit',
        identity,
      );
      if (stage === 'after-selection-before-response') {
        await service.pollNow();
        await select();
      }
    } else if (action === 'read') {
      await service.pollNow();
      value = snapshot();
    } else if (action === 'replay')
      value = await service.submitJob(
        metadata.submission,
        'stable-submit',
        identity,
      );
    else if (action === 'reconcile') {
      const job = store.nightshift.jobs(identity)[0];
      const task = store.read(job.task_id, identity);
      const chain = store.nightshift.chain(job.chain_id, identity);
      value = await service.reconcileJob(
        job.id,
        {
          schema_version: 'haze.nightshift.job.reconcile.v1',
          ...authority(task),
          expected_chain_revision: chain.revision,
          expected_job_revision: job.revision,
          remote_id: external().remote_id,
        },
        'explicit-reconciliation',
        identity,
      );
    } else if (action === 'select') value = await select();
    else if (action === 'close') {
      await service.close();
      store.close();
      await sourceServer?.close();
      process.send({ id, result: true }, () => process.exit(0));
      return;
    } else throw new Error('Unknown fixture action.');
    process.send({ id, result: value });
  } catch (error) {
    process.send({ id, error: { message: error.message, code: error.code } });
  }
});
process.send({ ready: true });
