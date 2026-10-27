import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve('tmp', 'nightshift-crash-verification', randomUUID());
await mkdir(root, { recursive: true });
const workers = new Set();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function start(directory, stage, phase) {
  const child = fork(
    new URL('./nightshift-crash-worker.mjs', import.meta.url),
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
  workers.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  const pending = new Map();
  let ready;
  const startup = new Promise((done, reject) => {
    ready = done;
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Fixture worker exited ${code}: ${stderr}`)),
    );
  });
  child.on('message', (message) => {
    if (message.ready) {
      ready();
      return;
    }
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error
      ? callback.reject(new Error(JSON.stringify(message.error)))
      : callback.resolve(message.result);
  });
  child.once('exit', (code) => {
    workers.delete(child);
    for (const callback of pending.values())
      callback.reject(new Error(`Fixture worker exited ${code}: ${stderr}`));
    pending.clear();
  });
  let timeout;
  try {
    await Promise.race([
      startup,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Fixture worker startup timed out: ${stderr}`)),
          process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1' ? 45000 : 15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return {
    child,
    stderr: () => stderr,
    rpc(action) {
      return new Promise((done, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Fixture ${action} timed out: ${stderr}`));
        }, 15000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            done(value);
          },
          reject: (error) => {
            clearTimeout(timer);
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
    try {
      return JSON.parse(
        await readFile(join(directory, 'crash-barrier.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (worker.child.exitCode !== null)
      throw new Error(`Worker exited before barrier: ${worker.stderr()}`);
    await wait(20);
  }
  throw new Error(`Barrier timed out: ${worker.stderr()}`);
}
async function submissions(directory) {
  try {
    return (
      await readFile(join(directory, 'external-submissions.ndjson'), 'utf8')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
async function settled(worker, predicate) {
  const deadline = Date.now() + 15000;
  let state;
  while (Date.now() < deadline) {
    state = await worker.rpc('read');
    if (predicate(state)) return state;
    await wait(20);
  }
  throw new Error(`Fixture did not settle: ${JSON.stringify(state)}`);
}
const report = {
  schema_version: 'haze.nightshift.crash-verification.v1',
  started_at: new Date().toISOString(),
  mode: 'synthetic-port-real-process-crashes',
  verification_source:
    process.env.HAZE_NIGHTSHIFT_VERIFY_SOURCE === '1'
      ? 'source-vite-ssr'
      : 'compiled-dist',
  passed: false,
  scenarios: [],
};
try {
  for (const stage of [
    'intent-before-dispatch',
    'during-submission',
    'ack-before-persistence',
    'after-ack-persistence',
    'during-receipt-transaction',
    'after-receipt-before-selection',
    'after-selection-before-response',
  ]) {
    const directory = join(root, stage);
    await mkdir(directory);
    const first = await start(directory, stage, 'crash');
    void first.rpc('begin').catch(() => undefined);
    const stopped = await barrier(directory, first);
    const db = new DatabaseSync(join(directory, 'tasks.sqlite'), {
      readOnly: true,
    });
    const before = {
      jobs: Number(
        db.prepare('SELECT COUNT(*) count FROM ns_jobs').get().count,
      ),
      artifacts: Number(
        db
          .prepare(
            "SELECT COUNT(*) count FROM artifacts WHERE json_extract(body,'$.kind')='nightshift.candidate'",
          )
          .get().count,
      ),
      deliveries: Number(
        db.prepare('SELECT COUNT(*) count FROM ns_deliveries').get().count,
      ),
      selections: Number(
        db.prepare('SELECT COUNT(*) count FROM ns_selections').get().count,
      ),
    };
    db.close();
    assert.equal(
      before.jobs,
      1,
      'Intent must be committed before any dispatch barrier.',
    );
    if (stage === 'during-receipt-transaction') {
      assert.equal(
        before.artifacts,
        0,
        'Uncommitted candidate must not be externally visible.',
      );
      assert.equal(before.deliveries, 0);
    }
    await kill(first);
    const callsBefore = (await submissions(directory)).length;
    const second = await start(directory, stage, 'recover');
    const unknown = [
      'intent-before-dispatch',
      'during-submission',
      'ack-before-persistence',
    ].includes(stage);
    let recovered = await settled(second, (state) =>
      unknown
        ? state.jobs[0]?.execution_state === 'submission_unknown'
        : !!state.jobs[0]?.receipt,
    );
    const replayed = await second.rpc('replay');
    assert.equal(replayed.id, recovered.jobs[0].id);
    assert.equal(
      (await submissions(directory)).length,
      callsBefore,
      'Restart and local redelivery must not replay a remote submit.',
    );
    if (unknown) {
      assert.equal(recovered.counts.capacity_held, 1);
      assert.equal(recovered.counts.artifacts, 0);
      if (stage !== 'intent-before-dispatch') {
        await second.rpc('reconcile');
        recovered = await settled(second, (state) => !!state.jobs[0]?.receipt);
      }
    }
    if (stage !== 'intent-before-dispatch') {
      assert.equal(recovered.counts.artifacts, 1);
      assert.equal(recovered.counts.deliveries, 1);
      assert.equal(recovered.jobs[0].candidate, true);
      assert.equal(recovered.jobs[0].review_status, 'unreviewed');
      const originalArtifact = recovered.jobs[0].receipt.artifact;
      await second.rpc('select');
      await second.rpc('select');
      const final = await second.rpc('read');
      assert.equal(final.counts.selections, 1);
      assert.deepEqual(final.jobs[0].receipt.artifact, originalArtifact);
      assert.equal(final.counts.artifacts, 1);
      assert.equal(final.counts.deliveries, 1);
      assert.equal(
        final.counts.graph_operations,
        0,
        'Receipt capture/selection must not wake a graph.',
      );
      assert.equal(
        final.task.artifacts.length,
        0,
        'Historical receipt is not a published task effect.',
      );
      await second.rpc('close');
      const third = await start(directory, stage, 'recover');
      const after = await third.rpc('read');
      assert.deepEqual(after.jobs[0].receipt.artifact, originalArtifact);
      assert.equal(after.counts.selections, 1);
      assert.equal(after.counts.artifacts, 1);
      assert.equal((await submissions(directory)).length, 1);
      await third.rpc('close');
    } else {
      assert.equal(callsBefore, 0);
      await second.rpc('close');
    }
    report.scenarios.push({
      stage,
      passed: true,
      barrier: stopped,
      committed_before_crash: before,
      remote_submissions: callsBefore,
      unknown_after_restart: unknown,
      no_automatic_replay: true,
      explicit_reconciliation: unknown && stage !== 'intent-before-dispatch',
      receipt_and_selection_deduplicated: stage !== 'intent-before-dispatch',
    });
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  for (const child of workers) {
    if (child.exitCode === null)
      await new Promise((done) => {
        child.once('exit', done);
        child.kill('SIGKILL');
      });
  }
  report.finished_at = new Date().toISOString();
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      report: join(root, 'report.json'),
      passed: report.passed,
      scenarios: report.scenarios.length,
    }),
  );
}
