#!/usr/bin/env node
// Probe for finding F-06 (UNCONFIRMED in the record).
//
// Claim under test (app/tasks/store.ts chargeAttempt, ~3344-3375):
//   completedReview only recognises an EvidenceCritic with status === 'completed'.
//   A terminally FAILED critic therefore never satisfies it, so
//   reviewRemaining = floor(reserved_model_calls / 2) stays positive for the rest
//   of the run and that capacity is reserved for a review that can never happen.
//
// Observable consequence: after a terminal critic failure, the final synthesis
// assignment should still be able to use the capacity nobody can claim. If the
// bug is real, synthesis is cut off early with `model_limit`.
//
// Control: the same sequence with a COMPLETED critic must release the reserve.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../dist/tasks/store.js';
import { taskRequestSchema } from '../../dist/contracts/tasks.js';

const identity = { principal: 'qa-user', workspace: 'qa-workspace' };
const roots = [];
const results = [];

const MAX_MODEL = 4;
const RESERVED = 2; // -> ceil(2/2)=1 synthesis, floor(2/2)=1 review

function record(name, ok, detail) {
  results.push({ name, ok, ...detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  process.stdout.write(`       ${JSON.stringify(detail)}\n`);
}

function limits() {
  return {
    deadline: new Date(Date.now() + 600_000).toISOString(),
    max_model_calls: MAX_MODEL,
    max_tool_calls: 8,
    max_assignments: 8,
    max_artifacts: 16,
    max_model_input_bytes: 16_384,
    max_model_output_tokens: 1_200,
    reserved_model_calls: RESERVED,
  };
}

const def = (over) => ({
  role: 'HazeOps',
  definition_id: 'test.explain',
  capability: 'test',
  definition_version: '3',
  brief: 'Explain the notes.',
  max_model_calls: 99,
  ...over,
});

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'haze-reserve-probe-'));
  roots.push(root);
  const store = new TaskStore(root, { recover: true });
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Explain the uploaded research notes.',
    }),
    identity,
    randomUUID(),
    { mode: 'fixture', tools: [], limits: limits() },
  ).task;
  const [specialist, critic, synthesis] = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      def(),
      def({ role: 'EvidenceCritic', definition_id: 'test.review' }),
      def({ role: 'Manager', definition_id: 'core.manager.synthesis' }),
    ],
  );
  for (const a of [specialist, critic, synthesis])
    store.acquireAssignment(task.id, a.id);
  return { store, task, specialist, critic, synthesis };
}

const charge = (s, assignment) => {
  try {
    s.store.chargeAttempt(s.task.id, assignment.id, 'model', {});
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e?.code ?? String(e?.message ?? e) };
  }
};
const usage = (s) => s.store.run(s.task.current_run_id).usage.model_calls;

/** Drive the run up to the specialist's ceiling, then end the critic, then
 *  measure how many calls synthesis can still make. */
function measure(criticStatus) {
  const s = scene();

  // 1. Specialist consumes until the reserve stops it.
  let specialistCalls = 0;
  for (let i = 0; i < MAX_MODEL + 2; i += 1) {
    const r = charge(s, s.specialist);
    if (!r.ok) break;
    specialistCalls += 1;
  }

  // 2. The critic reaches a terminal state WITHOUT consuming its reserve.
  s.store.completeAssignment(s.task.id, s.critic.id, s.task.generation, {
    status: criticStatus,
    ...(criticStatus === 'completed' ? { support: 'supported' } : {}),
  });

  // 3. How much can synthesis still charge?
  let synthesisCalls = 0;
  let blockedWith = null;
  for (let i = 0; i < MAX_MODEL + 2; i += 1) {
    const r = charge(s, s.synthesis);
    if (!r.ok) {
      blockedWith = r.code;
      break;
    }
    synthesisCalls += 1;
  }

  return {
    criticStatus,
    specialistCalls,
    synthesisCalls,
    finalUsage: usage(s),
    blockedWith,
    unusedCapacity: MAX_MODEL - usage(s),
  };
}

try {
  const failed = measure('failed');
  const completed = measure('completed');

  record(
    'CONTROL: a completed critic releases the review reserve to synthesis',
    completed.synthesisCalls > 0,
    completed,
  );

  // The bug, if real: a terminally failed critic strands floor(RESERVED/2)
  // calls, so synthesis gets strictly fewer calls than in the control and the
  // run ends with capacity nobody can ever use.
  const stranded =
    failed.synthesisCalls < completed.synthesisCalls &&
    failed.unusedCapacity > 0;

  record(
    'F-06: a terminally FAILED critic must not strand its reserved capacity',
    !stranded,
    {
      failed_case: failed,
      completed_case: completed,
      stranded,
    },
  );
} finally {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const failures = results.filter((r) => !r.ok);
const verdict = failures.length
  ? 'F-06 CONFIRMED: reserved review capacity is stranded after a terminal critic failure.'
  : 'F-06 REFUTED: no capacity is stranded; the reserve behaves correctly.';
console.log(`\n${verdict}`);
writeFileSync(
  'qa/review-reserve-probe.json',
  `${JSON.stringify({ probe: 'F-06 review reserve', verdict, results }, null, 2)}\n`,
);
console.log('wrote qa/review-reserve-probe.json');
process.exit(failures.length ? 1 : 0);
