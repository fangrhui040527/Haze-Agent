import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
async function boot() {
  child = fork(
    new URL('./serve-tasks.mjs', import.meta.url),
    fixture ? ['--fixture'] : [],
    {
      env: { ...process.env, STATE_DIR: root, HAZE_TASK_PORT: '0' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  return new Promise((ready, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('General task server startup timed out.')),
      10_000,
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
try {
  let origin = await boot();
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
    objective: 'Explain the supplied source about evidence and attribution.',
    context_refs: [{ id: ref.id, version: ref.version, sha256: ref.sha256 }],
  };
  const key = randomUUID();
  const admitted = await read(origin, '/api/tasks', genericRequest, key);
  const duplicate = await read(origin, '/api/tasks', genericRequest, key);
  const general = await capture(origin, await settle(origin, admitted.task_id));
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
  const investigation = await capture(
    origin,
    await settle(origin, investigationAdmission.task_id),
  );
  await stop();
  origin = await boot();
  const afterGeneral = await capture(
    origin,
    await read(origin, `/api/tasks/${general.task.id}`),
  );
  const afterInvestigation = await capture(
    origin,
    await read(origin, `/api/tasks/${investigation.task.id}`),
  );
  const restart =
    JSON.stringify(general) === JSON.stringify(afterGeneral) &&
    JSON.stringify(investigation) === JSON.stringify(afterInvestigation);
  const liveReceipts = [general, investigation].every(
    ({ task }) =>
      task.result?.provenance.mode === 'live' &&
      task.result.provenance.receipts.length > 0,
  );
  const sourceExecuted =
    investigation.task.usage.tool_calls > 0 &&
    investigation.artifacts.some(
      (artifact) => artifact.kind === 'pm25.capture',
    );
  const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
    readOnly: true,
  });
  const attempts = database
    .prepare('SELECT body FROM attempts ORDER BY rowid')
    .all()
    .map((row) => JSON.parse(row.body));
  database.close();
  const passed =
    general.task.status === 'completed' &&
    investigation.task.status === 'completed' &&
    sourceExecuted &&
    restart &&
    duplicate.task_id === admitted.task_id &&
    (fixture || liveReceipts);
  report = {
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    readiness: passed
      ? fixture
        ? 'fixture-tested'
        : 'live-executed'
      : 'unverified',
    live_readiness_pass: !fixture && passed,
    passed,
    duplicate_delivery: duplicate.task_id === admitted.task_id,
    restart,
    capabilities: await read(origin, '/api/capabilities'),
    attempts,
    general,
    investigation,
  };
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: path,
        mode: report.mode,
        passed,
        readiness: report.readiness,
        restart,
        general: general.task.status,
        investigation: investigation.task.status,
        error: investigation.task.error ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
