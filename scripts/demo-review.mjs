import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  generateDemoReviewPackage,
  validateDemoReviewPackage,
} from '../dist/demo/review-trace.js';
import { parseContractJson, contractHash } from '../dist/contracts/index.js';

const output = new URL('../examples/demo-review/', import.meta.url);
const artifactPath = new URL('package.json', output);
const command = process.argv[2];

try {
  if (process.argv.length !== 3 || !['generate', 'check'].includes(command))
    throw new Error('Usage: node scripts/demo-review.mjs generate|check');
  const value =
    command === 'generate'
      ? generateDemoReviewPackage()
      : parseContractJson(await readFile(artifactPath, 'utf8'));
  const report = validateDemoReviewPackage(value);
  if (command === 'generate') {
    await mkdir(output, { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      ...report,
      package_sha256: contractHash(value),
      artifact: fileURLToPath(artifactPath),
      checked:
        'immutable bytes, v2 interfaces, interval integration, independent minute-cell reproduction, five cross-workstream traces and negative examples',
      workerShield_agent: 'not_run',
      human_review: 'pending',
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      valid: false,
      code: error.message,
      details: error.issues ?? null,
    }),
  );
  process.exitCode = 1;
}
