import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const [mode, location, start, end] = process.argv.slice(2);
if (
  !['--fixture', '--live'].includes(mode) ||
  (mode === '--live' && (!location || !start || !end))
)
  throw new Error(
    'Usage: verify-orchestration.mjs --fixture | --live LOCATION UTC_START UTC_END',
  );
const fixture = mode === '--fixture';
const root = resolve(
  process.env.STATE_DIR || '.state',
  'orchestration-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
const scope = {
  location: location ?? 'Fixture Town',
  period: {
    start: start ?? '2026-10-01T00:00:00Z',
    end: end ?? '2026-10-01T03:00:00Z',
  },
};
const request = {
  schema_version: 'haze.task.request.v2',
  objective: `Summarize PM2.5 evidence for ${scope.location} during ${scope.period.start} to ${scope.period.end}, distinguish modeled samples from observations and identify coverage gaps.`,
  scope,
};
let child;
async function boot() {
  child = fork(
    new URL('./serve-tasks.mjs', import.meta.url),
    fixture ? ['--orchestration-fixture'] : [],
    {
      env: { ...process.env, STATE_DIR: root, HAZE_TASK_PORT: '0' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  return new Promise((ready, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Orchestration server startup timed out.')),
      10000,
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
      reject(new Error(`Orchestration server exited (${code}).`));
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
async function read(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
async function events(origin, path) {
  let cursor = 0;
  const result = [];
  for (;;) {
    const page = await read(`${origin}${path}?after=${cursor}`);
    result.push(...page.events);
    if (page.events.length < 100) return result;
    cursor = page.next_cursor;
  }
}
let report;
try {
  let origin = await boot();
  const admission = await read(`${origin}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(request),
  });
  let task;
  do {
    task = await read(`${origin}${admission.status_url}`);
    if (!['queued', 'running'].includes(task.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < Date.parse(task.limits.deadline) + 5000);
  const trace = await events(origin, admission.events_url);
  const artifacts = [];
  for (const assignment of task.assignments)
    for (const ref of assignment.outputs)
      artifacts.push(
        await read(`${origin}/api/tasks/${task.id}/artifacts/${ref.id}`),
      );
  await stop();
  origin = await boot();
  const after = await read(`${origin}${admission.status_url}`);
  const afterEvents = await events(origin, admission.events_url);
  const restart = {
    task_unchanged: JSON.stringify(task) === JSON.stringify(after),
    events_unchanged: JSON.stringify(trace) === JSON.stringify(afterEvents),
  };
  const passed =
    task.status === 'completed' &&
    task.usage.model_calls === 5 &&
    restart.task_unchanged &&
    restart.events_unchanged;
  report = {
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    readiness: passed
      ? fixture
        ? 'fixture-tested'
        : 'live-executed'
      : 'unverified',
    live_readiness_pass: !fixture && passed,
    request,
    task,
    events: trace,
    artifacts,
    restart,
    passed,
  };
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: path,
        status: task.status,
        error: task.error ?? null,
        usage: task.usage,
        readiness: report.readiness,
        restart,
        passed,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
