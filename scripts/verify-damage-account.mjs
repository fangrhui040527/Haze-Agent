import { fork } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSyntheticDamageImport } from '../dist/capabilities/damage-account/fixtures.js';
import {
  damageAccountSchema,
  damageReviewSchema,
} from '../dist/contracts/damage-account.js';

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
const root = resolve(
  process.env.STATE_DIR || '.state',
  'damage-verification',
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
    const timer = setTimeout(
      () => reject(new Error('Damage verifier startup timed out.')),
      10000,
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
  const data = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
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
try {
  let origin = await boot();
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
      'Build a damage account from the exact imported quantities and declared unit values using the registered damage-account capability. Produce physical outcomes, financial incidence, selected social welfare, omissions and scenarios, with an independent exact-component accounting review. Keep imported applicability and synthetic evidence limits visible.',
    context_refs: [{ id: ref.id, version: ref.version, sha256: ref.sha256 }],
  };
  const key = randomUUID();
  const admission = await read(origin, '/api/tasks', request, key);
  const duplicate = await read(origin, '/api/tasks', request, key);
  const before = await capture(origin, await settle(origin, admission.task_id));
  await stop();
  origin = await boot();
  const after = await capture(
    origin,
    await read(origin, `/api/tasks/${admission.task_id}`),
  );
  const restart = JSON.stringify(before) === JSON.stringify(after);
  const rawAccount = before.artifacts.find((a) => a.kind === 'damage.account');
  const account = rawAccount
    ? damageAccountSchema.parse(rawAccount.content)
    : undefined;
  const rawReview = before.artifacts.find((a) => a.kind === 'damage.review');
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
    before.task.result?.review.status === 'supported',
  );
  const selected = Boolean(
    rawAccount &&
    before.task.result?.work_products.some((r) => r.id === rawAccount.id),
  );
  const database = new DatabaseSync(resolve(root, 'tasks.sqlite'), {
    readOnly: true,
  });
  const attempts = database
    .prepare('SELECT body FROM attempts ORDER BY rowid')
    .all()
    .map((row) => JSON.parse(row.body));
  database.close();
  const genuineModelReceipt =
    before.task.mode === 'live' &&
    attempts.some(
      (a) =>
        a.kind === 'model' &&
        a.status === 'completed' &&
        a.receipt?.response_id,
    );
  const passed =
    before.task.status === 'completed' &&
    duplicate.task_id === admission.task_id &&
    restart &&
    exactClosure &&
    reviewed &&
    selected &&
    (fixture || genuineModelReceipt);
  report = {
    checked_at: new Date().toISOString(),
    mode: fixture ? 'fixture' : 'live',
    passed,
    restart,
    duplicate_delivery: duplicate.task_id === admission.task_id,
    exact_component_closure: exactClosure,
    reviewed,
    selected,
    evidence_origin: account?.evidence_origin ?? null,
    scientific_applicability: 'not_established_by_arithmetic',
    empirical_pilot_qualified: false,
    genuine_model_receipt: !!genuineModelReceipt,
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
} finally {
  await stop();
}
if (!report?.passed) process.exitCode = 2;
