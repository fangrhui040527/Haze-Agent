import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSyntheticDamageImport,
  SYNTHETIC_DAMAGE_EXPECTATIONS,
} from '../dist/capabilities/damage-account/fixtures.js';
import { damageAccountSchema } from '../dist/contracts/damage-account.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.state/damage-demo', randomUUID());
const port = Number(process.env.HAZE_DAMAGE_DEMO_PORT ?? 5174);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('HAZE_DAMAGE_DEMO_PORT must be a port from 1 to 65535.');

// These overrides belong only to this process. Never seed synthetic evidence
// into the normal live server or let two servers own the same task database.
process.env.HAZE_EXECUTION_MODE = 'fixture';
process.env.HAZE_TASK_STATE_DIR = directory;
await mkdir(directory, { recursive: true });

const frontendRequire = createRequire(
  new URL('../frontend/package.json', import.meta.url),
);
const { createServer } = await import(
  pathToFileURL(frontendRequire.resolve('vite')).href
);
const server = await createServer({
  root: resolve(root, 'frontend'),
  configFile: resolve(root, 'frontend/vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true, open: false },
});
const origin = `http://127.0.0.1:${port}`;
let closing;
const close = () => (closing ??= server.close());
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });

async function request(path, body) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(60000),
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function settle(id) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const task = await request(`/api/tasks/${id}`);
    if (!['queued', 'running'].includes(task.status)) {
      assert.equal(
        task.status,
        'completed',
        JSON.stringify({
          status: task.status,
          error: task.error,
          questions: task.questions,
          assignments: task.assignments.map((assignment) => ({
            definition: assignment.definition_id,
            status: assignment.status,
            error: assignment.error,
            gaps: assignment.gaps,
          })),
        }),
      );
      return task;
    }
    if (Date.now() >= deadline)
      throw new Error(`Demo task ${id} did not complete within 60 seconds.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

try {
  await server.listen();
  console.log(
    'Synthetic damage demo: invented people, region and CU currency.',
  );
  console.log('1/2: Retaining the complete example in the demo World Model...');
  const input = createSyntheticDamageImport();
  const imported = await request('/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'synthetic-damage-demo.json',
    media_type: 'application/json',
    declared_origin:
      'Explicit synthetic demonstration. Invented quantities and CU currency; no empirical data.',
    content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
  });
  // The first API request initializes the storage marker. Auxiliary files must
  // follow initialization: an unmarked nonempty state directory is rejected.
  await writeFile(
    resolve(directory, 'synthetic-input.json'),
    `${JSON.stringify(input, null, 2)}\n`,
  );
  const source = imported.artifact ?? imported;
  const seed = await request('/api/tasks', {
    schema_version: 'haze.task.request.v3',
    objective: 'Build a damage account from retained source evidence.',
    context_refs: [
      { id: source.id, version: source.version, sha256: source.sha256 },
    ],
  });
  await settle(seed.task_id);

  console.log(
    '2/2: Building and independently checking a request-only account...',
  );
  const objective =
    'Build a damage account for Fixture Region for September to October 2015 using World Model.';
  const admission = await request('/api/tasks', {
    schema_version: 'haze.task.request.v3',
    objective,
  });
  const task = await settle(admission.task_id);
  assert.equal(task.mode, 'fixture');
  assert.deepEqual(task.original_request.context_refs, []);
  assert.equal(task.result?.review.status, 'supported');
  const artifacts = await Promise.all(
    task.artifacts.map(({ artifact }) =>
      request(`/api/artifacts/${artifact.id}`),
    ),
  );
  assert(
    artifacts.some((artifact) => artifact.kind === 'damage.world-selection'),
  );
  const accountArtifact = artifacts.find(
    (artifact) => artifact.kind === 'damage.account',
  );
  assert(
    accountArtifact,
    'The workflow must produce an actual damage account.',
  );
  const account = damageAccountSchema.parse(accountArtifact.content);
  assert.equal(account.evidence_origin, 'synthetic');
  const closeTo = (actual, expected) =>
    assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
  closeTo(
    account.welfare_totals.find((total) => total.scenario_id === 'historical')
      ?.amount,
    SYNTHETIC_DAMAGE_EXPECTATIONS.historical_loss,
  );
  const project = account.scenarios.find(
    (scenario) => scenario.scenario_id === 'project',
  );
  assert(project);
  for (const key of ['avoided_damage', 'project_cost', 'net_benefit'])
    closeTo(project[key], SYNTHETIC_DAMAGE_EXPECTATIONS[key]);
  closeTo(project.benefit_cost_ratio, 4.57);

  const url = `${origin}/damage-account/${task.id}`;
  await writeFile(
    resolve(directory, 'demo-report.json'),
    `${JSON.stringify(
      {
        synthetic: true,
        url,
        objective,
        seed_task_id: seed.task_id,
        task,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nOpen the completed demo: ${url}`);
  console.log(`Try the same request at: ${origin}/damage-account`);
  console.log(`Request: ${objective}`);
  console.log(`Demo state and exact results: ${directory}`);
  console.log('Independent review: supported. Benefit/cost ratio: 4.57.');
  console.log('Keep this process running to browse the demo. Ctrl+C stops it.');
} catch (error) {
  await close();
  console.error(error);
  process.exitCode = 1;
}
