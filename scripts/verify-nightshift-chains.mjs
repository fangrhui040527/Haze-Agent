import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(
  'tmp',
  'nightshift-chain-crash-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const children = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const stages = [
  'before-successor-reservation',
  'during-successor-reservation',
  'during-result-assignment',
  'during-graph-enqueue',
  'after-successor-commit-before-dispatch',
  'after-graph-claim',
];
async function start(directory, stage, phase) {
  const child = fork(
    new URL('./nightshift-chain-crash-worker.mjs', import.meta.url),
    [directory, stage, phase],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        STATE_DIR: directory,
        HAZE_TASK_STATE_DIR: directory,
      },
    },
  );
  children.add(child);
  let stderr = '',
    failure,
    markReady;
  const pending = new Map();
  const ready = new Promise((done, reject) => {
    markReady = done;
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Chain fixture exited ${code}: ${stderr}`)),
    );
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  child.on('message', (message) => {
    if (message.ready) return markReady();
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) {
      failure = message.error;
      callback.reject(new Error(message.error));
    } else callback.resolve(message.result);
  });
  child.once('exit', (code) => {
    children.delete(child);
    for (const callback of pending.values())
      callback.reject(new Error(`Chain fixture exited ${code}: ${stderr}`));
    pending.clear();
  });
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Chain fixture startup timeout: ${stderr}`)),
          process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1' ? 45000 : 15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return {
    child,
    error: () => failure,
    stderr: () => stderr,
    rpc(action) {
      return new Promise((done, reject) => {
        const id = randomUUID(),
          timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Chain fixture ${action} timeout: ${stderr}`));
          }, 15000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            done(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.send({ id, action });
      });
    },
  };
}
async function kill(worker) {
  if (worker.child.exitCode !== null) return;
  await new Promise((done) => {
    worker.child.once('exit', done);
    worker.child.kill('SIGKILL');
  });
}
async function barrier(directory, worker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (worker.error()) throw new Error(worker.error());
    try {
      return JSON.parse(
        await readFile(join(directory, 'barrier.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (worker.child.exitCode !== null)
      throw new Error(
        `Chain fixture exited before barrier: ${worker.stderr()}`,
      );
    await delay(20);
  }
  throw new Error(`Chain fixture barrier timeout: ${worker.stderr()}`);
}
const report = {
  schema_version: 'haze.nightshift.chain-crash-verification.v1',
  started_at: new Date().toISOString(),
  mode: 'synthetic-records-real-process-crashes',
  verification_source:
    process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1'
      ? 'source-vite-ssr'
      : 'compiled-dist',
  passed: false,
  scenarios: [],
};
try {
  for (const stage of stages) {
    const directory = join(root, stage);
    await mkdir(directory);
    const first = await start(directory, stage, 'crash');
    void first.rpc('begin').catch(() => undefined);
    const stopped = await barrier(directory, first);
    await kill(first);
    const second = await start(directory, stage, 'recover'),
      before = await second.rpc('read');
    assert.equal(before.remote_dispatches, 0);
    assert.equal(before.job_count, 1);
    assert.equal(before.receipt_count, 1);
    assert.equal(before.charged_jobs, 1);
    assert.equal(before.requested_attempts, 1);
    assert.equal(before.submission_attempts, 1);
    assert.equal(before.submission_dispatch_records, 1);
    const committed = [
      'after-successor-commit-before-dispatch',
      'after-graph-claim',
    ].includes(stage);
    assert.equal(
      before.run_count,
      committed ? 2 : 1,
      'An interrupted admission must roll back as one transaction.',
    );
    assert.equal(before.admitted_successors, committed ? 1 : 0);
    assert.equal(before.linked_admissions, committed ? 1 : 0);
    assert.equal(before.transfers, committed ? 1 : 0);
    const recovered = await second.rpc('recover'),
      replayed = await second.rpc('recover');
    for (const value of [recovered, replayed]) {
      assert.equal(value.run_count, 2);
      assert.equal(value.admitted_successors, 1);
      assert.equal(value.linked_admissions, 1);
      assert.equal(value.used_runs, 2);
      assert.equal(value.transfers, 1);
      assert.equal(value.required_transfers, 1);
      assert.equal(value.dependency_blocked, true);
      assert.equal(value.pending_graph_jobs, 1);
      assert.equal(value.held_permits, 1);
      assert.equal(value.remote_dispatches, 0);
      assert.equal(value.job_count, 1);
      assert.equal(value.receipt_count, 1);
      assert.equal(value.charged_jobs, 1);
      assert.equal(value.requested_attempts, 1);
      assert.equal(value.submission_attempts, 1);
      assert.equal(value.submission_dispatch_records, 1);
      assert.equal(value.candidate_applicable, 0);
      assert.equal(value.request_fingerprint, before.request_fingerprint);
      assert.equal(value.current_expires_at, before.original_expires_at);
      assert.deepEqual(value.current_routes, before.original_routes);
    }
    assert.equal(
      replayed.successor_run_id,
      recovered.successor_run_id,
      'Repeated recovery must return the same successor.',
    );
    assert.equal(replayed.result_events, 1);
    assert.equal(replayed.admitted_decisions, 1);
    report.scenarios.push({
      stage,
      passed: true,
      barrier: stopped,
      before,
      recovered,
      replayed,
    });
    await second.rpc('close');
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
  report.finished_at = new Date().toISOString();
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      scenarios: report.scenarios.length,
      report: join(root, 'report.json'),
      ...(report.error ? { error: report.error } : {}),
    },
    null,
    2,
  ),
);
