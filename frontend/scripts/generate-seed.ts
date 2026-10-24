/**
 * Regenerates the committed demo dataset.
 *
 *   npm run data:generate                    (defaults: seed 2026, 240 items)
 *   npm run data:generate -- --seed 7 --items 400
 *   npm run data:generate -- --coverage worldwide   (default: asean)
 *
 * Writes public/demo-data/demo-data.seed.json. The app loads that file on start.
 * Everything in it is fictional.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateDataset } from '../src/mock/generator/generate.ts';
import { COVERAGES, type Coverage } from '../src/mock/generator/locations.ts';
import { validateDataset } from '../src/mock/generator/validate.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '2026' },
    items: { type: 'string', default: '240' },
    coverage: { type: 'string', default: 'asean' },
  },
});

const seed = Number(values.seed);
const itemCount = Number(values.items);
const coverage = values.coverage as Coverage;
if (
  !Number.isInteger(seed) ||
  !Number.isInteger(itemCount) ||
  itemCount < 1 ||
  !COVERAGES.includes(coverage)
) {
  console.error(
    'Usage: npm run data:generate -- --seed <integer> --items <positive integer> --coverage <asean|worldwide>',
  );
  process.exit(1);
}

const dataset = generateDataset({
  seed,
  itemCount,
  now: new Date(),
  coverage,
});
const check = validateDataset(dataset);
if (!check.ok) {
  console.error(
    'Generated data failed validation:\n' + check.errors.join('\n'),
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '../public/demo-data/demo-data.seed.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(dataset, null, 2) + '\n', 'utf8');

const kb = Math.round(
  Buffer.byteLength(JSON.stringify(dataset, null, 2)) / 1024,
);
console.log(
  `Wrote ${outFile}\n` +
    `  seed ${seed} · ${coverage} · ${dataset.items.length} items · ${dataset.locations.length} locations · ` +
    `${dataset.sources.length} sources · ${kb} KB · ${check.warnings.length} warning(s) (expected: edge cases)`,
);
