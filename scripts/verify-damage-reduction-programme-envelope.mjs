import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, contractHash } from '../dist/contracts/json.js';
import {
  exactReductionRef,
  createReductionSelection,
  normalizeReductionSelection,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';
import { createReductionCapacityFixture } from '../dist/capabilities/damage-reduction-planning/capacity-fixtures.js';
import { syntheticReductionCandidate } from '../dist/capabilities/damage-reduction-planning/planning-fixtures.js';
import {
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeViewSchema,
} from '../dist/contracts/damage-reduction-programme.js';
import { createReductionVerificationReader } from './reduction-verification-http.mjs';

const flags = process.argv.slice(2);
if (
  flags.some((flag) => !['--fixture', '--live', '--capacity'].includes(flag)) ||
  (flags.includes('--live') && flags.includes('--fixture'))
)
  throw new Error(
    'Usage: verify-damage-reduction-programme-envelope.mjs [--fixture|--live] [--capacity]. Evidence is explicitly synthetic in both runtime modes.',
  );
const live = flags.includes('--live');
const capacity = flags.includes('--capacity');
const mode = live ? 'live' : 'fixture';
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-reduction-programme-envelope-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
let child;
let origin;
let programmeId;
const transportRetries = [];
const read = createReductionVerificationReader({
  onRetry: (item) => transportRetries.push(item),
});
const report = {
  schema_version: 'haze.reduction.programme-envelope-verification.v1',
  passed: false,
  mode,
  evidence_origin: 'synthetic',
  scientific_qualification: 'unqualified',
  achieved_reduction: false,
  configured_live_model_behavior: 'not_tested',
  capacity_case: capacity
    ? '500-rows-16-originals-exact-512KiB'
    : 'two-row-reference',
  started_at: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  phases: [],
  server_startups_ms: [],
  server_memory: [],
  acceptance: {
    max_api_peak_rss_bytes: 1_073_741_824,
    max_manager_input_bytes: 24_576,
    max_programme_snapshot_bytes: 65_536,
    max_normalized_numerical_bytes: 524_288,
    latency: 'Each phase retains its unchanged admitted runtime deadline.',
  },
  transport_retries: transportRetries,
  limitations: [
    'All quantities and the proposed service are synthetic; no scientific qualification, delivery or achieved-effect conclusion is granted.',
    'This is an admitted programme trace, not a single-agent comparative usefulness or provider-cost benchmark.',
    'A passing envelope demonstrates this exact supplied bundle and runtime mode, not every combination of contract maxima or production throughput.',
    'Fixture success alone does not qualify configured model behavior; live verification requires actual charged model calls and retained provider receipts.',
  ],
};
const save = () =>
  writeFile(
    resolve(root, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
async function boot() {
  const started = performance.now();
  child = fork(
    new URL('./reduction-capacity-worker.mjs', import.meta.url),
    live ? [] : ['--fixture'],
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
      () => reject(new Error('Envelope server startup timed out.')),
      45_000,
    );
    active.on('message', (message) => {
      if (!message.port) return;
      clearTimeout(timer);
      report.server_startups_ms.push(performance.now() - started);
      ready(`http://127.0.0.1:${message.port}`);
    });
    active.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    active.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Envelope server exited (${code}).`));
    });
  });
}
async function captureMemory() {
  const active = child;
  const requestId = randomUUID();
  const memory = await new Promise((ready, reject) => {
    const listener = (message) => {
      if (
        message?.type !== 'reduction-capacity-metrics' ||
        message.request_id !== requestId
      )
        return;
      clearTimeout(timer);
      active.off('message', listener);
      ready({
        rss_bytes: message.rss_bytes,
        peak_rss_bytes: message.peak_rss_bytes,
      });
    };
    const timer = setTimeout(() => {
      active.off('message', listener);
      reject(new Error('Envelope memory telemetry timed out.'));
    }, 5000);
    active.on('message', listener);
    active.send({ type: 'reduction-capacity-metrics', request_id: requestId });
  });
  report.server_memory.push(memory);
  assert.ok(
    memory.peak_rss_bytes <= report.acceptance.max_api_peak_rss_bytes,
    'The API process exceeded the predeclared 1 GiB peak RSS envelope.',
  );
}
async function persistedBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'report.json') continue;
    const path = resolve(directory, entry.name);
    bytes += entry.isDirectory()
      ? await persistedBytes(path)
      : (await stat(path)).size;
  }
  return bytes;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const active = child;
  await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      active.kill('SIGKILL');
      reject(new Error('Envelope server shutdown timed out.'));
    }, 15_000);
    active.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    active.kill('SIGTERM');
  });
}
const pathFor = (id) => `/api/reduction-programmes/${id}`;
const view = async () =>
  reductionProgrammeViewSchema.parse(await read(origin, pathFor(programmeId)));
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
async function settle(id) {
  const deadline = Date.now() + 310_000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > deadline)
      throw new Error(`Envelope task ${id} did not settle.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function captureTask(id) {
  const task = await read(origin, `/api/tasks/${id}`);
  const artifacts = [];
  for (const { artifact: ref } of task.artifacts) {
    const original = await read(origin, `/api/artifacts/${ref.id}`);
    assert.equal(original.version, ref.version);
    assert.equal(original.sha256, ref.sha256);
    assert.equal(contractHash(original.content), ref.sha256);
    artifacts.push(original);
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
async function captureProgramme() {
  const current = await view();
  const tasks = [];
  for (const id of new Set(
    current.attempts.map(({ attempt }) => attempt.task_id),
  ))
    tasks.push(await captureTask(id));
  return {
    view: current,
    history: await read(origin, `${pathFor(programmeId)}/history`),
    tasks,
  };
}
async function phase(kind, assessmentId) {
  const current = await view();
  const request = {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: current.programme.revision,
    phase: kind,
    ...(assessmentId ? { assessment_attempt_id: assessmentId } : {}),
  };
  const key = randomUUID();
  const start = performance.now();
  const receipt = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, `${pathFor(programmeId)}/phases`, request, key),
  );
  assert.deepEqual(
    await read(origin, `${pathFor(programmeId)}/phases`, request, key),
    receipt,
  );
  const attempt = receipt.attempt;
  assert.ok(attempt);
  const task = await settle(attempt.task_id);
  const captured = await captureTask(task.id);
  const currentProjection = await view();
  const projected = currentProjection.attempts.find(
    (item) => item.attempt.id === attempt.id,
  );
  const measured = {
    phase: kind,
    attempt_id: attempt.id,
    task_id: task.id,
    run_id: task.current_run_id,
    latency_ms: performance.now() - start,
    task_duration_ms: (() => {
      const completed = captured.events.findLast(
        (event) =>
          event.type === 'task_completed' &&
          event.run_id === task.current_run_id,
      );
      return completed
        ? Date.parse(completed.at) - Date.parse(task.created_at)
        : null;
    })(),
    usage: task.usage,
    limits: task.limits,
    reservation: attempt.reservation,
    task_status: task.status,
    task_scope_bytes: Buffer.byteLength(
      JSON.stringify(task.original_request.scope),
    ),
    artifact_bytes: Buffer.byteLength(JSON.stringify(captured.artifacts)),
    maximum_material_dependencies: Math.max(
      0,
      ...captured.artifacts.map((artifact) => artifact.dependencies.length),
    ),
    preview_state: projected?.preview?.state ?? null,
    preview_reasons: projected?.preview?.reasons ?? [],
    provider_receipts: (task.result?.provenance.receipts ?? []).filter(
      (receipt) => receipt.kind === 'model',
    ),
    captured,
  };
  report.phases.push(measured);
  report.current = currentProjection;
  await save();
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
  assert.ok(
    Number.isFinite(measured.task_duration_ms) &&
      measured.task_duration_ms >= 0,
    'Completed task timing requires its exact persisted completion event.',
  );
  assert.equal(task.limits.max_model_input_bytes, 24_576);
  assert.equal(task.result?.provenance.mode, mode);
  assert.deepEqual(attempt.reservation, {
    model_calls: task.limits.max_model_calls,
    tool_calls: task.limits.max_tool_calls,
  });
  assert.equal(projected.currency, 'current');
  assert.equal(projected.preview.arithmetic_review.value.verdict, 'supported');
  assert.equal(projected.preview.claims.point_estimate_label, 'meets');
  if (kind === 'planning') {
    assert.equal(projected.preview.plan_review.value.verdict, 'supported');
    assert.equal(projected.preview.plan_eligibility, 'conditional');
    assert.equal(attempt.assessment_attempt_id, assessmentId);
  }
  return attempt;
}
try {
  origin = await boot();
  const fixture = createReductionCapacityFixture(
    capacity ? 500 : 2,
    capacity ? 16 : 1,
    capacity ? 524_288 : undefined,
  );
  const sources = [];
  const originals = [];
  for (const [index, artifact] of fixture.artifacts.entries()) {
    const imported = await read(origin, '/api/artifacts', {
      schema_version: 'haze.artifact.import.v3',
      filename: `synthetic-programme-envelope-${index}.json`,
      media_type: 'application/json',
      declared_origin:
        'Explicitly synthetic engineering quantities; no scientific applicability or delivered effect.',
      content_base64: Buffer.from(JSON.stringify(artifact.content)).toString(
        'base64',
      ),
    });
    const original = imported.artifact ?? imported;
    assert.deepEqual(
      (await read(origin, `/api/artifacts/${original.id}`)).content,
      artifact.content,
    );
    sources.push(exactReductionRef(original));
    originals.push(original);
  }
  const selection = createReductionSelection(
    fixture.target,
    fixture.selection.sources.map((item, index) => ({
      ...item,
      artifact: sources[index],
    })),
  );
  const normalized = normalizeReductionSelection(selection, originals);
  const normalizedBytes = Buffer.byteLength(
    canonicalJson(normalized.records, 8_388_608),
  );
  assert.equal(normalizedBytes, fixture.normalized_bytes);
  if (capacity) assert.equal(normalizedBytes, 524_288);
  const request = {
    schema_version: 'haze.reduction.programme.create.v1',
    expected_revision: 0,
    title: 'Explicit synthetic programme input-envelope verification',
    accountable_owner: 'Synthetic local engineering operator',
    scientific_owner: null,
    preview: {
      schema_version: 'haze.reduction.preview-request.v1',
      selection,
      candidate: {
        ...syntheticReductionCandidate(),
        name: fixture.target.intervention,
      },
    },
  };
  const key = randomUUID();
  const created = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, '/api/reduction-programmes', request, key),
  );
  assert.deepEqual(
    await read(origin, '/api/reduction-programmes', request, key),
    created,
  );
  programmeId = created.programme_id;
  report.programme_id = programmeId;
  report.input = {
    selected_rows: capacity ? 500 : 2,
    numerical_originals: sources.length,
    normalized_bytes: normalizedBytes,
    programme_request_bytes: Buffer.byteLength(JSON.stringify(request)),
    exact_originals: sources,
  };
  const initial = await view();
  assert.equal(initial.attempts.length, 0);
  report.input.programme_snapshot_bytes = Buffer.byteLength(
    canonicalJson(initial.programme, 65_536),
  );
  const assessment = await phase('assessment');
  await phase('planning', assessment.id);
  await captureMemory();
  const current = await view();
  assert.equal(current.capacity.reserved_model_calls, 0);
  assert.equal(current.capacity.reserved_tool_calls, 0);
  for (const resource of ['model_calls', 'tool_calls'])
    assert.equal(
      current.capacity[`charged_${resource}`],
      report.phases.reduce((sum, phase) => sum + phase.usage[resource], 0),
    );
  assert.equal(current.scientific_qualification, 'unqualified');
  assert.equal(current.achieved_reduction, false);
  report.before_restart = await captureProgramme();
  await stop();
  origin = await boot();
  report.after_restart = await captureProgramme();
  assert.deepEqual(stable(report.after_restart), stable(report.before_restart));
  await captureMemory();
  report.restart_readback = 'exact';
  const modelCalls = report.phases.reduce(
    (sum, phase) => sum + phase.usage.model_calls,
    0,
  );
  report.model_calls = modelCalls;
  if (live) {
    const actualReceipts = report.phases.flatMap(({ provider_receipts }) =>
      provider_receipts.filter(
        (entry) =>
          entry.status === 'completed' &&
          entry.accepted === true &&
          entry.synthetic !== true &&
          entry.receipt?.synthetic !== true &&
          entry.receipt?.http_status >= 200 &&
          entry.receipt.http_status < 300 &&
          entry.receipt.response_status === 'stop' &&
          typeof entry.receipt.response_model === 'string' &&
          entry.receipt.response_model.length > 0 &&
          typeof entry.receipt.response_id === 'string' &&
          entry.receipt.response_id.length > 0,
      ),
    );
    report.actual_provider_receipts = actualReceipts.length;
    report.configured_live_model_behavior =
      modelCalls > 0 && actualReceipts.length
        ? 'verified_admitted_trace'
        : 'not_exercised';
    assert.ok(
      modelCalls > 0 && actualReceipts.length > 0,
      'Configured live verification requires actual charged model calls and successful provider receipts; deterministic completion cannot qualify model behavior.',
    );
  }
  report.passed = true;
} catch (error) {
  report.error = {
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  };
  if (origin && programmeId) {
    try {
      report.failure_capture = await captureProgramme();
    } catch (captureError) {
      report.capture_error = captureError.message;
    }
  }
  process.exitCode = 1;
} finally {
  try {
    await stop();
  } catch (error) {
    report.passed = false;
    report.shutdown_error = error.message;
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  try {
    const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
      readOnly: true,
    });
    try {
      report.model_attempts = database
        .prepare('SELECT body FROM attempts ORDER BY rowid')
        .all()
        .map(({ body }) => JSON.parse(body))
        .filter(({ kind }) => kind === 'model');
    } finally {
      database.close();
    }
    report.persisted_bytes_excluding_report = await persistedBytes(root);
    if (live && !report.passed && report.model_attempts.length)
      report.configured_live_model_behavior = 'attempted_unsuccessful_trace';
  } catch (error) {
    report.telemetry_error = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  await save();
}
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      mode,
      capacity,
      report: resolve(root, 'report.json'),
      model_calls: report.model_calls ?? null,
      phases: report.phases.map(
        ({ phase, task_status, usage, latency_ms }) => ({
          phase,
          task_status,
          usage,
          latency_ms,
        }),
      ),
      error: report.error ?? null,
    },
    null,
    2,
  ),
);
