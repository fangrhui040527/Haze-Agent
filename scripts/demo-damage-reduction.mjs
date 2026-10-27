import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../dist/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';
import { syntheticReductionCandidate } from '../dist/capabilities/damage-reduction-planning/planning-fixtures.js';
import { reductionPreviewViewSchema } from '../dist/contracts/damage-reduction-view.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.state/damage-reduction-demo', randomUUID());
const port = Number(process.env.HAZE_REDUCTION_DEMO_PORT ?? 5175);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('HAZE_REDUCTION_DEMO_PORT must be a port from 1 to 65535.');

// Keep invented evidence in a fresh fixture store owned only by this process.
process.env.HAZE_EXECUTION_MODE = 'fixture';
process.env.HAZE_TASK_STATE_DIR = directory;
process.env.VITE_API_BASE_URL = '';
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
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(data)}`);
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
    'Synthetic damage reduction demo: invented physical quantities and a proposed alert service.',
  );
  console.log('1/2: Importing the synthetic residual estimates...');
  const input = syntheticResidualImport();
  const imported = await request('/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: 'synthetic-reduction-demo.json',
    media_type: 'application/json',
    declared_origin:
      'Explicit synthetic demonstration. Invented physical residuals and proposed alert service; no empirical data or delivered intervention.',
    content_base64: Buffer.from(JSON.stringify(input)).toString('base64'),
  });
  // Initialize the runtime marker before adding auxiliary files to its store.
  await writeFile(
    resolve(directory, 'synthetic-input.json'),
    `${JSON.stringify(input, null, 2)}\n`,
  );
  const source = exactReductionRef(imported.artifact ?? imported);
  const taskRequest = {
    schema_version: 'haze.task.request.v3',
    objective:
      'Prepare a conditional damage-reduction planning preview for the proposed digital alert service. Retain the physical target, sources, scientific prerequisites and independent arithmetic and plan reviews.',
    scope: {
      schema_version: 'haze.reduction.preview-request.v1',
      selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
        { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
      ]),
      candidate: syntheticReductionCandidate(),
    },
    context_refs: [source],
  };
  console.log('2/2: Calculating and independently reviewing the preview...');
  const admission = await request('/api/tasks', taskRequest);
  const task = await settle(admission.task_id);
  assert.equal(task.mode, 'fixture');
  const preview = reductionPreviewViewSchema.parse(
    await request(`/api/tasks/${task.id}/views/reduction-preview`),
  );
  assert.equal(preview.state, 'current');
  assert.equal(preview.assessment?.value.origin, 'synthetic');
  assert.equal(preview.assessment.value.status, 'supported');
  assert.equal(preview.assessment.value.baseline_damage, '1000');
  assert.equal(preview.assessment.value.intervention_damage, '880');
  assert.equal(preview.assessment.value.absolute_reduction, '120');
  const relative = preview.assessment.value.relative_reduction;
  assert(relative);
  assert.equal(Number(relative.numerator) / Number(relative.denominator), 0.12);
  assert.equal(preview.assessment.value.target_met, true);
  assert.equal(preview.arithmetic_review?.value.verdict, 'supported');
  assert.equal(preview.plan_eligibility, 'conditional');
  assert.equal(preview.plan?.value.state, 'conditional');
  assert.equal(preview.plan.value.scientific_qualification, 'unqualified');
  assert.equal(preview.plan.value.delivery_status, 'not_delivered');
  assert.equal(preview.plan.value.achieved_reduction, false);
  assert.equal(preview.plan_review?.value.verdict, 'supported');
  const artifacts = await Promise.all(
    task.artifacts.map(({ artifact }) =>
      request(`/api/artifacts/${artifact.id}`),
    ),
  );

  const url = `${origin}/damage-reduction/tasks/${task.id}`;
  await writeFile(
    resolve(directory, 'demo-report.json'),
    `${JSON.stringify(
      {
        synthetic: true,
        url,
        request: taskRequest,
        task,
        preview,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nOpen the completed demo: ${url}`);
  console.log(`Create another preview at: ${origin}/damage-reduction`);
  console.log(
    'Choose "Load synthetic engineering example", then "Create conditional preview".',
  );
  console.log(`Demo state and exact results: ${directory}`);
  console.log(
    'Baseline: 1000 person-days. Intervention: 880. Reduction: 12%, meeting the 10% target.',
  );
  console.log(
    'Independent arithmetic and plan reviews: supported. Plan: conditional.',
  );
  console.log('Keep this process running to browse the demo. Ctrl+C stops it.');
} catch (error) {
  await close();
  console.error(error);
  process.exitCode = 1;
}
