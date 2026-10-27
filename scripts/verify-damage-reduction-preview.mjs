import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { contractHash } from '../dist/contracts/json.js';
import { reductionInputSelectionSchema } from '../dist/contracts/damage-reduction.js';
import {
  conditionalReductionPlanSchema,
  conditionalPlanReviewSchema,
} from '../dist/contracts/damage-reduction-plan.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../dist/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../dist/capabilities/damage-reduction-planning/methods.js';
import { independentlyCheckReduction } from '../dist/capabilities/damage-reduction-planning/checker.js';
import { draftConditionalPlan } from '../dist/capabilities/damage-reduction-planning/planning.js';
import { independentlyCheckConditionalPlan } from '../dist/capabilities/damage-reduction-planning/planning-checker.js';
import {
  syntheticReductionCandidate,
  FROZEN_PLANNING_CASES,
} from '../dist/capabilities/damage-reduction-planning/planning-fixtures.js';

if (process.argv.slice(2).some((flag) => flag !== '--fixture'))
  throw new Error(
    'Usage: verify-damage-reduction-preview.mjs [--fixture]. Synthetic engineering verification only.',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-reduction-preview-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const frozenCases = JSON.parse(
  await readFile(
    new URL(
      '../docs/Testing/damage-reduction-preview-cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
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
  return new Promise((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Preview verification server startup timed out.')),
      45_000,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      ready(`http://127.0.0.1:${message.port}`);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Preview verification server exited (${code}).`));
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const active = child;
  await new Promise((done) => {
    active.once('exit', done);
    active.kill('SIGTERM');
  });
}
async function read(origin, path, body, key = randomUUID()) {
  const response = await fetch(
    `${origin}${path}`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status} ${path}: ${JSON.stringify(result)}`,
    );
  return result;
}
async function settle(origin, id) {
  const deadline = Date.now() + 310_000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > deadline)
      throw new Error(`Preview task ${id} failed to settle.`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function capture(origin, task) {
  const artifacts = [];
  for (const { artifact: ref } of task.artifacts) {
    const artifact = await read(origin, `/api/artifacts/${ref.id}`);
    assert.equal(artifact.version, ref.version);
    assert.equal(artifact.sha256, ref.sha256);
    artifacts.push(artifact);
  }
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await read(
      origin,
      `/api/tasks/${task.id}/events?after=${cursor}`,
    );
    events.push(...page.events);
    if (page.next_cursor === cursor || page.events.length < 100) break;
    cursor = page.next_cursor;
  }
  return { task, artifacts, events };
}
const previewPath = (id) => `/api/tasks/${id}/views/reduction-preview`;
const fence = (task) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
const stableProjection = (preview) => {
  const result = structuredClone(preview);
  if (result.claims) delete result.claims.checked_at;
  return result;
};
function baselineArtifact(kind, content, assignmentId, dependencies = []) {
  return {
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'local-user', workspace: 'local-workspace' },
    kind,
    producer: { kind: 'assignment', id: assignmentId },
    assignment_id: assignmentId,
    assignment_revision: 1,
    created_at: new Date().toISOString(),
    dependencies,
    required_tools: [],
    content,
  };
}
/** Same kernels and originals in one sequence; excludes runtime authorization/persistence and model judgment. */
function singleSequenceBaseline(request, sources) {
  const started = performance.now();
  const selector = randomUUID(),
    producer = randomUUID(),
    critic = randomUUID(),
    planner = randomUUID(),
    planCritic = randomUUID();
  const selection = baselineArtifact(
    'reduction.input-selection',
    reductionInputSelectionSchema.parse(request.scope.selection),
    selector,
    request.scope.selection.sources.map(({ artifact }) => artifact),
  );
  const assessment = baselineArtifact(
    'reduction.assessment',
    assessReduction(
      request.scope.selection,
      sources,
      exactReductionRef(selection),
    ),
    producer,
    [exactReductionRef(selection)],
  );
  const arithmeticReview = baselineArtifact(
    'reduction.review',
    independentlyCheckReduction(
      request.scope.selection,
      sources,
      exactReductionRef(selection),
      assessment.content,
      exactReductionRef(assessment),
      { assignment_id: critic, revision: 1 },
      producer,
    ),
    critic,
    [exactReductionRef(selection), exactReductionRef(assessment)],
  );
  const input = {
    request: request.scope,
    selection,
    assessment,
    arithmeticReview,
    sources,
  };
  const plan = baselineArtifact(
    'reduction.conditional-plan',
    draftConditionalPlan(input),
    planner,
    [
      exactReductionRef(selection),
      exactReductionRef(assessment),
      exactReductionRef(arithmeticReview),
    ],
  );
  const review = independentlyCheckConditionalPlan({
    ...input,
    plan,
    reviewer: { assignment_id: planCritic, revision: 1 },
  });
  return {
    label: 'single-sequence deterministic computational baseline',
    latency_ms: performance.now() - started,
    logical_method_operations: 5,
    model_calls: 0,
    remote_provider_cost: null,
    state: plan.content.state,
    point_estimate_label: plan.content.point_estimate_label,
    independent_review: review.verdict,
    prerequisite_count: plan.content.prerequisites.length,
    objection_count: plan.content.objections.length,
    limitations: [
      'Same deterministic kernels and original evidence; no model prompts or live reasoning.',
      'Synthetic reviewer identities preserve checker independence checks, but this sequence is not a governed saved task.',
      'Excludes task admission, persistence, scheduling, access/grant wrappers and UI; timing compares local execution overhead only.',
      'Local CPU cost is not priced. A live single-agent versus coordinated-agent usefulness/cost evaluation remains outstanding.',
    ],
  };
}
function candidateFor(caseId) {
  const candidate = syntheticReductionCandidate();
  if (caseId === 'hard_subgroup_violation')
    candidate.constraints = [
      {
        id: 'subgroup-protection',
        description:
          'The proposed schedule violates the declared protected subgroup rest rule.',
        hard: true,
        status: 'violated',
        evidence: [],
      },
    ];
  if (caseId === 'unsupported_effect_claim')
    candidate.claims = [
      {
        id: 'unjustified-spec-effect',
        kind: 'effect_estimate',
        statement:
          'A product specification proves the proposed service achieves damage reduction.',
        evidence: [],
      },
    ];
  return candidate;
}

let report;
try {
  let origin = await boot();
  const cases = [];
  for (const frozen of FROZEN_PLANNING_CASES) {
    const sourceInput = syntheticResidualImport(
      frozen.supplied_baseline,
      frozen.supplied_intervention,
    );
    const imported = await read(origin, '/api/artifacts', {
      schema_version: 'haze.artifact.import.v3',
      filename: `${frozen.id}-physical-residuals.json`,
      media_type: 'application/json',
      declared_origin:
        'Explicit synthetic preview engineering fixture; invented quantities and proposed service.',
      content_base64: Buffer.from(JSON.stringify(sourceInput)).toString(
        'base64',
      ),
    });
    const source = exactReductionRef(imported.artifact ?? imported);
    const original = await read(origin, `/api/artifacts/${source.id}`);
    assert.deepEqual(original.content, sourceInput);
    const request = {
      schema_version: 'haze.task.request.v3',
      objective:
        'Prepare a conditional damage-reduction planning preview for the proposed digital alert service. Retain the physical target, sources, scientific prerequisites and independent arithmetic and plan reviews.',
      scope: {
        schema_version: 'haze.reduction.preview-request.v1',
        selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
          { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
        ]),
        candidate: candidateFor(frozen.id),
      },
      context_refs: [source],
    };
    const started = performance.now();
    const key = randomUUID();
    const admission = await read(origin, '/api/tasks', request, key);
    assert.equal(
      (await read(origin, '/api/tasks', request, key)).task_id,
      admission.task_id,
    );
    const captureResult = await capture(
      origin,
      await settle(origin, admission.task_id),
    );
    const latency = performance.now() - started;
    assert.equal(captureResult.task.status, 'completed');
    const preview = await read(origin, previewPath(admission.task_id));
    if (frozen.id === 'supported') {
      assert.equal(
        (
          await fetch(
            `${origin}/api/tasks/${admission.task_id}/views/unregistered-view`,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(`${origin}${previewPath(admission.task_id)}`, {
            method: 'POST',
            headers: { Origin: origin },
          })
        ).status,
        405,
      );
      assert.equal(
        (
          await fetch(
            `${origin}${previewPath(admission.task_id)}?unexpected=true`,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${origin}${previewPath(admission.task_id)}`, {
            headers: { Origin: 'https://untrusted.example' },
          })
        ).status,
        403,
      );
    }
    assert.equal(preview.state, 'current');
    assert.equal(
      preview.claims.point_estimate_label,
      frozen.expected_point_estimate_label,
    );
    assert.equal(preview.arithmetic_review.value.verdict, 'supported');
    const plan = conditionalReductionPlanSchema.parse(preview.plan.value);
    const review = conditionalPlanReviewSchema.parse(preview.plan_review.value);
    assert.equal(plan.state, frozen.expected_state);
    assert.equal(review.verdict, 'supported');
    assert.equal(
      plan.point_estimate_label,
      frozen.expected_point_estimate_label,
    );
    assert.equal(plan.scientific_qualification, 'unqualified');
    assert.equal(plan.delivery_status, 'not_delivered');
    assert.equal(plan.achieved_reduction, false);
    assert.ok(plan.prerequisites.length > 0);
    assert.ok(
      plan.recommendations.every(
        (recommendation) =>
          recommendation.evidence.length > 0 ||
          recommendation.prerequisite_ids.length > 0,
      ),
    );
    assert.deepEqual(
      [
        ...new Set(
          captureResult.task.assignments
            .filter(({ role }) => role !== 'Manager')
            .map(({ role }) => role),
        ),
      ].sort(),
      ['DamageAccountant', 'EvidenceCritic', 'HazeOps', 'WorkerShield'],
    );
    assert.equal(captureResult.task.limits.max_tool_calls, 40);
    assert.ok(
      captureResult.task.usage.tool_calls <= 40 &&
        captureResult.task.usage.artifacts <= 64 &&
        captureResult.task.usage.assignments <= 16,
    );
    const baseline = singleSequenceBaseline(request, [original]);
    assert.equal(baseline.state, plan.state);
    assert.equal(baseline.point_estimate_label, plan.point_estimate_label);
    assert.equal(baseline.independent_review, 'supported');
    const trace = {
      latency_ms: latency,
      usage: captureResult.task.usage,
      limits: captureResult.task.limits,
      input_bytes: Buffer.byteLength(JSON.stringify(request)),
      original_source_bytes: Buffer.byteLength(
        JSON.stringify(original.content),
      ),
      artifact_bytes: Buffer.byteLength(
        JSON.stringify(captureResult.artifacts),
      ),
      plan_bytes: Buffer.byteLength(JSON.stringify(plan)),
      plan_review_bytes: Buffer.byteLength(JSON.stringify(review)),
      maximum_artifact_dependency_refs: Math.max(
        ...captureResult.artifacts.map(
          ({ dependencies }) => dependencies.length,
        ),
      ),
      plan_prerequisites: plan.prerequisites.length,
      plan_objections: plan.objections.length,
      remote_provider_cost: null,
    };
    cases.push({
      frozen,
      request,
      source,
      preview,
      trace,
      single_sequence_baseline: baseline,
      ...captureResult,
    });
  }
  await stop();
  origin = await boot();
  for (const before of cases) {
    assert.deepEqual(
      await capture(origin, await read(origin, `/api/tasks/${before.task.id}`)),
      { task: before.task, artifacts: before.artifacts, events: before.events },
    );
    assert.deepEqual(
      stableProjection(await read(origin, previewPath(before.task.id))),
      stableProjection(before.preview),
    );
  }
  const supported = cases[0];
  const controlAdmission = await read(origin, '/api/tasks', supported.request);
  let current = await settle(origin, controlAdmission.task_id);
  assert.equal(current.status, 'completed');
  const controlPreview = await read(origin, previewPath(current.id));
  const oldPlan = await read(
    origin,
    `/api/artifacts/${controlPreview.plan.artifact.id}`,
  );
  const correctedScope = structuredClone(supported.request.scope);
  correctedScope.selection.target.target_fraction = '0.15';
  await read(origin, `/api/tasks/${current.id}/updates`, {
    schema_version: 'haze.task.update.v3',
    ...fence(current),
    kind: 'correction',
    passage:
      'Use a fifteen percent target with the same supplied intervention and exact source.',
    scope: correctedScope,
    affected_assignment_ids: current.assignments
      .filter(({ role }) => role !== 'Manager')
      .map(({ id }) => id),
  });
  current = await read(origin, `/api/tasks/${current.id}`);
  assert.equal(current.result.currency, 'stale');
  assert.equal(
    (await read(origin, previewPath(current.id))).plan_eligibility,
    'none',
  );
  await read(origin, `/api/tasks/${current.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(current),
    action: 'resume',
  });
  current = await settle(origin, current.id);
  assert.equal(current.status, 'completed');
  const replacement = await read(origin, previewPath(current.id));
  assert.equal(replacement.claims.point_estimate_label, 'does_not_meet');
  assert.equal(replacement.plan_review.value.verdict, 'supported');
  assert.notEqual(replacement.plan.artifact.id, oldPlan.id);
  assert.deepEqual(await read(origin, `/api/artifacts/${oldPlan.id}`), oldPlan);
  await read(origin, `/api/tasks/${current.id}/control`, {
    schema_version: 'haze.task.control.v3',
    ...fence(current),
    action: 'revoke',
    revoked_tools: ['reduction.imported-residual-comparison.v1'],
    reason: 'Operator withdrew calculation-method access.',
  });
  const revokedPreview = await read(origin, previewPath(current.id));
  assert.equal(revokedPreview.plan_eligibility, 'none');
  assert.equal(
    (await read(origin, `/api/tasks/${current.id}`)).result.currency,
    'stale',
  );
  const retainedSupported = await read(origin, previewPath(supported.task.id));
  assert.equal(retainedSupported.plan_eligibility, 'conditional');
  assert.equal(retainedSupported.claims.point_estimate_label, 'meets');
  report = {
    checked_at: new Date().toISOString(),
    passed: true,
    mode: 'fixture',
    frozen_cases_sha256: contractHash(frozenCases),
    frozen_method_cases_sha256: contractHash(FROZEN_PLANNING_CASES),
    restart: true,
    exact_source_inspection: true,
    http_boundaries_checked: true,
    duplicate_admission: true,
    corrected_history_retained: true,
    revoked_claims_withheld: true,
    scientific_qualification: 'unqualified',
    live_delivery: 'deferred',
    configured_live_model_behavior: 'not_tested',
    benchmark_interpretation:
      'Synthetic deterministic runtime versus single-sequence kernel baseline. Same original evidence and deterministic operations; no empirical agent-quality, provider-cost or scientific comparison.',
    cases,
    control_task_id: current.id,
    corrected_preview: replacement,
    revoked_preview: revokedPreview,
  };
  const reportPath = resolve(root, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        passed: true,
        restart: true,
        cases: cases.map(({ frozen, trace, single_sequence_baseline }) => ({
          id: frozen.id,
          expected_state: frozen.expected_state,
          ...trace,
          baseline_latency_ms: single_sequence_baseline.latency_ms,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
