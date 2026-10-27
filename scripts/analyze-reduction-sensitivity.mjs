import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { artifactSchema } from '../dist/contracts/artifacts.js';
import { contractHash, parseContractJson } from '../dist/contracts/json.js';
import { reductionSensitivityRequestSchema } from '../dist/contracts/damage-reduction-sensitivity.js';
import { analyzeReductionSensitivity } from '../dist/capabilities/damage-reduction-planning/sensitivity.js';
import { createReductionCapacityFixture } from '../dist/capabilities/damage-reduction-planning/capacity-fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../dist/capabilities/damage-reduction-planning/inputs.js';

const args = process.argv.slice(2);
if (
  !(args.length === 1 && args[0] === '--demo') &&
  !(args.length === 2 && args[0] === '--input')
)
  throw new Error(
    'Usage: analyze-reduction-sensitivity.mjs --demo | --input INPUT.json',
  );
let text;
if (args[0] === '--demo') {
  const first = createReductionCapacityFixture(2, 1);
  const second = createReductionCapacityFixture(2, 1);
  const content = second.artifacts[0].content;
  content.records[1].quantity = '95';
  second.artifacts[0].sha256 = contractHash(content);
  second.selection = createReductionSelection(second.target, [
    {
      artifact: exactReductionRef(second.artifacts[0]),
      row_ids: ['r0', 'r1'],
    },
  ]);
  text = JSON.stringify({
    request: {
      schema_version: 'haze.reduction.sensitivity-request.v1',
      target: first.target,
      assumptions:
        'Entirely synthetic example: supplied nominal and lower-effect paired scenarios; no empirical probabilities or scientific qualification.',
      pairs: [
        {
          id: 'nominal',
          label: 'Synthetic 12% reduction',
          sources: first.selection.sources,
        },
        {
          id: 'lower-effect',
          label: 'Synthetic 5% reduction',
          sources: second.selection.sources,
        },
      ],
    },
    artifacts: [...first.artifacts, ...second.artifacts],
  });
} else {
  const file = resolve(args[1]);
  if ((await stat(file)).size > 8_388_608)
    throw new Error('Sensitivity input exceeds 8 MiB.');
  text = await readFile(file, 'utf8');
}
const input = z
  .strictObject({
    request: reductionSensitivityRequestSchema,
    artifacts: z.array(artifactSchema).min(1).max(16),
  })
  .parse(parseContractJson(text, 8_388_608));
const report = analyzeReductionSensitivity(input.request, input.artifacts);
const root = resolve(
  process.env.STATE_DIR || '.state',
  'reduction-sensitivity',
  randomUUID(),
);
await mkdir(root, { recursive: true });
await writeFile(resolve(root, 'input.json'), text);
const path = resolve(root, 'report.json');
await writeFile(
  path,
  `${JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      input_byte_sha256: createHash('sha256').update(text).digest('hex'),
      ...report,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    {
      report: path,
      origin: report.origin,
      conclusion: report.conclusion,
      scientific_qualification: report.scientific_qualification,
      probability_of_target: report.probability_of_target,
    },
    null,
    2,
  ),
);
if (report.conclusion === 'incomplete') process.exitCode = 2;
