import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('tmp', 'nightshift-wait-crash-verification', randomUUID());
await mkdir(root, { recursive: true });
const children = new Set();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const stages = [
  'after-permit-release',
  'after-result-event-commit',
  'during-queue-insertion',
  'after-permit-acquisition',
];
async function start(directory, stage, phase) {
  const child = fork(
    new URL('./nightshift-wait-crash-worker.mjs', import.meta.url),
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
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  const pending = new Map();
  let failure;
  let markReady;
  const ready = new Promise((done, reject) => {
    markReady = done;
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Wait fixture exited ${code}: ${stderr}`)),
    );
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
      callback.reject(new Error(`Wait fixture exited ${code}: ${stderr}`));
    pending.clear();
  });
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Wait fixture startup timeout: ${stderr}`)),
          process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1' ? 45000 : 15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return {
    child,
    stderr: () => stderr,
    error: () => failure,
    rpc(action) {
      return new Promise((done, reject) => {
        const id = randomUUID();
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Wait fixture ${action} timeout: ${stderr}`));
        }, 15000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            done(value);
          },
          reject(error) {
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
      throw new Error(`Fixture exited before barrier: ${worker.stderr()}`);
    await pause(20);
  }
  throw new Error(`Fixture barrier timeout: ${worker.stderr()}`);
}
const report = {
  schema_version: 'haze.nightshift.wait-crash-verification.v1',
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
    const second = await start(directory, stage, 'recover');
    const before = await second.rpc('read');
    assert.equal(
      before.remote_dispatches,
      0,
      'This wait-only fixture must never dispatch a provider.',
    );
    assert.equal(before.job_count, 1);
    assert.equal(before.submission_attempts, 1);
    assert.equal(before.submission_dispatch_records, 1);
    assert.equal(before.charged_jobs, 1);
    assert.equal(before.requested_attempts, 1);
    if (stage === 'after-permit-release') {
      assert.equal(
        before.permits,
        0,
        'Released capacity must survive restart.',
      );
      assert.equal(before.delivery_count, 0);
    } else if (stage === 'during-queue-insertion') {
      assert.equal(
        before.delivery_count,
        0,
        'An interrupted delivery/event/queue transaction must roll back.',
      );
      assert.equal(before.result_events, 0);
      assert.equal(before.ready_events, 0);
      assert.equal(before.queue_count, 0);
      assert.equal(
        before.receipt_count,
        1,
        'Historical receipt is independently durable.',
      );
    } else {
      assert.equal(before.delivery_count, 1);
      assert.equal(before.result_events, 1);
      assert.equal(before.ready_events, 1);
      assert.equal(before.queue_count, 1);
      if (stage === 'after-permit-acquisition') assert.equal(before.permits, 1);
    }
    const recovered = await second.rpc('recover');
    const replayed = await second.rpc('recover');
    assert.equal(recovered.delivery_count, 1);
    assert.equal(recovered.result_events, 1);
    assert.equal(recovered.ready_events, 1);
    assert.equal(recovered.receipt_count, 1);
    assert.equal(recovered.permits, 1);
    assert.equal(
      recovered.pending_graph_jobs,
      1,
      'Exactly one durable targeted graph wake must be recoverable.',
    );
    assert.equal(
      replayed.pending_graph_jobs,
      1,
      'Repeated recovery must coalesce the target wake.',
    );
    assert.equal(replayed.delivery_count, 1);
    assert.equal(replayed.result_events, 1);
    assert.equal(replayed.ready_events, 1);
    assert.equal(replayed.remote_dispatches, 0);
    assert.equal(replayed.submission_attempts, 1);
    assert.equal(replayed.submission_dispatch_records, 1);
    assert.equal(replayed.charged_jobs, 1);
    assert.equal(replayed.request_fingerprint, before.request_fingerprint);
    if (before.queue_sequence !== null)
      assert.equal(
        recovered.queue_sequence,
        before.queue_sequence,
        'Restart retains eligible FIFO position.',
      );
    assert.equal(replayed.queue_sequence, recovered.queue_sequence);
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
