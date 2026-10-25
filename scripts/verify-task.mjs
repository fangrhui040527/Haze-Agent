import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Real configured adapters only. A failure receipt is never a readiness pass.
const [location, start, end] = process.argv.slice(2);
if (!location || !start || !end)
  throw new Error(
    'Usage: node --env-file-if-exists=.env scripts/verify-task.mjs LOCATION UTC_START UTC_END',
  );
const root = resolve(
  process.env.STATE_DIR || '.state',
  'task-verification',
  randomUUID(),
);
await mkdir(root, { recursive: true });
let child;
async function boot() {
  child = fork(new URL('./serve-tasks.mjs', import.meta.url), [], {
    env: { ...process.env, STATE_DIR: root, HAZE_TASK_PORT: '0' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Task server startup timed out.')),
      10000,
    );
    child.once('message', (message) => {
      clearTimeout(timeout);
      resolveReady(`http://127.0.0.1:${message.port}`);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Task server exited (${code}).`));
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const active = child;
  await new Promise((resolveExit) => {
    active.once('exit', resolveExit);
    active.kill('SIGTERM');
  });
}
let report;
try {
  let origin = await boot();
  const request = {
    schema_version: 'haze.task.request.v1',
    objective: `Summarize the PM2.5 evidence available for ${location} during ${start} to ${end}, distinguish modeled values from observations, and identify coverage gaps.`,
    scope: { location, period: { start, end } },
  };
  const submission = await fetch(`${origin}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(request),
  });
  const admission = await submission.json();
  if (submission.status !== 202)
    throw new Error(`Admission failed: ${JSON.stringify(admission)}`);
  let task;
  const deadline = Date.now() + 95000;
  do {
    task = await (await fetch(`${origin}${admission.status_url}`)).json();
    if (!['queued', 'running'].includes(task.status)) break;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 200));
  } while (Date.now() < deadline);
  const events = await (await fetch(`${origin}${admission.events_url}`)).json();
  await stop();
  origin = await boot();
  const afterRestart = await (
    await fetch(`${origin}${admission.status_url}`)
  ).json();
  const eventsAfterRestart = await (
    await fetch(`${origin}${admission.events_url}`)
  ).json();
  report = {
    checked_at: new Date().toISOString(),
    mode: 'live',
    source: 'zetaris-smokeledger-pm25',
    request,
    task_id: task.id,
    status: task.status,
    error: task.error ?? null,
    usage: task.usage,
    provenance: task.result?.provenance ?? null,
    events: events.events,
    restart: {
      status_readable: JSON.stringify(afterRestart) === JSON.stringify(task),
      events_readable:
        JSON.stringify(eventsAfterRestart) === JSON.stringify(events),
    },
    live_readiness_pass: task.status === 'completed',
    result: task.result ?? null,
  };
  const path = resolve(root, 'report.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report: path,
        status: report.status,
        usage: report.usage,
        error: report.error,
        restart: report.restart,
        live_readiness_pass: report.live_readiness_pass,
      },
      null,
      2,
    ),
  );
} finally {
  await stop();
}
if (!report?.live_readiness_pass) process.exitCode = 2;
