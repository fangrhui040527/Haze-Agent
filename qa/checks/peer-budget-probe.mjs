#!/usr/bin/env node
// Probe for finding F-03: is the peer-channel byte auto-close
//   app/tasks/store.ts:5986  -> if (channel.messages === 6 || channel.bytes === 12_288)
// reachably wrong, given the send guard
//   app/tasks/store.ts:5963  -> channel.messages >= 6 || channel.bytes + bytes > 12_288
//
// Claim under test: because the guard caps the running total at 12_288, true
// byte exhaustion lands on EXACTLY 12_288, so the === does fire and there is no
// "exhausted but still open" state. This probe tries to construct one anyway.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/tasks/store.js';
import { taskRequestSchema } from '../../dist/contracts/tasks.js';

const CAP = 12_288;
const identity = { principal: 'qa-user', workspace: 'qa-workspace' };
const roots = [];
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, ...detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  if (detail && Object.keys(detail).length)
    process.stdout.write(`       ${JSON.stringify(detail)}\n`);
}

function openScene() {
  const root = mkdtempSync(join(tmpdir(), 'haze-peer-probe-'));
  roots.push(root);
  const store = new TaskStore(root, { recover: true });
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Explain the uploaded research notes.',
    }),
    identity,
    randomUUID(),
    { mode: 'fixture', tools: [] },
  ).task;
  const defs = [
    {
      role: 'HazeOps',
      definition_id: 'test.explain',
      capability: 'test',
      definition_version: '3',
      brief: 'Explain the notes.',
    },
    {
      role: 'EvidenceCritic',
      definition_id: 'test.review',
      capability: 'test',
      definition_version: '3',
      brief: 'Review the notes.',
    },
  ];
  const jobs = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    defs,
  );
  for (const job of jobs) store.acquireAssignment(task.id, job.id);
  const channel = store.openPeerChannel(
    task.id,
    task.current_run_id,
    'Independently check exact analysis.',
    jobs.slice(0, 2).map((job) => job.id),
  );
  return { store, task, jobs, channel };
}

const send = (scene, text) =>
  scene.store.sendPeerMessage(
    scene.task.id,
    scene.channel.id,
    scene.jobs[0].id,
    scene.jobs[1].id,
    text,
    randomUUID(),
  );
const statusOf = (scene) =>
  scene.store.peerChannelForRun(scene.task.current_run_id)?.status;
const bytesOf = (scene) =>
  scene.store.peerChannelForRun(scene.task.current_run_id)?.bytes;

try {
  // --- Scenario A: land exactly on the cap in 4 messages of 3072 bytes ---
  {
    const scene = openScene();
    for (let i = 0; i < 4; i += 1) send(scene, 'A'.repeat(CAP / 4));
    const status = statusOf(scene);
    const bytes = bytesOf(scene);
    record(
      'A: bytes land exactly on 12288 -> channel auto-closes',
      bytes === CAP && status === 'closed',
      { bytes, status },
    );
  }

  // --- Scenario B: stop one byte short, then verify the last byte still fits ---
  {
    const scene = openScene();
    send(scene, 'B'.repeat(4096));
    send(scene, 'B'.repeat(4096));
    send(scene, 'B'.repeat(4095));
    const nearBytes = bytesOf(scene);
    const nearStatus = statusOf(scene);
    record(
      'B1: at 12287 bytes the channel is still open (1 byte of real capacity remains)',
      nearBytes === CAP - 1 && nearStatus === 'open',
      { bytes: nearBytes, status: nearStatus },
    );

    // If one more byte is genuinely acceptable, the channel was NOT exhausted,
    // so reporting it open was correct.
    let accepted = false;
    let error = null;
    try {
      send(scene, 'C');
      accepted = true;
    } catch (e) {
      error = e?.code ?? String(e?.message ?? e);
    }
    const finalBytes = bytesOf(scene);
    const finalStatus = statusOf(scene);
    record(
      'B2: the remaining 1 byte is accepted and THEN the channel closes',
      accepted && finalBytes === CAP && finalStatus === 'closed',
      { accepted, error, bytes: finalBytes, status: finalStatus },
    );
  }

  // --- Scenario C: a message that would overshoot is refused, total unchanged ---
  {
    const scene = openScene();
    send(scene, 'D'.repeat(4096));
    const before = bytesOf(scene);
    let code = null;
    try {
      send(scene, 'E'.repeat(CAP));
      code = 'ACCEPTED';
    } catch (e) {
      code = e?.code ?? String(e?.message ?? e);
    }
    const after = bytesOf(scene);
    record(
      'C: overshooting message refused and running total unchanged',
      code !== 'ACCEPTED' && before === after && statusOf(scene) === 'open',
      { code, before, after, status: statusOf(scene) },
    );
  }

  // --- Scenario D: can an "exhausted but open" state be constructed at all? ---
  // Exhausted means no message of >=1 byte fits: 12288 - bytes < 1, i.e.
  // bytes > 12287. Since the guard forbids bytes > 12288, the only exhausted
  // value is exactly 12288 -- which Scenario A shows closes the channel.
  {
    const scene = openScene();
    send(scene, 'F'.repeat(4096));
    send(scene, 'F'.repeat(4096));
    send(scene, 'F'.repeat(4096));
    const bytes = bytesOf(scene);
    const status = statusOf(scene);
    const exhausted = CAP - bytes < 1;
    record(
      'D: no reachable state is byte-exhausted while still marked open',
      !(exhausted && status === 'open'),
      { bytes, status, exhausted, headroom: CAP - bytes },
    );
  }
} finally {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const failed = results.filter((r) => !r.ok);
const verdict =
  failed.length === 0
    ? 'F-03 RETRACTED: the === auto-close fires on true exhaustion; no exhausted-but-open state exists. Remains a style/fragility note only.'
    : 'F-03 STANDS: an exhausted-but-open channel state was observed.';
console.log(`\n${verdict}`);
// Write a clean machine-readable artifact; stdout stays human-readable.
writeFileSync(
  'qa/peer-budget-probe.json',
  `${JSON.stringify({ probe: 'F-03 peer byte budget', verdict, results }, null, 2)}\n`,
);
console.log('wrote qa/peer-budget-probe.json');
process.exit(failed.length ? 1 : 0);
