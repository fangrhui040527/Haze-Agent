import assert from 'node:assert/strict';
import { MANAGER_TOPOLOGY } from '../dist/tasks/graph-ledger.js';
import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve('tmp', 'langgraph-crash-verification', randomUUID());
await mkdir(root, { recursive: true });
const workers = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function start(directory, stage, phase) {
  const child = fork(
    new URL('./langgraph-crash-worker.mjs', import.meta.url),
    [directory, stage, phase],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  workers.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const pending = new Map();
  let ready;
  const startup = new Promise((resolveReady, reject) => {
    ready = resolveReady;
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Worker exited ${code}: ${stderr}`)),
    );
  });
  child.on('message', (message) => {
    if (message.ready) ready();
    else {
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      message.error
        ? callback.reject(new Error(JSON.stringify(message.error)))
        : callback.resolve(message.result);
    }
  });
  child.once('exit', (code) => {
    workers.delete(child);
    for (const callback of pending.values())
      callback.reject(new Error(`Worker exited ${code}: ${stderr}`));
    pending.clear();
  });
  let startupTimeout;
  try {
    await Promise.race([
      startup,
      new Promise((_, reject) => {
        startupTimeout = setTimeout(
          () => reject(new Error(`Worker startup timed out: ${stderr}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(startupTimeout);
  }
  return {
    child,
    stderr: () => stderr,
    rpc(action, task_id) {
      return new Promise((resolveResponse, reject) => {
        const id = randomUUID();
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Worker ${action} timed out: ${stderr}`));
        }, 10_000);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timeout);
            resolveResponse(result);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        child.send({ id, action, task_id });
      });
    },
  };
}
async function kill(child) {
  if (child.exitCode !== null) return;
  await new Promise((done) => {
    child.once('exit', done);
    child.kill('SIGKILL');
  });
}
async function barrier(directory, worker) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(
        await readFile(join(directory, 'crash-barrier.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (worker.child.exitCode !== null)
      throw new Error(`Worker exited before crash barrier: ${worker.stderr()}`);
    await delay(20);
  }
  throw new Error(`Crash barrier timed out: ${worker.stderr()}`);
}
async function settle(worker, taskId, statuses) {
  const deadline = Date.now() + 20_000;
  let state;
  while (Date.now() < deadline) {
    state = await worker.rpc('read', taskId);
    if (statuses.includes(state.task.status)) return state;
    if (['failed', 'timed_out', 'cancelled'].includes(state.task.status))
      throw new Error(
        `Task failed during crash verification: ${JSON.stringify(state)}`,
      );
    await delay(20);
  }
  throw new Error(`Task failed to settle: ${JSON.stringify(state)}`);
}
async function calls(directory) {
  try {
    return (await readFile(join(directory, 'remote-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
const scenarios = [];
let secondOwnerRejected = false;
try {
  for (const stage of [
    'before-dispatch',
    'during-remote',
    'after-receipt',
    'after-local-effect',
  ]) {
    const directory = join(root, stage);
    await mkdir(directory);
    const first = await start(directory, stage, 'crash');
    if (stage === 'before-dispatch') {
      await assert.rejects(
        start(directory, stage, 'recover'),
        /already has a runtime owner/,
      );
      secondOwnerRejected = true;
    }
    const admission = await first.rpc('admit');
    const stopped = await barrier(directory, first);
    if (stopped.operation_id) {
      const db = new DatabaseSync(join(directory, 'tasks.sqlite'), {
        readOnly: true,
      });
      try {
        const row = db
          .prepare('SELECT body FROM graph_operations WHERE id=?')
          .get(stopped.operation_id);
        assert.ok(
          row,
          'The crash barrier must follow an externally visible operation commit.',
        );
        assert.equal(JSON.parse(row.body).status, stopped.status);
      } finally {
        db.close();
      }
    }
    await kill(first.child);
    const callsBeforeRestart = (await calls(directory)).length;
    const restarted = await start(directory, stage, 'recover');
    let unknown;
    if (stage === 'during-remote') {
      unknown = await settle(restarted, admission.task_id, ['paused']);
      assert.equal(unknown.task.usage.model_calls, 1);
      assert.equal(
        unknown.attempts.filter((attempt) => attempt.status === 'unknown')
          .length,
        1,
      );
      await delay(100);
      assert.equal(
        (await calls(directory)).length,
        1,
        'Unknown remote operations must not retry automatically.',
      );
      await restarted.rpc('resume', admission.task_id);
    }
    const final = await settle(restarted, admission.task_id, ['completed']);
    const dispatched = await calls(directory);
    const managerNodes = new Set(
      final.graph_nodes
        .filter((event) => event.topology === MANAGER_TOPOLOGY)
        .map((event) => event.node),
    );
    for (const node of [
      'hydrate_authority',
      'assemble_context',
      'model_decision',
      'validate_decision',
      'dispatch_assignments',
      'finalize',
    ])
      assert.ok(
        managerNodes.has(node),
        `Missing actual Manager graph trace: ${node}`,
      );
    if (stage === 'before-dispatch') {
      assert.equal(callsBeforeRestart, 0);
      assert.equal(dispatched.length, 1);
      assert.equal(final.task.usage.model_calls, 1);
    } else if (stage === 'after-receipt') {
      assert.equal(callsBeforeRestart, 1);
      assert.equal(
        dispatched.length,
        1,
        'A persisted model response must be replayed without a new charged call.',
      );
      assert.equal(final.task.usage.model_calls, 1);
    } else if (stage === 'during-remote') {
      assert.equal(dispatched.length, 2);
      assert.equal(final.task.usage.model_calls, 2);
      assert.equal(final.task.limits.deadline, unknown.task.limits.deadline);
    } else {
      assert.ok(managerNodes.has('execute_action'));
      const findings = final.artifacts.filter(
        (artifact) => artifact.kind === 'crash.finding',
      );
      assert.equal(
        findings.length,
        1,
        'The local artifact must commit exactly once.',
      );
      assert.equal(findings[0].id, stopped.artifact_id);
      assert.equal(findings[0].sha256, stopped.sha256);
      assert.equal(final.task.usage.artifacts, final.task.artifacts.length);
      const specialistNodes = new Set(
        final.graph_nodes
          .filter((event) => event.actor === 'HazeOps')
          .map((event) => event.node),
      );
      for (const node of ['hydrate', 'context', 'deterministic', 'completion'])
        assert.ok(
          specialistNodes.has(node),
          `Missing actual specialist graph trace: ${node}`,
        );
    }
    await restarted.rpc('close');
    scenarios.push({
      stage,
      passed: true,
      barrier: stopped,
      calls_before_restart: callsBeforeRestart,
      remote_calls: dispatched.length,
      final,
    });
    console.log(`PASS ${stage}`);
  }
} finally {
  for (const child of workers) await kill(child);
  const report = {
    checked_at: new Date().toISOString(),
    node: process.version,
    mode: 'scripted-process-crash',
    passed: scenarios.length === 4 && secondOwnerRejected,
    second_owner_rejected: secondOwnerRejected,
    scenarios,
  };
  const path = join(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path, passed: report.passed }));
}
