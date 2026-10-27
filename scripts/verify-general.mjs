import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  artifactEvidence,
  captureVerificationBindings,
  domainModelEvidence,
  domainVerificationEnvironment,
  readVerificationLineage,
} from './domain-verification-support.mjs';

const [mode, location, start, end] = process.argv.slice(2);
if (
  !['--fixture', '--live'].includes(mode) ||
  (mode === '--live' && (!location || !start || !end))
)
  throw new Error(
    'Usage: verify-general.mjs --fixture | --live LOCATION UTC_START UTC_END',
  );
const fixture = mode === '--fixture';
const root = resolve(
  process.env.STATE_DIR || '.state',
  'general-verification',
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
        HAZE_WORLD_ACCEPTANCE_POLICY: 'research-v1',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  return new Promise((ready, reject) => {
    // Opening the state database and vendored engines competes with whatever
    // else the machine is running, and a slow start is not a failed start.
    const timeout = setTimeout(
      () => reject(new Error('General task server startup timed out.')),
      45_000,
    );
    child.once('message', (message) => {
      clearTimeout(timeout);
      ready(`http://127.0.0.1:${message.port}`);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`General task server exited (${code}).`));
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
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function settle(origin, id) {
  const endBy = Date.now() + 310_000;
  for (;;) {
    const task = await read(origin, `/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) return task;
    if (Date.now() > endBy)
      throw new Error('Task failed to settle within its admitted deadline.');
    await new Promise((done) => setTimeout(done, 100));
  }
}
async function capture(origin, task) {
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
  const artifacts = [];
  for (const item of task.artifacts) {
    const ref = item.artifact;
    const artifact = await read(origin, `/api/artifacts/${ref.id}`);
    if (artifact.sha256 !== ref.sha256 || artifact.version !== ref.version)
      throw new Error('Artifact reference changed.');
    artifacts.push(artifact);
  }
  return { task, events, artifacts };
}
let report;
let general;
let investigation;
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
async function retainReport(value) {
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
try {
  if (!fixture)
    bindingEvidence = await captureVerificationBindings(
      domainVerificationEnvironment(process.env),
    );
  let origin = await boot();
  stage = 'source_synthesis';
  const source = await read(origin, '/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'source.md',
    media_type: 'text/markdown',
    content_base64: Buffer.from(
      'A source-backed explanation uses exact retained source material. Source attribution alone does not prove authenticity.',
    ).toString('base64'),
    declared_origin: 'Local verification input',
  });
  const ref = source.artifact ?? source;
  const genericRequest = {
    schema_version: 'haze.task.request.v3',
    objective:
      'Use the registered evidence-synthesis workflow to create a retained source-backed synthesis artifact and an independent review of the supplied source about evidence and attribution. Explain its bounded conclusions, cite the exact source in the final answer, and select the reviewed synthesis as a work product.',
    context_refs: [{ id: ref.id, version: ref.version, sha256: ref.sha256 }],
  };
  const key = randomUUID();
  const admitted = await read(origin, '/api/tasks', genericRequest, key);
  const duplicate = await read(origin, '/api/tasks', genericRequest, key);
  general = await capture(origin, await settle(origin, admitted.task_id));
  stage = 'pm25_source_execution';
  const scope = {
    location: location ?? 'Fixture Town',
    period: {
      start: start ?? '2026-10-01T00:00:00Z',
      end: end ?? '2026-10-01T03:00:00Z',
    },
  };
  const investigationRequest = {
    schema_version: 'haze.task.request.v3',
    objective: `Investigate PM2.5 evidence for ${scope.location} during ${scope.period.start} to ${scope.period.end}. Use the registered pm25-evidence-summary workflow to retrieve modeled evidence, calculate reproducible coverage and run independent numerical checks. Distinguish modeled samples, observations and attribution, and report unavailable evidence truthfully.`,
    scope,
  };
  const investigationAdmission = await read(
    origin,
    '/api/tasks',
    investigationRequest,
  );
  investigation = await capture(
    origin,
    await settle(origin, investigationAdmission.task_id),
  );
  const requiredCapabilities = [
    'damage-appraisal',
    'pm25-evidence-summary',
    'damage-account-intake',
    'episode-investigation',
    'evidence-synthesis',
  ];
  stage = 'world_model_acceptance';
  const capabilities = await read(origin, '/api/capabilities');
  if (
    !requiredCapabilities.every((id) =>
      capabilities.some((capability) => capability.id === id),
    )
  )
    throw new Error('A required World Model capability is not registered.');
  const generalWorld = await read(
    origin,
    `/api/tasks/${general.task.id}/world`,
  );
  const accepted = generalWorld.current_acceptances.find(
    ({ acceptance }) => acceptance.status === 'accepted',
  );
  if (!accepted)
    throw new Error('The source synthesis did not produce an acceptance.');
  const recordPath = `/api/world/records/${encodeURIComponent(accepted.subject)}`;
  const acceptedDetail = await read(origin, recordPath);
  const acceptedLineage = await readVerificationLineage(
    read,
    origin,
    recordPath,
  );
  if (
    acceptedDetail.view !== 'detail' ||
    acceptedLineage.view !== 'lineage' ||
    !acceptedLineage.lineage.entries.some(
      (entry) => entry.event_kind === 'acceptance_evaluated',
    )
  )
    throw new Error('Authorized World Model detail or lineage read failed.');
  const currentGeneral = await read(origin, `/api/tasks/${general.task.id}`);
  stage = 'correction_hold';
  await read(origin, `/api/tasks/${general.task.id}/updates`, {
    schema_version: 'haze.task.update.v3',
    expected_objective_revision: currentGeneral.objective_revision,
    expected_run_id: currentGeneral.current_run_id,
    expected_generation: currentGeneral.generation,
    expected_state_revision: currentGeneral.state_revision,
    kind: 'correction',
    passage:
      'Fixture correction: the previously cited source needs renewed review.',
  });
  const heldDetail = await read(origin, recordPath);
  if (
    !heldDetail.detail.status.acceptances.some(
      (acceptance) => acceptance.status === 'held',
    )
  )
    throw new Error('A correction did not hold the accepted fixture record.');
  const heldLineage = await readVerificationLineage(read, origin, recordPath);
  const authorizedRecordDetail = await read(origin, recordPath);
  if (authorizedRecordDetail.detail.record.ref.id !== accepted.subject)
    throw new Error('Scoped World Model record read failed.');
  const heldGeneral = await capture(
    origin,
    await read(origin, `/api/tasks/${general.task.id}`),
  );
  stage = 'restart_readback';
  await stop();
  origin = await boot();
  const afterInvestigation = await capture(
    origin,
    await read(origin, `/api/tasks/${investigation.task.id}`),
  );
  const afterHeldDetail = await read(origin, recordPath);
  const afterHeldLineage = await readVerificationLineage(
    read,
    origin,
    recordPath,
  );
  const restart =
    JSON.stringify(heldDetail) === JSON.stringify(afterHeldDetail) &&
    JSON.stringify(heldLineage) === JSON.stringify(afterHeldLineage) &&
    JSON.stringify(investigation) === JSON.stringify(afterInvestigation);
  const liveReceipts = [general, investigation].every(
    ({ task }) =>
      task.result?.provenance.mode === 'live' &&
      task.usage.model_calls > 0 &&
      task.result.provenance.receipts.some(
        (attempt) =>
          attempt.kind === 'model' &&
          attempt.status === 'completed' &&
          attempt.accepted === true &&
          attempt.receipt?.synthetic !== true &&
          attempt.receipt?.http_status === 200 &&
          attempt.receipt?.response_status === 'stop' &&
          typeof attempt.receipt?.response_model === 'string' &&
          typeof attempt.receipt?.response_id === 'string',
      ),
  );
  const attempts = retainedAttempts();
  const modelEvidence = domainModelEvidence(investigation.task, attempts);
  const pm25Analysis = currentArtifact(
    investigation.task,
    investigation.artifacts,
    'pm25.analysis',
    investigation.task.result?.work_products ?? [],
  );
  const pm25Capture = currentArtifact(
    investigation.task,
    investigation.artifacts,
    'pm25.capture',
    pm25Analysis?.dependencies ?? [],
  );
  const reviewCheck = investigation.task.result?.review.checks?.find(
    (check) =>
      sameRef(check.artifact, pm25Analysis) &&
      check.verdict === 'supported' &&
      check.producer_assignment_id === pm25Analysis?.assignment_id &&
      check.producer_revision === pm25Analysis?.assignment_revision &&
      check.reviewer_assignment_id !== check.producer_assignment_id,
  );
  const pm25Review = currentArtifact(
    investigation.task,
    investigation.artifacts,
    'review',
    [reviewCheck?.review_artifact],
  );
  const reviewed = Boolean(
    pm25Analysis &&
    pm25Review &&
    reviewCheck &&
    investigation.task.result?.review.status === 'supported' &&
    pm25Review.assignment_id === reviewCheck.reviewer_assignment_id &&
    pm25Review.assignment_revision === reviewCheck.reviewer_revision &&
    pm25Review.content.verdict === 'supported' &&
    pm25Review.content.reviewed_artifacts?.some((ref) =>
      sameRef(ref, pm25Analysis),
    ),
  );
  const sourceExecuted = Boolean(
    pm25Capture && investigation.task.usage.tool_calls > 0,
  );
  const retainedQueryRows = Boolean(
    pm25Capture?.content.selection?.backend === 'zetaris-rest' &&
    pm25Capture.content.selection.query &&
    pm25Capture.content.raw &&
    pm25Capture.content.rows?.length,
  );
  const answerRendered = Boolean(
    pm25Analysis &&
    investigation.task.result?.answer.startsWith('PM2.5 evidence:') &&
    investigation.task.result.work_products.some((ref) =>
      sameRef(ref, pm25Analysis),
    ),
  );
  const passed =
    general.task.status === 'completed' &&
    investigation.task.status === 'completed' &&
    sourceExecuted &&
    restart &&
    duplicate.task_id === admitted.task_id &&
    reviewed &&
    answerRendered &&
    retainedQueryRows &&
    (fixture ||
      (liveReceipts &&
        modelEvidence.strict_model_receipts &&
        pm25Capture.content.mode === 'live' &&
        pm25Capture.content.evidence_origin !== 'synthetic_fixture' &&
        pm25Capture.evidence_origin !== 'synthetic_fixture'));
  report = {
    ...bindingEvidence,
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    readiness: passed
      ? fixture
        ? 'fixture-tested'
        : 'live-executed'
      : 'unverified',
    live_readiness_pass: !fixture && passed,
    passed,
    source_executed: sourceExecuted,
    live_model_receipts: liveReceipts,
    pm25_verification: {
      ...modelEvidence,
      independently_reviewed: reviewed,
      retained_query_and_rows: retainedQueryRows,
      answer_rendered: answerRendered,
      artifacts: artifactEvidence(investigation.artifacts),
    },
    duplicate_delivery: duplicate.task_id === admitted.task_id,
    restart,
    restart_task: afterInvestigation.task,
    capabilities: await read(origin, '/api/capabilities'),
    attempts,
    general,
    held_general: heldGeneral,
    investigation,
    world_model: {
      accepted: acceptedDetail,
      lineage: acceptedLineage,
      held: heldDetail,
      held_lineage: heldLineage,
      authorized_record_read: authorizedRecordDetail,
      capabilities: requiredCapabilities,
    },
  };
  const path = await retainReport(report);
  console.log(
    JSON.stringify(
      {
        report: path,
        mode: report.mode,
        passed,
        readiness: report.readiness,
        restart,
        accepted: acceptedDetail.detail.status.acceptances.some(
          (acceptance) => acceptance.status === 'accepted',
        ),
        held: heldDetail.detail.status.acceptances.some(
          (acceptance) => acceptance.status === 'held',
        ),
        general: general.task.status,
        investigation: investigation.task.status,
        error: investigation.task.error ?? null,
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
    readiness: 'unverified',
    live_readiness_pass: false,
    passed: false,
    verification_error: {
      stage,
      message: error instanceof Error ? error.message : String(error),
    },
    attempts,
    ...(attemptReadError ? { attempt_read_error: attemptReadError } : {}),
    // Keep primary task failures and actual charged calls visible even when a
    // later verification probe fails before the success report is assembled.
    task_errors: {
      general: general?.task.error ?? null,
      investigation: investigation?.task.error ?? null,
    },
    model_evidence: {
      general: general ? domainModelEvidence(general.task, attempts) : null,
      investigation: investigation
        ? domainModelEvidence(investigation.task, attempts)
        : null,
    },
    general: general ?? null,
    investigation: investigation ?? null,
  };
  const path = await retainReport(report);
  console.log(
    JSON.stringify(
      {
        report: path,
        mode: report.mode,
        passed: false,
        readiness: report.readiness,
        error: report.verification_error,
        task_errors: report.task_errors,
        general: general?.task.status ?? null,
        investigation: investigation?.task.status ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
