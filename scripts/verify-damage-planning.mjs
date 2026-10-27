import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parsePlanningPackage } from './damage-planning-package.mjs';
import {
  artifactEvidence,
  captureVerificationBindings,
  domainModelEvidence,
  domainVerificationEnvironment,
  retainedBytesHash,
} from './domain-verification-support.mjs';
import { createReductionVerificationReader } from './reduction-verification-http.mjs';
import {
  createReductionSelection,
  exactReductionRef,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../dist/capabilities/damage-reduction-planning/methods.js';
import {
  conditionalPlanReviewSchema,
  conditionalReductionPlanSchema,
} from '../dist/contracts/damage-reduction-plan.js';
import { reductionReviewSchema } from '../dist/contracts/damage-reduction.js';

const [mode, path, ...extra] = process.argv.slice(2);
if (!['--inspect', '--live'].includes(mode) || !path || extra.length)
  throw new Error(
    'Usage: verify-damage-planning.mjs --inspect|--live PACKAGE.json',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-planning-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
let child;

const sameRef = (left, right) =>
  Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256,
  );
/** Historical artifacts stay retained; only one exact current product can qualify. */
function currentArtifact(task, artifacts, kind, refs) {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.kind === kind &&
      artifact.task_id === task.id &&
      artifact.run_id === task.current_run_id &&
      artifact.objective_revision === task.objective_revision &&
      artifact.producer.kind === 'assignment' &&
      task.artifacts.some(
        (entry) =>
          entry.current &&
          entry.objective_revision === task.objective_revision &&
          sameRef(entry.artifact, artifact),
      ) &&
      task.assignments.some(
        (assignment) =>
          assignment.id === artifact.assignment_id &&
          assignment.id === artifact.producer.id &&
          assignment.run_id === task.current_run_id &&
          assignment.objective_revision === task.objective_revision &&
          assignment.revision === artifact.assignment_revision &&
          assignment.status === 'completed' &&
          !['stale', 'rejected'].includes(assignment.usability) &&
          assignment.outputs.some((ref) => sameRef(ref, artifact)),
      ) &&
      refs.some((ref) => sameRef(ref, artifact)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
let capture;
let stage = 'package_validation';
const report = {
  checked_at: new Date().toISOString(),
  mode: mode === '--live' ? 'live' : 'inspection-only',
  passed: false,
  live_readiness_pass: false,
  scientific_qualification: 'unqualified',
  achieved_reduction: false,
  gaps: [],
  attempts: [],
  transport_retries: [],
};
const read = createReductionVerificationReader({
  onRetry: (entry) => report.transport_retries.push(entry),
});
async function boot() {
  child = fork(new URL('./serve-tasks.mjs', import.meta.url), [], {
    env: {
      ...domainVerificationEnvironment(process.env),
      STATE_DIR: root,
      HAZE_TASK_STATE_DIR: root,
      HAZE_TASK_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Planning verifier startup timed out.')),
      45_000,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      done(`http://127.0.0.1:${message.port}`);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Planning verifier server exited (${code}).`));
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
async function captureTask(origin, task) {
  const artifacts = [];
  for (const entry of task.artifacts) {
    const artifact = await read(origin, `/api/artifacts/${entry.artifact.id}`);
    if (
      artifact.version !== entry.artifact.version ||
      artifact.sha256 !== entry.artifact.sha256
    )
      throw new Error(`exact_artifact_changed:${artifact.id}`);
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
  return {
    task,
    artifacts,
    events,
    preview: await read(
      origin,
      `/api/tasks/${task.id}/views/reduction-preview`,
    ),
  };
}
function retainedAttempts() {
  const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
    readOnly: true,
  });
  try {
    return database
      .prepare('SELECT body FROM attempts ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(row.body));
  } finally {
    database.close();
  }
}
function restartSnapshot(value) {
  const snapshot = structuredClone(value);
  // Claim eligibility is recomputed on read. Its timestamp is intentionally
  // fresh; identities, status, references, accounting and results must match.
  if (snapshot.preview.claims) delete snapshot.preview.claims.checked_at;
  return snapshot;
}
try {
  const bytes = await readFile(resolve(path));
  report.input_sha256 = retainedBytesHash(bytes);
  const validation = parsePlanningPackage(JSON.parse(bytes.toString('utf8')));
  report.gaps.push(...validation.gaps);
  if (validation.gaps.length === 0 && mode === '--live') {
    const input = validation.package;
    stage = 'server_start';
    Object.assign(
      report,
      await captureVerificationBindings(
        domainVerificationEnvironment(process.env),
      ),
    );
    let origin = await boot();
    stage = 'source_import';
    const sources = [];
    const originals = [];
    for (const source of input.sources) {
      const imported = await read(origin, '/api/artifacts', {
        schema_version: 'haze.artifact.import.v3',
        filename: `${source.name}.json`,
        media_type: 'application/json',
        declared_origin:
          'Supplied residual quantities; scientific applicability remains unqualified.',
        content_base64: Buffer.from(JSON.stringify(source.input)).toString(
          'base64',
        ),
      });
      const ref = exactReductionRef(imported.artifact ?? imported);
      sources.push({ artifact: ref, row_ids: source.row_ids });
      originals.push(await read(origin, `/api/artifacts/${ref.id}`));
    }
    const selection = createReductionSelection(input.target, sources);
    const selectionImport = await read(origin, '/api/artifacts', {
      schema_version: 'haze.artifact.import.v3',
      filename: 'operator-selection.json',
      media_type: 'application/json',
      declared_origin:
        'Exact operator selection constructed after supplied residual import.',
      content_base64: Buffer.from(JSON.stringify(selection)).toString('base64'),
    });
    const selectionRef = exactReductionRef(
      selectionImport.artifact ?? selectionImport,
    );
    // The same normalization and exact arithmetic reject incomplete/incompatible
    // selections before spending a model call. This does not replace peer review.
    const preflight = assessReduction(selection, originals, selectionRef);
    report.preflight = preflight;
    if (preflight.status !== 'supported') {
      report.gaps.push(...preflight.reasons);
    } else {
      stage = 'planning_task';
      const request = {
        schema_version: 'haze.task.request.v3',
        objective:
          'Prepare a conditional damage-reduction planning preview from the exact selected supplied residual quantities and candidate. Calculate and independently review the scenario arithmetic, then independently review the conditional plan. Preserve costs, prerequisites, scope, uncertainty and scientific limitations; do not claim achieved reduction.',
        scope: {
          schema_version: 'haze.reduction.preview-selection-request.v1',
          selection_ref: selectionRef,
          candidate: input.candidate,
        },
        context_refs: [
          selectionRef,
          ...sources.map((source) => source.artifact),
        ],
      };
      const key = randomUUID();
      const admitted = await read(origin, '/api/tasks', request, key);
      const duplicate = await read(origin, '/api/tasks', request, key);
      const deadline = Date.now() + 310_000;
      let task;
      do {
        task = await read(origin, `/api/tasks/${admitted.task_id}`);
        if (!['queued', 'running'].includes(task.status)) break;
        if (Date.now() >= deadline)
          throw new Error('planning_task_deadline_exceeded');
        await new Promise((done) => setTimeout(done, 100));
      } while (true);
      capture = await captureTask(origin, task);
      stage = 'restart_readback';
      await stop();
      origin = await boot();
      const after = await captureTask(
        origin,
        await read(origin, `/api/tasks/${task.id}`),
      );
      report.restart =
        JSON.stringify(restartSnapshot(capture)) ===
        JSON.stringify(restartSnapshot(after));
      report.restart_task = after.task;
      report.duplicate_delivery = duplicate.task_id === admitted.task_id;
      report.attempts = retainedAttempts();
      const evidence = domainModelEvidence(task, report.attempts);
      Object.assign(report, evidence);
      // The projection rechecks current producer revisions, source holds,
      // operator selection and both independent reviews on every read.
      const preview = capture.preview;
      const planArtifact = currentArtifact(
        task,
        capture.artifacts,
        'reduction.conditional-plan',
        [preview.plan?.artifact],
      );
      const selectionArtifact = currentArtifact(
        task,
        capture.artifacts,
        'reduction.input-selection',
        [preview.selection?.artifact],
      );
      const assessmentArtifact = currentArtifact(
        task,
        capture.artifacts,
        'reduction.assessment',
        [preview.assessment?.artifact],
      );
      const planReviewArtifact = currentArtifact(
        task,
        capture.artifacts,
        'reduction.plan-review',
        [preview.plan_review?.artifact],
      );
      const arithmeticReviewArtifact = currentArtifact(
        task,
        capture.artifacts,
        'reduction.review',
        [preview.arithmetic_review?.artifact],
      );
      const plan = conditionalReductionPlanSchema.safeParse(
        planArtifact?.content,
      );
      const planReview = conditionalPlanReviewSchema.safeParse(
        planReviewArtifact?.content,
      );
      const arithmeticReview = reductionReviewSchema.safeParse(
        arithmeticReviewArtifact?.content,
      );
      const supports = (product, reviewArtifact) =>
        Boolean(
          product &&
          reviewArtifact &&
          task.result?.review.checks?.some(
            (check) =>
              sameRef(check.artifact, product) &&
              sameRef(check.review_artifact, reviewArtifact) &&
              check.verdict === 'supported' &&
              check.producer_assignment_id === product.assignment_id &&
              check.producer_revision === product.assignment_revision &&
              check.reviewer_assignment_id === reviewArtifact.assignment_id &&
              check.reviewer_revision === reviewArtifact.assignment_revision &&
              check.reviewer_assignment_id !== check.producer_assignment_id,
          ),
        );
      report.answer_rendered = Boolean(
        task.result?.answer.includes('Conditional plan:') &&
        task.result.answer.includes('Reduction assessment:') &&
        task.result.work_products.some((ref) => sameRef(ref, planArtifact)) &&
        plan.success &&
        sameRef(plan.data.assessment_ref, assessmentArtifact),
      );
      report.independently_reviewed = Boolean(
        plan.success &&
        planReview.success &&
        arithmeticReview.success &&
        planReview.data.verdict === 'supported' &&
        arithmeticReview.data.verdict === 'supported' &&
        supports(planArtifact, planReviewArtifact) &&
        supports(assessmentArtifact, arithmeticReviewArtifact) &&
        planReview.data.reviewer.assignment_id ===
          planReviewArtifact.assignment_id &&
        planReview.data.reviewer.revision ===
          planReviewArtifact.assignment_revision &&
        arithmeticReview.data.reviewer.assignment_id ===
          arithmeticReviewArtifact.assignment_id &&
        arithmeticReview.data.reviewer.revision ===
          arithmeticReviewArtifact.assignment_revision &&
        [
          planArtifact,
          selectionArtifact,
          assessmentArtifact,
          arithmeticReviewArtifact,
        ].every((artifact) =>
          planReview.data.reviewed_artifacts.some((ref) =>
            sameRef(ref, artifact),
          ),
        ) &&
        [selectionArtifact, assessmentArtifact].every((artifact) =>
          arithmeticReview.data.reviewed_artifacts.some((ref) =>
            sameRef(ref, artifact),
          ),
        ) &&
        task.result?.review.status === 'supported' &&
        preview.state === 'current' &&
        ['conditional', 'blocked'].includes(preview.plan_eligibility),
      );
      report.artifact_references = artifactEvidence(capture.artifacts);
      report.passed = Boolean(
        task.status === 'completed' &&
        task.result?.completion === 'full' &&
        report.restart &&
        report.duplicate_delivery &&
        report.answer_rendered &&
        report.independently_reviewed &&
        evidence.strict_model_receipts &&
        plan.success &&
        plan.data.origin === 'supplied' &&
        plan.data.assessment_status === 'supported',
      );
      report.live_readiness_pass = report.passed;
      if (!report.passed)
        report.gaps.push('live_planning_verification_incomplete');
    }
  } else if (validation.gaps.length === 0) {
    report.package_valid = true;
    report.gaps.push('live_execution_not_requested');
  }
} catch (error) {
  report.gaps.push(
    `${stage}:${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  if (child) {
    try {
      report.attempts = retainedAttempts();
    } catch (error) {
      report.attempt_read_error = String(error);
    }
  }
  report.capture = capture ?? null;
  const reportPath = resolve(root, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        mode: report.mode,
        passed: report.passed,
        gaps: report.gaps,
      },
      null,
      2,
    ),
  );
  await stop();
}
if (!report.passed && !(mode === '--inspect' && report.package_valid))
  process.exitCode = 2;
