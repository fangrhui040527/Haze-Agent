import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { contractHash } from '../dist/contracts/json.js';
import { artifactSchema } from '../dist/contracts/artifacts.js';
import {
  reductionProgrammeViewSchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeHistorySchema,
} from '../dist/contracts/damage-reduction-programme.js';
import {
  reductionPilotTaskViewSchema,
  pilotRegistrationRecordSchema,
} from '../dist/contracts/damage-reduction-pilot.js';
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
  suppliedCompletePilotInput,
  syntheticPilotRegistration,
  syntheticDigitalActionRecord,
  syntheticActionReceipt,
} from '../dist/capabilities/damage-reduction-programmes/pilot-fixtures.js';

const flags = process.argv.slice(2);
if (
  flags.some((flag) => !['--fixture', '--live'].includes(flag)) ||
  (flags.includes('--fixture') && flags.includes('--live'))
)
  throw new Error(
    'Usage: verify-damage-reduction-pilot.mjs [--fixture|--live]. Imported/simulated engineering recordkeeping only; no digital service is contacted.',
  );
const live = flags.includes('--live');
const mode = live ? 'live' : 'fixture';
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-reduction-pilot-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const frozenCases = JSON.parse(
  await readFile(
    new URL(
      '../docs/Testing/damage-reduction-pilot-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
let child;
let origin;
let programmeId;
const serverStartups = [];
const serverMemory = [];
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
      () => reject(new Error('Pilot verification server startup timed out.')),
      45_000,
    );
    active.on('message', (message) => {
      if (message.port) {
        clearTimeout(timer);
        serverStartups.push(performance.now() - started);
        ready(`http://127.0.0.1:${message.port}`);
      }
    });
    active.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    active.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Pilot verification server exited (${code}).`));
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
      reject(new Error('Pilot server memory telemetry timed out.'));
    }, 5000);
    active.on('message', listener);
    active.send({ type: 'reduction-capacity-metrics', request_id: requestId });
  });
  serverMemory.push(memory);
  assert.ok(
    memory.peak_rss_bytes <= 1_073_741_824,
    'Pilot API peak RSS exceeded the predeclared 1 GiB engineering envelope.',
  );
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const active = child;
  await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Pilot verification child did not exit.')),
      15_000,
    );
    active.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    active.kill('SIGTERM');
  });
}
async function raw(origin, path, body, key = randomUUID()) {
  const response = await fetch(
    origin + path,
    body === undefined
      ? { headers: { Connection: 'close' } }
      : {
          method: 'POST',
          headers: {
            Origin: origin,
            Connection: 'close',
            'Content-Type': 'application/json',
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
const path = (id) => `/api/reduction-programmes/${id}`;
const view = async (origin, id) =>
  reductionProgrammeViewSchema.parse(await read(origin, path(id)));
async function imported(origin, content, label) {
  const artifact = artifactSchema.parse(
    await read(origin, '/api/artifacts', {
      schema_version: 'haze.artifact.import.v3',
      filename: `${label}.json`,
      media_type: 'application/json',
      declared_origin:
        'Operator-supplied engineering example retained for imported/simulated recordkeeping. No delivery service contacted a recipient or changed a schedule.',
      content_base64: Buffer.from(JSON.stringify(content)).toString('base64'),
    }),
  );
  assert.equal(artifact.sha256, contractHash(artifact.content));
  return exactReductionRef(artifact);
}
async function settle(origin, id) {
  const deadline = Date.now() + 310_000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) {
      assert.equal(
        task.status,
        'completed',
        JSON.stringify({
          error: task.error,
          assignments: task.assignments.map(
            ({ definition_id, status, error, gaps }) => ({
              definition_id,
              status,
              error,
              gaps,
            }),
          ),
        }),
      );
      return task;
    }
    if (Date.now() > deadline)
      throw new Error(`Pilot task ${id} did not settle.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function taskCapture(origin, id) {
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
async function capture(origin, id) {
  const current = await view(origin, id);
  const tasks = [];
  for (const taskId of new Set(
    current.attempts.map(({ attempt }) => attempt.task_id),
  ))
    tasks.push(await taskCapture(origin, taskId));
  return {
    view: current,
    history: reductionProgrammeHistorySchema.parse(
      await read(origin, `${path(id)}/history`),
    ),
    tasks,
  };
}
const traces = [];
async function phase(origin, id, kind, dependency) {
  const current = await view(origin, id);
  const input = {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: current.programme.revision,
    phase: kind,
    ...(kind === 'planning'
      ? { assessment_attempt_id: dependency }
      : kind === 'pilot'
        ? { planning_attempt_id: dependency }
        : {}),
  };
  const key = randomUUID(),
    started = performance.now();
  const receipt = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, `${path(id)}/phases`, input, key),
  );
  assert.deepEqual(
    await read(origin, `${path(id)}/phases`, input, key),
    receipt,
  );
  const attempt = receipt.attempt;
  assert.ok(attempt);
  const task = await settle(origin, attempt.task_id);
  assert.equal(task.current_run_id, attempt.run_id);
  assert.equal(task.objective_revision, attempt.objective_revision);
  assert.ok(task.usage.model_calls <= task.limits.max_model_calls);
  assert.ok(task.usage.tool_calls <= task.limits.max_tool_calls);
  assert.ok(task.usage.artifacts <= task.limits.max_artifacts);
  const projected = (await view(origin, id)).attempts.find(
    (item) => item.attempt.id === attempt.id,
  );
  assert.equal(projected.currency, 'current');
  assert.equal(projected.result_status, 'available');
  const snapshot = await taskCapture(origin, task.id);
  await captureMemory();
  traces.push({
    phase: kind,
    attempt_id: attempt.id,
    task_id: task.id,
    run_id: attempt.run_id,
    objective_revision: attempt.objective_revision,
    programme_revision: attempt.programme_revision,
    latency_ms: performance.now() - started,
    usage: task.usage,
    reservation: attempt.reservation,
    limits: task.limits,
    artifact_bytes: Buffer.byteLength(JSON.stringify(snapshot.artifacts)),
    programme_snapshot_bytes: Buffer.byteLength(
      JSON.stringify((await view(origin, id)).programme),
    ),
    provider_receipts: (task.result?.provenance.receipts ?? []).filter(
      (receipt) => receipt.kind === 'model',
    ),
  });
  if (live) {
    const receipts = traces
      .at(-1)
      .provider_receipts.filter(
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
      );
    assert.ok(
      task.usage.model_calls > 0 && receipts.length > 0,
      `Configured live ${kind} requires actual charged model calls and accepted successful provider receipts.`,
    );
  }
  return attempt;
}
async function append(origin, id, record, key = randomUUID()) {
  const current = await view(origin, id);
  const input = {
    schema_version: 'haze.reduction.programme.record-request.v1',
    expected_revision: current.programme.revision,
    record,
  };
  const receipt = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, `${path(id)}/records`, input, key),
  );
  const next = await view(origin, id);
  const saved = next.records.find(
    (item) => item.programme_revision === receipt.revision,
  );
  assert.ok(saved);
  return { input, key, receipt, saved, view: next };
}
async function pilotDraft(origin, id, planning, input) {
  const inputRef = await imported(origin, input, 'pilot-scientific-inputs');
  const current = await view(origin, id);
  await read(origin, `${path(id)}/revisions`, {
    schema_version: 'haze.reduction.programme.revise.v1',
    expected_revision: current.programme.revision,
    reason:
      'Pin exact scientific feasibility/protocol inputs for an explicit bounded pilot phase.',
    pilot_input_ref: inputRef,
  });
  const attempt = await phase(origin, id, 'pilot', planning.id);
  const pilot = reductionPilotTaskViewSchema.parse(
    await read(origin, `/api/tasks/${attempt.task_id}/views/reduction-pilot`),
  );
  assert.equal(pilot.state, 'current', JSON.stringify(pilot.reasons));
  assert.ok(pilot.feasibility && pilot.protocol && pilot.review);
  assert.equal(pilot.review.value.verdict, 'supported');
  assert.equal(pilot.feasibility.value.classification, 'conditional');
  assert.equal(
    pilot.feasibility.value.classification_basis,
    'engineering_completeness_only',
  );
  assert.deepEqual(pilot.protocol.value.input_ref, inputRef);
  assert.equal(pilot.scientific_qualification, 'unqualified');
  assert.equal(pilot.achieved_reduction, false);
  return {
    attempt_id: attempt.id,
    feasibility: pilot.feasibility,
    protocol: pilot.protocol,
    review: pilot.review,
  };
}
function action(draft, registrationId, id) {
  const rule = draft.protocol.value.specification.digital_rule;
  assert.ok(rule);
  return {
    ...syntheticDigitalActionRecord(registrationId),
    action_id: id,
    occurred_at: new Date().toISOString(),
    rule: { id: rule.id, version: rule.version },
    action_kind: rule.kind,
    permitted_action: rule.permitted_actions[0],
    scope: structuredClone(rule.scope),
    trigger_refs: rule.trigger_inputs.flatMap((item) => item.evidence),
  };
}
async function receipt(origin, action, kind = 'synthetic') {
  const content = syntheticActionReceipt(action);
  content.origin = kind;
  if (action.status === 'failed') {
    content.status = 'failed';
    content.confirmation_level = 'none';
  }
  if (action.status === 'unknown') {
    content.status = 'unknown';
    content.confirmation_level = 'none';
  }
  if (kind === 'imported_service')
    content.raw_receipt_ref = await imported(
      origin,
      {
        action_id: action.action_id,
        action_version: action.action_version,
        status: content.status,
        statement:
          'Nonsynthetic imported-format example used only for deterministic record-state testing.',
      },
      'raw-service-receipt',
    );
  return {
    ...action,
    receipt_ref: await imported(origin, content, 'typed-service-receipt'),
  };
}
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'checked_at')
            .map(([key, item]) => [key, stable(item)]),
        )
      : value;
