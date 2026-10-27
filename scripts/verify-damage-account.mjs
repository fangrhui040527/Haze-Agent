import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReductionVerificationReader } from './reduction-verification-http.mjs';
import { createSyntheticDamageImport } from '../dist/capabilities/damage-appraisal/fixtures.js';
import {
  damageAccountSchema,
  damageReviewSchema,
  damageImportSchema,
} from '../dist/contracts/damage-account.js';
import {
  artifactEvidence,
  captureVerificationBindings,
  accountingDemonstrationGaps,
  domainModelEvidence,
  domainVerificationEnvironment,
  retainedBytesHash,
} from './domain-verification-support.mjs';

const [mode, inputPath] = process.argv.slice(2);
if (
  !['--fixture', '--live'].includes(mode) ||
  (mode === '--live' && !inputPath)
)
  throw new Error(
    'Usage: verify-damage-account.mjs --fixture | --live INPUT.json',
  );
const fixture = mode === '--fixture';
const input = fixture
  ? createSyntheticDamageImport()
  : JSON.parse(await readFile(resolve(inputPath), 'utf8'));
damageImportSchema.parse(input);
if (
  !fixture &&
  [
    ...(input.effects ?? []),
    ...(input.unit_values ?? []),
    ...(input.incidence ?? []),
  ].some((entry) => entry.origin === 'synthetic')
)
  throw new Error(
    'Live accounting verification requires supplied non-synthetic inputs.',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-verification',
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
async function boot() {
  child = fork(
    new URL('./serve-tasks.mjs', import.meta.url),
    fixture ? ['--fixture'] : [],
    {
      env: {
        ...(fixture ? process.env : domainVerificationEnvironment(process.env)),
        STATE_DIR: root,
        HAZE_TASK_STATE_DIR: root,
        HAZE_TASK_PORT: '0',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  return new Promise((ready, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Damage verifier startup timed out.')),
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
      reject(new Error(`Damage server exited (${code}).`));
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    child.once('exit', done);
    child.kill('SIGTERM');
  });
}
const transportRetries = [];
const read = createReductionVerificationReader({
  onRetry: (entry) => transportRetries.push(entry),
});
async function settle(origin, id) {
  const deadline = Date.now() + 310000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() >= deadline)
      throw new Error(
        'Damage task did not settle within its admitted deadline.',
      );
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function capture(origin, task) {
  const artifacts = [];
  for (const { artifact: ref } of task.artifacts) {
    const artifact = await read(origin, `/api/artifacts/${ref.id}`);
    if (ref.version !== artifact.version || ref.sha256 !== artifact.sha256)
      throw new Error('Exact damage artifact changed.');
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
let report;
let before;
let stage = 'server_start';
let bindingEvidence = {};
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
try {
  if (!fixture)
    bindingEvidence = await captureVerificationBindings(
      domainVerificationEnvironment(process.env),
    );
  let origin = await boot();
  stage = 'input_import';
  const imported = await read(origin, '/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'damage-inputs.json',
    media_type: 'application/json',
    declared_origin: fixture
      ? 'Explicit synthetic accounting fixture. Invented CU; no empirical data.'
      : 'Explicitly admitted local accounting input; original evidence status retained.',
    content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
  });
  const ref = imported.artifact ?? imported;
  const request = {
    schema_version: 'haze.task.request.v3',
    objective:
      'Build a damage account from the exact imported quantities and declared unit values using the registered damage-appraisal capability. Produce physical outcomes, financial incidence, selected social welfare, omissions and scenarios, with an independent exact-component accounting review. Keep imported applicability and synthetic evidence limits visible.',
    context_refs: [{ id: ref.id, version: ref.version, sha256: ref.sha256 }],
  };
  const key = randomUUID();
  stage = 'accounting_task';
  const admission = await read(origin, '/api/tasks', request, key);
  const duplicate = await read(origin, '/api/tasks', request, key);
  before = await capture(origin, await settle(origin, admission.task_id));
  stage = 'restart_readback';
  await stop();
  origin = await boot();
  const after = await capture(
    origin,
    await read(origin, `/api/tasks/${admission.task_id}`),
  );
  const restart = JSON.stringify(before) === JSON.stringify(after);
  const rawAccount = currentArtifact(
    before.task,
    before.artifacts,
    'damage.account',
    before.task.result?.work_products ?? [],
  );
  const account = rawAccount
    ? damageAccountSchema.parse(rawAccount.content)
    : undefined;
  const reviewCheck = before.task.result?.review.checks?.find(
    (check) =>
      sameRef(check.artifact, rawAccount) &&
      check.verdict === 'supported' &&
      check.producer_assignment_id === rawAccount?.assignment_id &&
      check.producer_revision === rawAccount?.assignment_revision &&
      check.reviewer_assignment_id !== check.producer_assignment_id,
  );
  const rawReview = currentArtifact(
    before.task,
    before.artifacts,
    'damage.review',
    [reviewCheck?.review_artifact],
  );
  const review = rawReview
    ? damageReviewSchema.parse(rawReview.content)
    : undefined;
  const exactClosure =
    !!account &&
    account.component_refs.every(({ artifact }) =>
      rawAccount.dependencies.some(
        (r) =>
          r.id === artifact.id &&
          r.version === artifact.version &&
          r.sha256 === artifact.sha256,
      ),
    );
  const reviewed = Boolean(
    review?.verdict === 'supported' &&
    reviewCheck &&
    before.task.result?.review.status === 'supported' &&
    rawReview.assignment_id === reviewCheck.reviewer_assignment_id &&
    rawReview.assignment_revision === reviewCheck.reviewer_revision &&
    review.reviewer.assignment_id === rawReview.assignment_id &&
    review.reviewer.revision === rawReview.assignment_revision &&
    review.reviewed_artifacts.some((ref) => sameRef(ref, rawAccount)),
  );
  const selected = Boolean(
    rawAccount &&
    before.task.result?.work_products.some((r) => sameRef(r, rawAccount)),
  );
  const attempts = retainedAttempts();
  const modelEvidence = domainModelEvidence(before.task, attempts);
  const genuineModelReceipt = modelEvidence.strict_model_receipts;
  const answerRendered = Boolean(
    account && before.task.result?.answer.startsWith('Damage account '),
  );
  const gaps = accountingDemonstrationGaps(before.task, account);
  const passed =
    before.task.status === 'completed' &&
    duplicate.task_id === admission.task_id &&
    restart &&
    exactClosure &&
    reviewed &&
    selected &&
    answerRendered &&
    (fixture ||
      (genuineModelReceipt &&
        gaps.length === 0 &&
        account.evidence_origin === 'imported'));
  report = {
    ...bindingEvidence,
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    passed,
    transport_retries: transportRetries,
    restart,
    restart_task: after.task,
    duplicate_delivery: duplicate.task_id === admission.task_id,
    exact_component_closure: exactClosure,
    reviewed,
    selected,
    evidence_origin: account?.evidence_origin ?? null,
    scientific_applicability: 'not_established_by_arithmetic',
    empirical_pilot_qualified: false,
    genuine_model_receipt: !!genuineModelReceipt,
    ...modelEvidence,
    answer_rendered: answerRendered,
    live_readiness_pass: !fixture && passed,
    gaps,
    account_status: account?.status ?? null,
    omissions: account?.omissions ?? [],
    input_sha256: retainedBytesHash(JSON.stringify(input)),
    artifact_references: artifactEvidence(before.artifacts),
    accounting_totals: account?.welfare_totals ?? [],
    scenarios: account?.scenarios ?? [],
    capabilities: await read(origin, '/api/capabilities'),
    attempts,
    ...before,
  };
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: path,
        mode: report.mode,
        passed,
        restart,
        reviewed,
        selected,
        evidence_origin: report.evidence_origin,
        task: before.task.status,
        error: before.task.error ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  let attempts = [];
  let attemptReadError;
  try {
    attempts = retainedAttempts();
  } catch (readError) {
    attemptReadError = String(readError);
  }
  report = {
    ...bindingEvidence,
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    passed: false,
    verification_error: {
      stage,
      message: error instanceof Error ? error.message : String(error),
    },
    attempts,
    ...(attemptReadError ? { attempt_read_error: attemptReadError } : {}),
    capture: before ?? null,
  };
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { report: path, passed: false, error: report.verification_error },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
