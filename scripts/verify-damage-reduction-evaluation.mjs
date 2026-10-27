import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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

if (process.argv.slice(2).some((flag) => flag !== '--fixture'))
  throw new Error(
    'Usage: verify-damage-reduction-evaluation.mjs [--fixture]. Imported/simulated engineering recordkeeping only.',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-reduction-evaluation-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const frozenCases = JSON.parse(
  await readFile(
    new URL(
      '../docs/Testing/damage-reduction-evaluation-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
import { evaluationTaskViewSchema } from '../dist/contracts/damage-reduction-evaluation.js';
import {
  syntheticExternalEvaluationInput,
  syntheticEvaluationExpectedOutput,
  syntheticQualificationDossier,
} from '../dist/capabilities/damage-reduction-programmes/evaluation-fixtures.js';
let child;
async function boot() {
  child = fork(new URL('./serve-tasks.mjs', import.meta.url), ['--fixture'], {
    env: {
      ...process.env,
      STATE_DIR: root,
      HAZE_TASK_STATE_DIR: root,
      HAZE_TASK_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const active = child;
  return new Promise((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Pilot verification server startup timed out.')),
      45_000,
    );
    active.on('message', (message) => {
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
      reject(new Error(`Pilot verification server exited (${code}).`));
    });
  });
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
        'Operator-supplied engineering example retained for imported/simulated recordkeeping. No digital service was contacted.',
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
        : kind === 'evaluation'
          ? { registration_id: dependency }
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
  assert.ok(['available', 'gap'].includes(projected.result_status));
  const snapshot = await taskCapture(origin, task.id);
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
  });
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
async function receipt(origin, action, kind = 'synthetic', rawOriginal = null) {
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
  if (rawOriginal) content.raw_receipt_ref = rawOriginal;
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

async function evaluationInput(
  origin,
  id,
  preview,
  draft,
  registrationId,
  actionRecord,
  intervention = '880',
) {
  const reportRef = await imported(
    origin,
    {
      origin: 'synthetic',
      statement:
        'Original invented external comparative evaluation report. No actual service effect was measured.',
    },
    'external-evaluation-report',
  );
  const dataRef = await imported(
    origin,
    { origin: 'synthetic', baseline: '1000', intervention },
    'external-evaluation-data',
  );
  const reviewRef = await imported(
    origin,
    {
      origin: 'synthetic',
      statement:
        'Independent external scientific review engineering example; credentials are not authenticated.',
    },
    'external-scientific-review',
  );
  const specification = draft.protocol.value.specification;
  const input = syntheticExternalEvaluationInput({
    programme_id: id,
    target_sha256: contractHash(preview.selection.target),
    scope_sha256: contractHash(preview.selection.target.scope),
    scope: preview.selection.target.scope,
    registration_id: registrationId,
    protocol_ref: draft.protocol.artifact,
    action_record_ids: [actionRecord.saved.id],
    rules: [actionRecord.saved.record.rule],
    report_ref: reportRef,
    data_ref: dataRef,
    review_ref: reviewRef,
    expected_output_ref: reportRef,
    source_method: {
      id: specification.analysis_method.id,
      version: specification.analysis_method.version,
    },
    registered_design_name: specification.design_name,
  });
  input.comparative_estimates.intervention = intervention;
  const expected = syntheticEvaluationExpectedOutput(input);
  if (intervention === '950') {
    expected.intervention_damage = '950';
    expected.absolute_reduction = '50';
    expected.relative_reduction = { numerator: '50', denominator: '1000' };
    expected.target_met = false;
  }
  input.expected_output_refs = [
    await imported(
      origin,
      expected,
      'independently-expected-evaluation-output',
    ),
  ];
  const inputRef = await imported(origin, input, 'external-evaluation-input');
  const dossier = syntheticQualificationDossier(input, inputRef),
    dossierRef = await imported(
      origin,
      dossier,
      'scientific-qualification-dossier',
    );
  const current = await view(origin, id);
  await read(origin, `${path(id)}/revisions`, {
    schema_version: 'haze.reduction.programme.revise.v1',
    expected_revision: current.programme.revision,
    reason:
      'Pin exact original external evaluation, expected outputs and separate qualification dossier.',
    evaluation_input_ref: inputRef,
    evaluation_dossier_ref: dossierRef,
  });
  return {
    input,
    inputRef,
    dossier,
    dossierRef,
    reportRef,
    dataRef,
    reviewRef,
  };
}
let report;
try {
  let origin = await boot();
  const source = await imported(
    origin,
    syntheticResidualImport(),
    'physical-scenario-original',
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
      title: 'Synthetic reviewed external-evaluation lifecycle',
      accountable_owner: 'Fixture operator',
      scientific_owner: null,
      preview,
    }),
  );
  const id = created.programme_id;
  const assessment = await phase(origin, id, 'assessment');
  const planning = await phase(origin, id, 'planning', assessment.id);
  const scientificProof = await imported(
    origin,
    {
      origin: 'synthetic',
      statement:
        'Invented feasibility, design and digital-rule approval evidence.',
    },
    'pilot-design-proof',
  );
  const pilotInput = suppliedCompletePilotInput(scientificProof);
  pilotInput.origin = 'synthetic';
  pilotInput.design_review.reviewed_at = new Date().toISOString();
  pilotInput.protocol_spec.digital_rule.approval.approved_at =
    new Date().toISOString();
  pilotInput.protocol_spec.digital_rule.scope.period = {
    start: '2026-01-01',
    end: '2027-12-31',
  };
  const draft = await pilotDraft(origin, id, planning, pilotInput);
  const registered = await append(
    origin,
    id,
    pilotRegistrationRecordSchema.parse(syntheticPilotRegistration(draft)),
    'register-evaluated-protocol',
  );
  const rawOriginal = await imported(
    origin,
    {
      origin: 'synthetic',
      statement: 'Exact original raw simulated delivery receipt.',
    },
    'synthetic-raw-delivery',
  );
  const simulatedBody = await receipt(
    origin,
    {
      ...action(draft, registered.saved.id, 'synthetic-evaluated-action'),
      status: 'confirmed',
    },
    'synthetic',
    rawOriginal,
  );
  const simulated = await append(origin, id, simulatedBody);
  assert.equal(
    simulated.view.pilot.actions.find(
      (item) => item.record_id === simulated.saved.id,
    ).effective_status,
    'simulated',
  );
  assert.equal(
    simulated.view.pilot.actions.find(
      (item) => item.record_id === simulated.saved.id,
    ).recorded_delivery,
    false,
  );
  const originals = await evaluationInput(
    origin,
    id,
    preview,
    draft,
    registered.saved.id,
    simulated,
  );
  const first = await phase(origin, id, 'evaluation', registered.saved.id);
  assert.ok(
    (
      await read(origin, `/api/tasks/${first.task_id}`)
    ).original_request.context_refs.some(
      (ref) =>
        ref.id === rawOriginal.id &&
        ref.version === rawOriginal.version &&
        ref.sha256 === rawOriginal.sha256,
    ),
    'Evaluation admission must pin exact embedded raw receipt evidence.',
  );
  const evaluated = evaluationTaskViewSchema.parse(
    await read(
      origin,
      `/api/tasks/${first.task_id}/views/reduction-evaluation`,
    ),
  );
  assert.ok(evaluated.result && evaluated.learning && evaluated.review);
  assert.equal(
    evaluated.result.value.status,
    'gap',
    'Simulated delivery cannot become an actual-programme effect evaluation.',
  );
  assert.equal(evaluated.result.value.absolute_reduction, '120');
  assert.deepEqual(evaluated.result.value.relative_reduction, {
    numerator: '120',
    denominator: '1000',
  });
  assert.equal(evaluated.result.value.target_met, true);
  assert.equal(evaluated.review.value.verdict, 'supported');
  assert.equal(evaluated.learning.value.outcome, 'insufficient_evidence');
  assert.equal(evaluated.learning.value.publication, 'not_published');
  const adopted = await append(
    origin,
    id,
    {
      kind: 'evaluation_qualification',
      decision: 'conditional',
      result_ref: evaluated.result.artifact,
      technical_review_ref: evaluated.review.artifact,
      dossier_ref: originals.dossierRef,
      adopted_by: 'Explicit fixture operator attestation',
      attested_at: new Date().toISOString(),
      reason:
        'Synthetic engineering adoption only; no actual programme effect or scientific qualification is established.',
      supersedes_record_id: null,
    },
    'adopt-conditional-evaluation',
  );
  assert.equal(adopted.view.evaluation.claim.eligible, false);
  const withdrawn = await append(origin, id, {
    ...adopted.saved.record,
    decision: 'withdrawn',
    reason:
      'Operator withdraws the retained conditional scientific attestation.',
    supersedes_record_id: adopted.saved.id,
  });
  assert.equal(withdrawn.view.evaluation.qualification.status, 'withdrawn');
  assert.deepEqual(
    await read(origin, `${path(id)}/records`, adopted.input, adopted.key),
    adopted.receipt,
  );
  const replacementOriginals = await evaluationInput(
    origin,
    id,
    preview,
    draft,
    registered.saved.id,
    simulated,
    '950',
  );
  const replacement = await phase(
    origin,
    id,
    'evaluation',
    registered.saved.id,
  );
  const latest = evaluationTaskViewSchema.parse(
    await read(
      origin,
      `/api/tasks/${replacement.task_id}/views/reduction-evaluation`,
    ),
  );
  assert.equal(latest.result.value.target_met, false);
  assert.equal(latest.result.value.absolute_reduction, '50');
  assert.equal(latest.result.value.status, 'gap');
  assert.equal(latest.review.value.verdict, 'supported');
  assert.equal(latest.learning.value.outcome, 'insufficient_evidence');
  assert.notEqual(latest.result.artifact.id, evaluated.result.artifact.id);
  const objection = await append(origin, id, {
    kind: 'evaluation_objection',
    result_ref: latest.result.artifact,
    severity: 'material',
    status: 'open',
    description:
      'Synthetic receipt history supplies no actual intervention delivery or scientific reference trace.',
    evidence: [replacementOriginals.reportRef],
    resolves_record_id: null,
  });
  assert.equal(objection.view.evaluation.claim.eligible, false);
  assert.equal(
    objection.view.evaluation.operational_release,
    'gated_pending_non_synthetic_trace',
  );
  assert.equal(objection.view.evaluation.achieved_reduction, false);
  const originalResult = await read(
    origin,
    `/api/artifacts/${evaluated.result.artifact.id}`,
  );
  assert.equal(originalResult.sha256, evaluated.result.artifact.sha256);
  assert.deepEqual(originalResult.content, evaluated.result.value);
  assert.deepEqual(
    await read(origin, `${path(id)}/records`, adopted.input, adopted.key),
    adopted.receipt,
  );
  const before = await capture(origin, id);
  assert.equal(before.view.attempts.length, 5);
  assert.equal(before.view.capacity.remaining_runs, 7);
  assert.equal(before.view.capacity.remaining_attempts.evaluation, 1);
  assert.equal(before.view.capacity.reserved_tool_calls, 0);
  assert.equal(
    before.view.capacity.charged_tool_calls,
    traces.reduce((sum, item) => sum + item.usage.tool_calls, 0),
  );
  await stop();
  origin = await boot();
  const after = await capture(origin, id);
  assert.deepEqual(stable(after), stable(before));
  const originalRefs = [
    ...new Map(
      [
        source,
        rawOriginal,
        originals.inputRef,
        originals.dossierRef,
        originals.reportRef,
        originals.dataRef,
        originals.reviewRef,
        ...originals.input.expected_output_refs,
        replacementOriginals.inputRef,
        replacementOriginals.dossierRef,
        replacementOriginals.reportRef,
        replacementOriginals.dataRef,
        replacementOriginals.reviewRef,
        ...replacementOriginals.input.expected_output_refs,
      ].map((ref) => [`${ref.id}:${ref.version}:${ref.sha256}`, ref]),
    ).values(),
  ];
  const retainedOriginals = [];
  for (const reference of originalRefs) {
    const original = await read(origin, `/api/artifacts/${reference.id}`);
    assert.equal(original.version, reference.version);
    assert.equal(original.sha256, reference.sha256);
    assert.equal(contractHash(original.content), reference.sha256);
    retainedOriginals.push(original);
  }
  const task = await read(origin, `/api/tasks/${replacement.task_id}`);
  const bypass = await raw(origin, `/api/tasks/${task.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(task),
    action: 'continue',
  });
  assert.ok([403, 409].includes(bypass.status));
  const tool = task.assignments.find((item) => item.role === 'DamageAccountant')
    .tools[0];
  assert.ok(tool);
  await read(origin, `/api/tasks/${task.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(task),
    action: 'revoke',
    revoked_tools: [tool],
    reason: 'Operator withdraws required external-evaluation method access.',
  });
  const revoked = await view(origin, id);
  assert.equal(revoked.evaluation.claim.eligible, false);
  const revokedTaskView = evaluationTaskViewSchema.parse(
    await read(
      origin,
      `/api/tasks/${replacement.task_id}/views/reduction-evaluation`,
    ),
  );
  assert.ok(
    !['current', 'evidence_gap'].includes(revokedTaskView.state),
    'Revoking the registered evaluation method must withhold current technical support.',
  );
  assert.deepEqual(revoked.records, before.view.records);
  const totals = traces.reduce(
    (total, item) => ({
      model_calls: total.model_calls + item.usage.model_calls,
      tool_calls: total.tool_calls + item.usage.tool_calls,
      artifacts: total.artifacts + item.usage.artifacts,
      assignments: total.assignments + item.usage.assignments,
    }),
    { model_calls: 0, tool_calls: 0, artifacts: 0, assignments: 0 },
  );
  report = {
    checked_at: new Date().toISOString(),
    passed: true,
    mode: 'fixture',
    frozen_cases_sha256: contractHash(frozenCases),
    programme_id: id,
    explicit_runs: 5,
    restart: true,
    original_imports_retained: true,
    duplicate_phase_receipts: true,
    qualification_human_attestation: true,
    withdrawal_history: true,
    historical_record_replay: true,
    independent_review: true,
    learning_artifact_retained: true,
    world_model_publication: 'not_performed',
    actual_delivery: 'not_supplied_simulated_only',
    operational_release: 'gated_pending_non_synthetic_trace',
    achieved_reduction: false,
    configured_live_model_behavior: 'not_tested',
    interpretation:
      'Engineering fixture only. Exact imported arithmetic is reproduced; simulated delivery leaves an honest evaluation gap. No reviewed non-synthetic reference case, actual programme effect or operational release is claimed.',
    totals,
    traces,
    before_restart: before,
    after_restart: after,
    retained_originals_after_restart: retainedOriginals,
    revoked_view: revoked,
    revoked_task_view: revokedTaskView,
  };
  const reportPath = resolve(root, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        passed: true,
        programme_id: id,
        explicit_runs: 5,
        restart: true,
        records: after.view.records.length,
        totals,
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
    `${JSON.stringify({ checked_at: new Date().toISOString(), passed: false, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), traces }, null, 2)}\n`,
  );
  throw error;
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
