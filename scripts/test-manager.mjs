import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  managerRepositoryRoot as root,
  runManagerTool as run,
  checkManagerTypes,
  buildManagerRuntime,
} from './manager-build.mjs';
import {
  parseManagerEvaluationArgs,
  selectManagerCases,
} from './manager-evaluation-support.mjs';

const args = process.argv.slice(2);
if (!['--scripted', '--live', '--list'].includes(args[0]))
  args.unshift('--scripted');
const options = parseManagerEvaluationArgs(args);
if (options.baselineRoot !== undefined || options.buildRoot !== undefined)
  throw new Error(
    'manager:test always creates a fresh supervised build. Use manager:evaluate for --baseline or --build-root.',
  );
const frozen = JSON.parse(
  await readFile(
    join(root, 'docs/orchestration/manager-evaluation-cases.json'),
    'utf8',
  ),
);
const cases = selectManagerCases(frozen.cases, options);

if (options.mode === 'list') {
  run(join(root, 'scripts/evaluate-manager.mjs'), ['--list']);
} else {
  console.log(
    `Manager isolation: ${options.mode} decisions, synthetic specialists, ${cases.length} scenario(s).`,
  );
  checkManagerTypes();
  run(join(root, 'node_modules/vitest/vitest.mjs'), [
    'run',
    '--project',
    'unit',
    'tests/unit/manager-',
  ]);

  const buildRoot = await buildManagerRuntime({
    mode: options.mode,
    cases: cases.map((entry) => entry.id),
  });
  run(join(root, 'scripts/evaluate-manager.mjs'), [
    `--${options.mode}`,
    '--build-root',
    buildRoot,
    ...(options.caseId === undefined ? [] : ['--case', options.caseId]),
  ]);
}