const fence = (task) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
let report = {
  passed: false,
  mode,
  evidence_origin: 'synthetic',
  scientific_qualification: 'unqualified',
  achieved_reduction: false,
  configured_live_model_behavior: 'not_tested',
  traces,
  server_startups_ms: serverStartups,
  server_memory: serverMemory,
};
try {
  origin = await boot();
  const source = await imported(
    origin,
    syntheticResidualImport(),
    'physical-residuals',
  );
  const preview = {
    schema_version: 'haze.reduction.preview-request.v1',
    selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]),
    candidate: syntheticReductionCandidate(),
  };
  const created = reductionProgrammeMutationReceiptSchema.parse(
    await read(origin, '/api/reduction-programmes', {
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title: 'Synthetic imported/simulated pilot recordkeeping verification',
      accountable_owner: 'Fixture local operator',
      scientific_owner: null,
      preview,
    }),
  );
  const id = created.programme_id;
  programmeId = id;
  const assessment = await phase(origin, id, 'assessment');
  const planning = await phase(origin, id, 'planning', assessment.id);
  const supplied = await imported(
    origin,
    {
      schema_version: 'haze.reduction.pilot-engineering-input.v1',
      origin: 'supplied',
      statement:
        'Operator-supplied design/approval engineering example, independently valid science is not established.',
    },
    'design-and-rule-evidence',
  );
  const input = suppliedCompletePilotInput(supplied);
  input.origin = 'synthetic';
  input.design_review.reviewed_at = new Date().toISOString();
  input.protocol_spec.digital_rule.approval.approved_at =
    new Date().toISOString();
  input.protocol_spec.digital_rule.scope.period = {
    start: '2026-01-01',
    end: '2027-12-31',
  };
  const first = await pilotDraft(origin, id, planning, input);
  const registered = await append(
    origin,
    id,
    pilotRegistrationRecordSchema.parse(syntheticPilotRegistration(first)),
    'register-original',
  );
  assert.deepEqual(
    await read(origin, `${path(id)}/records`, registered.input, registered.key),
    registered.receipt,
  );
  const registrationView = registered.view.pilot.registrations.find(
    (item) => item.record_id === registered.saved.id,
  );
  assert.equal(registrationView.timing, 'attested_before_outcomes');
  assert.ok(
    Date.parse(registrationView.recorded_at) >=
      Date.parse(registered.saved.created_at),
  );
  const beforeRecords = await view(origin, id);
  const unknownBody = {
    ...action(first, registered.saved.id, 'imported-unknown-action'),
    mode: 'imported_live',
    status: 'unknown',
  };
  const unknown = await append(origin, id, unknownBody);
  assert.equal(
    unknown.view.pilot.actions.find(
      (item) => item.record_id === unknown.saved.id,
    ).effective_status,
    'unknown',
  );
  const reconciledBody = await receipt(
    origin,
    {
      ...unknownBody,
      status: 'confirmed',
      reconciles_record_id: unknown.saved.id,
    },
    'imported_service',
  );
  const reconciled = await append(origin, id, reconciledBody);
  assert.equal(
    reconciled.view.pilot.actions.find(
      (item) => item.record_id === reconciled.saved.id,
    ).effective_status,
    'confirmed',
  );
  const simulationBody = await receipt(origin, {
    ...action(first, registered.saved.id, 'simulated-action'),
    status: 'confirmed',
  });
  const simulation = await append(origin, id, simulationBody);
  assert.equal(
    simulation.view.pilot.actions.find(
      (item) => item.record_id === simulation.saved.id,
    ).effective_status,
    'simulated',
  );
  assert.equal(
    simulation.view.pilot.actions.find(
      (item) => item.record_id === simulation.saved.id,
    ).recorded_delivery,
    false,
  );
  const human = await append(
    origin,
    id,
    await receipt(
      origin,
      {
        ...action(first, registered.saved.id, 'human-report-action'),
        mode: 'imported_live',
        status: 'unknown',
      },
      'human_report',
    ),
  );
  assert.equal(
    human.view.pilot.actions.find((item) => item.record_id === human.saved.id)
      .recorded_delivery,
    false,
  );
  const verificationRef = await imported(
    origin,
    {
      schema_version: 'haze.reduction.delivery-verification.v1',
      origin: 'supplied',
      verifier: {
        name: 'Independent fixture reviewer',
        role: 'Engineering verifier',
        independent: true,
        conflicts: 'none_declared',
        attested_at: new Date().toISOString(),
      },
      actions: [
        {
          record_id: reconciled.saved.id,
          action_id: reconciledBody.action_id,
          action_version: reconciledBody.action_version,
          permitted_action: reconciledBody.permitted_action,
          trigger_refs: reconciledBody.trigger_refs,
          rule: reconciledBody.rule,
          scope: reconciledBody.scope,
          verdict: 'verified',
          confirmation_level: 'alert_transmitted',
          evidence: [reconciledBody.receipt_ref],
        },
      ],
      limitations: [
        'Only the exact imported receipt example is covered; no recipient effects or damage reduction were measured.',
      ],
    },
    'partial-delivery-verification',
  );
  const verified = await append(origin, id, {
    kind: 'delivery_verification',
    registration_id: registered.saved.id,
    action_record_ids: [reconciled.saved.id, simulation.saved.id],
    verification_ref: verificationRef,
  });
  assert.equal(
    verified.view.pilot.verifications.find(
      (item) => item.record_id === verified.saved.id,
    ).status,
    'partial',
  );
  const deviation = await append(origin, id, {
    kind: 'pilot_deviation',
    registration_id: registered.saved.id,
    action_record_ids: [simulation.saved.id],
    category: 'engineering-delivery-gap',
    description: 'Synthetic recipient event is not live service delivery.',
    material: true,
    status: 'open',
    occurred_at: new Date().toISOString(),
    evidence: [simulationBody.receipt_ref],
    resolves_deviation_id: null,
  });
  assert.ok(
    deviation.view.pilot.deviations.find(
      (item) => item.record_id === deviation.saved.id,
    ).unresolved,
  );
  assert.equal(deviation.view.attempts.length, beforeRecords.attempts.length);
  assert.equal(
    deviation.view.capacity.charged_tool_calls,
    beforeRecords.capacity.charged_tool_calls,
  );
  const amendedInput = structuredClone(input);
  amendedInput.protocol_spec.version = '2';
  amendedInput.protocol_spec.analysis_method.description =
    'Outcome-aware revised engineering analysis; keep the original registered criterion and method.';
  const amended = await pilotDraft(origin, id, planning, amendedInput);
  const amendment = await append(origin, id, {
    kind: 'pilot_amendment',
    registration_id: registered.saved.id,
    amended_protocol_ref: amended.protocol.artifact,
    review_ref: amended.review.artifact,
    reason:
      'Retain an explicit outcome-aware revised protocol alongside the original.',
    affected_fields: ['analysis'],
    outcomes_available: 'yes',
    attested_by: 'Fixture local operator',
    attested_at: new Date().toISOString(),
  });
  assert.equal(
    amendment.view.pilot.amendments.find(
      (item) => item.record_id === amendment.saved.id,
    ).status,
    'exploratory',
  );
  assert.deepEqual(
    amendment.view.records.find((item) => item.id === registered.saved.id),
    registered.saved,
  );
  assert.deepEqual(
    await read(origin, `${path(id)}/records`, registered.input, registered.key),
    registered.receipt,
  );
  const originalProtocol = await read(
    origin,
    `/api/artifacts/${first.protocol.artifact.id}`,
  );
  assert.equal(originalProtocol.sha256, first.protocol.artifact.sha256);
  const final = await view(origin, id);
  assert.equal(final.attempts.length, 4);
  assert.equal(final.capacity.remaining_attempts.pilot, 1);
  assert.equal(final.capacity.remaining_runs, 8);
  assert.equal(final.capacity.reserved_tool_calls, 0);
  assert.equal(
    final.capacity.charged_tool_calls,
    traces.reduce((sum, item) => sum + item.usage.tool_calls, 0),
  );
  assert.equal(final.pilot.live_delivery, 'deferred');
  assert.equal(final.pilot.scientific_qualification, 'unqualified');
  assert.equal(final.pilot.achieved_reduction, false);
  const before = await capture(origin, id);
  await stop();
  origin = await boot();
  await captureMemory();
  const after = await capture(origin, id);
  assert.deepEqual(stable(after), stable(before));
  const lastPilot = await read(origin, `/api/tasks/${traces.at(-1).task_id}`);
  const denied = await raw(origin, `/api/tasks/${lastPilot.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(lastPilot),
    action: 'continue',
  });
  assert.ok([403, 409].includes(denied.status));
  const requiredTool = lastPilot.assignments
    .find((item) => item.role === 'WorkerShield')
    .tools.find((tool) => tool.includes('pilot'));
  assert.ok(requiredTool);
  await read(origin, `/api/tasks/${lastPilot.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(lastPilot),
    action: 'revoke',
    revoked_tools: [requiredTool],
    reason: 'Local operator withdraws required pilot draft tool access.',
  });
  const revoked = await view(origin, id);
  assert.equal(
    revoked.pilot.registrations.find(
      (item) => item.record_id === registered.saved.id,
    ).currency,
    'stale',
  );
  assert.deepEqual(revoked.records, before.view.records);
  const qualified = JSON.stringify(revoked.pilot);
  assert.ok(!qualified.includes('"scientific_qualification":"qualified"'));
  report = {
    ...report,
    checked_at: new Date().toISOString(),
    passed: true,
    mode,
    frozen_cases_sha256: contractHash(frozenCases),
    programme_id: id,
    explicit_runs: 4,
    restart: true,
    exact_source_inspection: true,
    idempotent_registration: true,
    unknown_reconciliation_retained: true,
    original_protocol_immutable: true,
    outcome_aware_amendment: 'exploratory',
    partial_delivery_verification: true,
    material_deviation_retained: true,
    records_do_not_dispatch: true,
    required_access_revocation_withholds_current_support: true,
    live_delivery: 'deferred',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
    configured_live_model_behavior: live
      ? 'verified_admitted_trace'
      : 'not_tested',
    interpretation: `${live ? 'Configured live model workflow over synthetic' : 'Deterministic'} imported/simulated engineering recordkeeping examples. No digital action was sent; no exposure or physical-damage effect was measured and no scientific qualification was established.`,
    traces,
    before_restart: before,
    after_restart: after,
    revoked_view: revoked,
  };
  const reportPath = resolve(root, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        passed: true,
        programme_id: id,
        explicit_runs: 4,
        restart: true,
        records: after.view.records.length,
        capacity: after.view.capacity,
        traces,
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.error =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : String(error);
  if (origin && programmeId) {
    try {
      report.failure_capture = await capture(origin, programmeId);
    } catch (captureError) {
      report.capture_error = captureError.message;
    }
  }
  await writeFile(
    resolve(root, 'failure.json'),
    `${JSON.stringify({ checked_at: new Date().toISOString(), passed: false, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), traces }, null, 2)}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    await stop();
  } catch (error) {
    report.passed = false;
    report.shutdown_error = error.message;
    process.exitCode = 1;
  }
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
      if (live && !report.passed && report.model_attempts.length)
        report.configured_live_model_behavior = 'attempted_unsuccessful_trace';
    } finally {
      database.close();
    }
  } catch (error) {
    report.telemetry_error = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  report.checked_at = new Date().toISOString();
  await writeFile(
    resolve(root, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        report: resolve(root, 'report.json'),
        passed: report.passed,
        mode,
        runs: traces.length,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
if (!report?.passed) process.exitCode = 2;
