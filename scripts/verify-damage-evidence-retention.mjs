import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTaskHandler } from '../dist/tasks/http.js';

const state = process.argv[2];
if (!state || process.argv.length !== 3)
  throw new Error(
    'Usage: verify-damage-evidence-retention.mjs STATE_DIRECTORY',
  );
const root = resolve(state);
const saved = JSON.parse(
  await readFile(resolve(root, 'task-capture.json'), 'utf8'),
);
if (
  !['completed', 'failed', 'cancelled', 'timed_out'].includes(saved.task.status)
)
  throw new Error(
    'Retention verification requires a terminal task; it must not resume inference.',
  );
const sources = saved.artifacts.filter(
  (artifact) =>
    artifact.kind === 'websearch.capture' &&
    artifact.content?.evidence_origin === 'external_source',
);
if (!sources.length)
  throw new Error('No retained external search captures are available.');
function attempts() {
  const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
    readOnly: true,
  });
  try {
    return database.prepare('SELECT COUNT(*) AS count FROM attempts').get()
      .count;
  } finally {
    database.close();
  }
}
const before = attempts();
const handler = createTaskHandler({
  stateDirectory: root,
  mode: 'live',
  env: { ...process.env, HAZEOPS_SCHEDULER: 'off', SAMPLE_MODE: 'false' },
});
const server = createServer(handler);
let report;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const expected of sources) {
    const response = await fetch(`${origin}/api/artifacts/${expected.id}`, {
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `Retained artifact API returned HTTP ${response.status}.`,
      );
    const actual = await response.json();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Restart changed a retained artifact.');
    const hash = createHash('sha256')
      .update(Buffer.from(actual.content.raw_response_base64, 'base64'))
      .digest('hex');
    if (hash !== actual.content.response_sha256)
      throw new Error(
        'Original provider bytes do not match their retained hash.',
      );
  }
  const response = await fetch(`${origin}/api/tasks/${saved.task.id}`, {
    headers: { Connection: 'close' },
    signal: AbortSignal.timeout(15_000),
  });
  const task = await response.json();
  if (!response.ok || task.status !== saved.task.status)
    throw new Error('Restart changed the terminal task status.');
  report = {
    schema_version: 'haze.damage.evidence.retention-check.v1',
    verification: 'passed_normal_api_restart_retention_only',
    node_version: process.version,
    checked_at: new Date().toISOString(),
    verified_capture_count: sources.length,
    provider_raw_hashes_verified: sources.length,
    task_status: task.status,
    attempts_before: before,
    limitations: [
      'This verifies retained live bytes across normal API restart only. The configured-model task failed and remains an unmet end-to-end release gate.',
    ],
  };
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await handler.close();
}
report.attempts_after = attempts();
if (report.attempts_after !== before)
  throw new Error(
    'Retention verification unexpectedly dispatched new model/provider work.',
  );
await writeFile(
  resolve(root, 'retention-check.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
