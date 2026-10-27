import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

if (process.argv.slice(2).join(' ') !== '--live')
  throw new Error(
    'Usage: node --env-file-if-exists=.env scripts/verify-damage-evidence-research.mjs --live (run npm run build first). Offline contracts are covered by damage-evidence-research.test.ts.',
  );
const root = resolve(
  '.state/damage-evidence-research-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
let child;
let report = {
  schema_version: 'haze.damage.evidence.verification.v1',
  mode: 'configured_live',
  started_at: new Date().toISOString(),
  state_directory: root,
  verification: 'not_started',
  scientific_qualification: 'not_tested',
  numerical_update_reassessment: 'not_tested',
};
const secrets = [
  process.env.TAVILY_API_KEY,
  process.env.NVIDIA_API_KEY,
  process.env.HAZE_PROVIDER_API_KEY,
  process.env.SPECIALIST_API_KEY,
].filter(Boolean);
const redact = (value) =>
  secrets.reduce(
    (text, secret) => text.split(secret).join('<redacted>'),
    String(value),
  );
async function boot() {
  child = fork(new URL('./serve-tasks.mjs', import.meta.url), [], {
    env: {
      ...process.env,
      SAMPLE_MODE: 'false',
      STATE_DIR: root,
      HAZE_TASK_STATE_DIR: root,
      HAZE_TASK_PORT: '0',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Research task API startup timed out.')),
      45_000,
    );
    child.once('message', ({ port }) => {
      clearTimeout(timer);
      done(`http://127.0.0.1:${port}`);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Research task API exited (${code}).`));
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const active = child;
  await new Promise((done) => {
    active.once('exit', done);
    active.kill('SIGTERM');
  });
}
async function request(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
try {
  if (!process.env.TAVILY_API_KEY?.trim())
    throw new Error('TAVILY_API_KEY is not configured; no live request made.');
  let origin = await boot();
  const admitted = await request(origin, '/api/tasks', {
    schema_version: 'haze.task.request.v3',
    objective:
      'Find official public sources about the September 2019 Malaysian haze using the exact bounded search in scope.search. Retain one websearch.capture and report its source links as unreviewed leads, with scientific and numerical gaps explicit. This request needs no acquisition or calculation. Use the registered discovery assignment with its normal eight-turn budget so HazeOps can call the tool, save its result and finish.',
    scope: {
      capability: 'damage-evidence-research',
      verification_only: true,
      occurrence_period: { start: '2019-09-01', end: '2019-09-30' },
      search: {
        schema_version: 'haze.websearch.query.v1',
        query: 'site:asmc.asean.org Malaysia haze September 2019',
        max_results: 2,
        topic: 'general',
      },
    },
    constraints: [
      'At most one web search; no invented numerical values; do not expand this verification into accounting.',
    ],
  });
  const deadline = Date.now() + 310_000;
  let task;
  do {
    task = await request(origin, `/api/tasks/${admitted.task_id}`);
    if (!['queued', 'running'].includes(task.status)) break;
    if (Date.now() > deadline)
      throw new Error('Research task did not settle before its deadline.');
    await new Promise((done) => setTimeout(done, 500));
  } while (true);
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await request(
      origin,
      `/api/tasks/${task.id}/events?after=${cursor}`,
    );
    events.push(...page.events);
    if (page.next_cursor === cursor || page.events.length < 100) break;
    cursor = page.next_cursor;
  }
  const artifacts = [];
  for (const entry of task.artifacts) {
    const artifact = await request(
      origin,
      `/api/artifacts/${entry.artifact.id}`,
    );
    if (
      artifact.sha256 !== entry.artifact.sha256 ||
      artifact.version !== entry.artifact.version
    )
      throw new Error('Retained artifact changed.');
    artifacts.push(artifact);
  }
  await writeFile(
    resolve(root, 'task-capture.json'),
    `${JSON.stringify({ task, events, artifacts }, null, 2)}\n`,
  );
  const captures = artifacts.filter(
    (artifact) =>
      artifact.kind === 'websearch.capture' &&
      artifact.content?.evidence_origin === 'external_source',
  );
  report = {
    ...report,
    task_id: task.id,
    task_status: task.status,
    live_search_capture_count: captures.length,
    live_provider_results: captures.map(({ id, version, sha256, content }) => ({
      artifact: { id, version, sha256 },
      provider: content.provider,
      response_sha256: content.response_sha256,
      result_count: content.result_count,
      provider_request_id: content.provider_request_id ?? null,
      usage: content.usage ?? null,
    })),
    model_event_count: events.filter((event) => /model/iu.test(event.type))
      .length,
  };
  if (!captures.length)
    throw new Error(
      `Live task ended ${task.status} with ${captures.length} retained external search captures.`,
    );
  await stop();
  const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
    readOnly: true,
  });
  let attempts;
  try {
    attempts = database
      .prepare('SELECT body FROM attempts ORDER BY rowid')
      .all()
      .map(({ body }) => JSON.parse(body));
  } finally {
    database.close();
  }
  await writeFile(
    resolve(root, 'attempts.json'),
    `${JSON.stringify(attempts, null, 2)}\n`,
  );
  const modelReceipts = attempts.filter(
    (attempt) =>
      attempt.kind === 'model' &&
      attempt.status === 'completed' &&
      attempt.receipt?.synthetic !== true &&
      typeof attempt.receipt?.response_model === 'string',
  );
  report.model_receipts = modelReceipts.map(
    ({ id, assignment_id, receipt }) => ({ id, assignment_id, receipt }),
  );
  report.search_attempt_count = attempts.filter(
    (attempt) =>
      attempt.kind === 'tool' && attempt.details?.tool === 'haze-web-search',
  ).length;
  if (report.search_attempt_count !== 1)
    throw new Error(
      'The bounded verification must perform exactly one search attempt.',
    );
  if (!modelReceipts.length)
    throw new Error('No completed real model provider receipt was retained.');
  origin = await boot();
  const reread = await request(origin, `/api/tasks/${task.id}`);
  for (const capture of captures) {
    const restored = await request(origin, `/api/artifacts/${capture.id}`);
    if (
      restored.sha256 !== capture.sha256 ||
      restored.version !== capture.version
    )
      throw new Error('Restart changed retained evidence.');
  }
  report = {
    ...report,
    verification:
      task.status === 'completed'
        ? 'passed_live_discovery_and_restart'
        : 'partial_live_capture_and_restart_task_incomplete',
    restart_task_status: reread.status,
  };
  if (task.status !== 'completed') process.exitCode = 1;
} catch (error) {
  report = {
    ...report,
    verification: 'failed_or_unavailable',
    error: redact(error instanceof Error ? error.message : error),
  };
  process.exitCode = 1;
} finally {
  await stop();
  report.finished_at = new Date().toISOString();
  await writeFile(
    resolve(root, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        verification: report.verification,
        report: resolve(root, 'report.json'),
        task_status: report.task_status ?? null,
      },
      null,
      2,
    ),
  );
}
