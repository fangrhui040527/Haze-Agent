import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { contractHash } from '../dist/contracts/json.js';
import {
  exactReductionRef,
  createReductionSelection,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../dist/capabilities/damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../dist/capabilities/damage-reduction-planning/planning-fixtures.js';
import {
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeViewSchema,
  reductionProgrammeHistorySchema,
} from '../dist/contracts/damage-reduction-programme.js';

if (process.argv.slice(2).some((flag) => flag !== '--fixture'))
  throw new Error(
    'Usage: verify-damage-reduction-programmes.mjs [--fixture]. Synthetic engineering verification only.',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-reduction-programmes-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const frozenCases = JSON.parse(
  await readFile(
    new URL(
      '../docs/Testing/damage-reduction-programme-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
let child;
let checkpoint;
async function boot(crashBeforeDispatch = false) {
  child = fork(
    new URL(
      crashBeforeDispatch
        ? './reduction-programme-crash-worker.mjs'
        : './serve-tasks.mjs',
      import.meta.url,
    ),
    crashBeforeDispatch ? [] : ['--fixture'],
    {
      env: {
        ...process.env,
        STATE_DIR: root,
        HAZE_TASK_STATE_DIR: root,
        HAZE_TASK_PORT: '0',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  const active = child;
  return new Promise((ready, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error('Programme verification server startup timed out.')),
      45_000,
    );
    active.on('message', (message) => {
      if (message.kind === 'committed-before-dispatch') checkpoint = message;
      if (message.port) {
        clearTimeout(timer);
        ready(`http://127.0.0.1:${message.port}`);
      }
    });
    active.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    active.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Programme verification server exited (${code}).`));
    });
  });
}
async function exitOf(active) {
  if (active.exitCode !== null) return;
  await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Verification child did not exit.')),
      15_000,
    );
    active.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const active = child;
  active.kill('SIGTERM');
  await exitOf(active);
}
async function raw(origin, path, body, key = randomUUID()) {
  const response = await fetch(
    `${origin}${path}`,
    body === undefined
      ? { headers: { Connection: 'close' } }
      : {
          method: 'POST',
          headers: {
            Connection: 'close',
            'Content-Type': 'application/json',
            Origin: origin,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
  );
  return { status: response.status, body: await response.json() };
}
async function read(origin, path, body, key) {
  const result = await raw(origin, path, body, key);
  if (result.status < 200 || result.status >= 300)
    throw new Error(
      `HTTP ${result.status} ${path}: ${JSON.stringify(result.body)}`,
    );
  return result.body;
}
const programmePath = (id) => `/api/reduction-programmes/${id}`;
const view = async (origin, id) =>
  reductionProgrammeViewSchema.parse(await read(origin, programmePath(id)));
const history = async (origin, id) =>
  reductionProgrammeHistorySchema.parse(
    await read(origin, `${programmePath(id)}/history`),
  );
const fence = (task) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'checked_at')
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
async function settle(origin, id) {
  const deadline = Date.now() + 310_000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > deadline)
      throw new Error(`Programme task ${id} did not settle.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function captureTask(origin, id) {
  const task = await read(origin, `/api/tasks/${id}`);
  const artifacts = [];
  for (const { artifact: ref } of task.artifacts) {
    const artifact = await read(origin, `/api/artifacts/${ref.id}`);
    assert.equal(artifact.sha256, ref.sha256);
    assert.equal(artifact.version, ref.version);
    artifacts.push(artifact);
  }
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await read(origin, `/api/tasks/${id}/events?after=${cursor}`);
    events.push(...page.events);
    if (page.next_cursor === cursor || page.events.length < 100) break;
    cursor = page.next_cursor;
  }
  return { task, artifacts, events };
}
async function captureProgramme(origin, id) {
  const current = await view(origin, id);
  const tasks = [];
  for (const taskId of new Set(
    current.attempts.map(({ attempt }) => attempt.task_id),
  ))
    tasks.push(await captureTask(origin, taskId));
  return { view: current, history: await history(origin, id), tasks };
}
async function phase(origin, id, kind, traces, assessmentAttemptId) {
  const current = await view(origin, id);
  const body = {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: current.programme.revision,
    phase: kind,
    ...(assessmentAttemptId
      ? { assessment_attempt_id: assessmentAttemptId }
      : {}),
  };
  const key = randomUUID();
  const started = performance.now();
  const receipt = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, `${programmePath(id)}/phases`, body, key),
  );
  assert.deepEqual(
    await read(origin, `${programmePath(id)}/phases`, body, key),
    receipt,
  );
  const attempt = receipt.attempt;
  assert.ok(attempt);
  const task = await settle(origin, attempt.task_id);
  assert.equal(
    task.status,
    'completed',
    JSON.stringify({
      error: task.error,
      work: task.assignments.map(({ definition_id, status, error, gaps }) => ({
        definition_id,
        status,
        error,
        gaps,
      })),
    }),
  );
  assert.equal(task.current_run_id, attempt.run_id);
  assert.equal(task.objective_revision, attempt.objective_revision);
  if (kind === 'planning') {
    const predecessor = current.attempts.find(
      ({ attempt }) => attempt.id === assessmentAttemptId,
    ).preview;
    for (const ref of [
      predecessor.assessment.artifact,
      predecessor.arithmetic_review.artifact,
    ]) {
      assert.ok(
        attempt.selected_refs.some(
          (selected) =>
            selected.id === ref.id &&
            selected.version === ref.version &&
            selected.sha256 === ref.sha256,
        ),
      );
      assert.ok(
        !task.original_request.context_refs.some(({ id }) => id === ref.id),
        'Predecessor reviews are bound programme lineage, not implicit factual numerical input.',
      );
    }
  }
  assert.deepEqual(attempt.reservation, {
    model_calls: task.limits.max_model_calls,
    tool_calls: task.limits.max_tool_calls,
  });
  const projected = (await view(origin, id)).attempts.find(
    (item) => item.attempt.id === attempt.id,
  );
  assert.equal(projected.currency, 'current');
  assert.equal(projected.execution_status, 'completed');
  assert.equal(projected.result_status, 'available');
  assert.equal(projected.preview.arithmetic_review.value.verdict, 'supported');
  if (kind === 'planning')
    assert.equal(projected.preview.plan_review.value.verdict, 'supported');
  const captured = await captureTask(origin, task.id);
  traces.push({
    phase: kind,
    attempt_id: attempt.id,
    task_id: task.id,
    run_id: attempt.run_id,
    programme_revision: attempt.programme_revision,
    objective_revision: attempt.objective_revision,
    latency_ms: performance.now() - started,
    usage: task.usage,
    reservation: attempt.reservation,
    limits: task.limits,
    artifact_bytes: Buffer.byteLength(JSON.stringify(captured.artifacts)),
    current_point_estimate:
      projected.preview.claims?.point_estimate_label ?? 'unavailable',
  });
  return attempt;
}
async function create(origin, preview, title) {
  return reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, '/api/reduction-programmes', {
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title,
      accountable_owner: 'Synthetic local programme owner',
      scientific_owner: null,
      preview,
    }),
  );
}

let report;
try {
  let origin = await boot();
  const input = syntheticResidualImport();
  const imported = await read(origin, '/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'programme-residual-source.json',
    media_type: 'application/json',
    declared_origin:
      'Explicit synthetic engineering data; no non-synthetic reference or scientific qualification.',
    content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
  });
  const source = exactReductionRef(imported.artifact ?? imported);
  assert.deepEqual(
    (await read(origin, `/api/artifacts/${source.id}`)).content,
    input,
  );
  const preview = {
    schema_version: 'haze.reduction.preview-request.v1',
    selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]),
    candidate: syntheticReductionCandidate(),
  };
  const created = await create(
    origin,
    preview,
    'Synthetic coordinated digital-action programme',
  );
  const id = created.programme_id;
  assert.equal((await view(origin, id)).attempts.length, 0);
  const traces = [];
  const firstAssessment = await phase(origin, id, 'assessment', traces);
  const firstPlan = await phase(
    origin,
    id,
    'planning',
    traces,
    firstAssessment.id,
  );
  const original = await view(origin, id);
  assert.equal(original.attempts.length, 2);
  const noteBody = {
    schema_version: 'haze.reduction.programme.record-request.v1',
    expected_revision: original.programme.revision,
    record: {
      kind: 'note',
      text: 'Unrelated administrative note; the endpoint, selected sources and target remain unchanged.',
    },
  };
  const noteReceipt = await read(
    origin,
    `${programmePath(id)}/records`,
    noteBody,
    'retained-note',
  );
  assert.deepEqual(
    await read(
      origin,
      `${programmePath(id)}/records`,
      noteBody,
      'retained-note',
    ),
    noteReceipt,
  );
  const noted = await view(origin, id);
  assert.ok(noted.attempts.every(({ currency }) => currency === 'current'));
  assert.deepEqual(
    noted.attempts.map(({ attempt }) => attempt.input_fingerprint),
    original.attempts.map(({ attempt }) => attempt.input_fingerprint),
  );
  const revisedPreview = structuredClone(preview);
  revisedPreview.selection.target.target_fraction = '0.15';
  await read(origin, `${programmePath(id)}/revisions`, {
    schema_version: 'haze.reduction.programme.revise.v1',
    expected_revision: noted.programme.revision,
    reason:
      'Explicit operator correction raises the target to fifteen percent.',
    preview: revisedPreview,
  });
  const stale = await view(origin, id);
  assert.equal(stale.attempts.length, 2);
  assert.ok(stale.attempts.every(({ currency }) => currency === 'stale'));
  assert.equal(stale.capacity.active_attempt_id, null);
  assert.equal(stale.capacity.remaining_runs, 10);
  const replacementAssessment = await phase(origin, id, 'assessment', traces);
  const replacementPlan = await phase(
    origin,
    id,
    'planning',
    traces,
    replacementAssessment.id,
  );
  const current = await view(origin, id);
  assert.equal(current.attempts.length, 4);
  assert.equal(
    current.attempts.find(({ attempt }) => attempt.id === replacementPlan.id)
      .preview.claims.point_estimate_label,
    'does_not_meet',
  );
  assert.ok(
    current.attempts
      .filter(({ attempt }) =>
        [firstAssessment.id, firstPlan.id].includes(attempt.id),
      )
      .every(({ currency }) => currency !== 'current'),
  );
  const oldPlanRef = original.attempts.find(
    ({ attempt }) => attempt.id === firstPlan.id,
  ).preview.plan.artifact;
  await read(origin, `${programmePath(id)}/records`, {
    schema_version: 'haze.reduction.programme.record-request.v1',
    expected_revision: current.programme.revision,
    record: {
      kind: 'attachment',
      artifact: oldPlanRef,
      description:
        'Exact earlier planning result retained as historical context; it cannot satisfy the revised target.',
    },
  });
  const final = await view(origin, id);
  assert.equal(
    final.records.filter(({ record }) => record.kind === 'attachment')[0]
      .task_binding.run_id,
    firstPlan.run_id,
  );
  assert.equal(final.capacity.reserved_model_calls, 0);
  assert.equal(final.capacity.reserved_tool_calls, 0);
  assert.equal(
    final.capacity.charged_model_calls,
    traces.reduce((total, item) => total + item.usage.model_calls, 0),
  );
  assert.equal(
    final.capacity.charged_tool_calls,
    traces.reduce((total, item) => total + item.usage.tool_calls, 0),
  );
  assert.equal(final.capacity.remaining_runs, 8);
  assert.equal(final.capacity.remaining_attempts.assessment, 1);
  assert.equal(final.capacity.remaining_attempts.planning, 1);
  assert.equal(final.scientific_qualification, 'unqualified');
  assert.equal(final.achieved_reduction, false);
  const page = await read(
    origin,
    `${programmePath(id)}/history?limit=2&offset=0`,
  );
  assert.equal(page.revisions.length, 2);
  assert.equal(page.next_offset, 2);
  const fullHistory = await history(origin, id);
  assert.ok(fullHistory.revisions.length >= 7);
  assert.equal(
    new Set(fullHistory.revisions.map(({ revision }) => revision)).size,
    fullHistory.revisions.length,
  );
  const boundTask = await read(origin, `/api/tasks/${replacementPlan.task_id}`);
  const direct = await raw(origin, `/api/tasks/${boundTask.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(boundTask),
    action: 'continue',
  });
  assert.ok([403, 409].includes(direct.status));
  assert.equal(
    (await read(origin, `/api/tasks/${boundTask.id}`)).current_run_id,
    replacementPlan.run_id,
  );
  assert.equal((await view(origin, id)).attempts.length, 4);
  const before = await captureProgramme(origin, id);
  await stop();
  origin = await boot();
  const after = await captureProgramme(origin, id);
  assert.deepEqual(stable(after), stable(before));

  const recoveryProgramme = await create(
    origin,
    preview,
    'Synthetic crash-before-dispatch recovery programme',
  );
  const crashInput = {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: recoveryProgramme.revision,
    phase: 'assessment',
  };
  await stop();
  checkpoint = undefined;
  origin = await boot(true);
  try {
    await raw(
      origin,
      `${programmePath(recoveryProgramme.programme_id)}/phases`,
      crashInput,
      'recover-committed-phase',
    );
  } catch {
    /* The crash may close the socket after commit and before the receipt reaches this client. */
  }
  await exitOf(child);
  checkpoint = JSON.parse(
    await readFile(resolve(root, 'committed-before-dispatch.json'), 'utf8'),
  );
  assert.ok(
    checkpoint?.task_id,
    'The crash worker must confirm a committed task before dispatch.',
  );
  assert.equal(checkpoint.status, 'queued');
  assert.equal(checkpoint.usage.model_calls, 0);
  assert.equal(checkpoint.usage.tool_calls, 0);
  origin = await boot();
  const durableReceipt = reductionProgrammeMutationReceiptSchema.parse(
    await read(
      origin,
      `${programmePath(recoveryProgramme.programme_id)}/phases`,
      crashInput,
      'recover-committed-phase',
    ),
  );
  assert.equal(durableReceipt.attempt.task_id, checkpoint.task_id);
  const recoveredTask = await settle(origin, checkpoint.task_id);
  assert.equal(
    recoveredTask.status,
    'completed',
    JSON.stringify({
      error: recoveredTask.error,
      work: recoveredTask.assignments.map(
        ({ definition_id, status, error }) => ({
          definition_id,
          status,
          error,
        }),
      ),
    }),
  );
  assert.equal(recoveredTask.current_run_id, durableReceipt.attempt.run_id);
  const recovered = await view(origin, recoveryProgramme.programme_id);
  const recoveredCapture = await captureTask(origin, recoveredTask.id);
  assert.ok(
    !recoveredCapture.events.some(
      (event) =>
        event.type === 'graph_node' &&
        event.generation === checkpoint.generation,
    ),
    'The committed task must not dispatch a graph before the deliberate crash.',
  );
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.capacity.reserved_tool_calls, 0);
  assert.equal(
    recovered.capacity.charged_tool_calls,
    recoveredTask.usage.tool_calls,
  );
  assert.equal(recovered.capacity.remaining_runs, 11);
  report = {
    checked_at: new Date().toISOString(),
    passed: true,
    mode: 'fixture',
    frozen_cases_sha256: contractHash(frozenCases),
    programme_id: id,
    restart: true,
    explicit_runs: 4,
    duplicate_receipts: true,
    note_freshness: true,
    material_invalidation: true,
    material_revision_projection: stale,
    exact_task_run_bindings: true,
    historical_attachment: true,
    direct_task_successor_denied: true,
    committed_crash_recovery: {
      programme_id: recoveryProgramme.programme_id,
      checkpoint,
      receipt: durableReceipt,
      view: recovered,
      capture: recoveredCapture,
    },
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
    configured_live_model_behavior: 'not_tested',
    traces,
    before_restart: before,
    after_restart: after,
  };
  const reportPath = resolve(root, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        passed: true,
        programme_id: id,
        restart: true,
        crash_recovered_same_task: durableReceipt.attempt.task_id,
        capacity: after.view.capacity,
        traces,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    resolve(root, 'failure.json'),
    `${JSON.stringify({ checked_at: new Date().toISOString(), passed: false, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), checkpoint }, null, 2)}\n`,
  );
  throw error;
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
