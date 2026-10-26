import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const managerRepositoryRoot = fileURLToPath(
  new URL('../', import.meta.url),
);

export function runManagerTool(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: managerRepositoryRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Manager check failed (exit ${result.status ?? 1}): ${script}`,
    );
}

export function checkManagerTypes() {
  console.log('Checking Manager types independently of specialist components.');
  runManagerTool(
    join(managerRepositoryRoot, 'node_modules/typescript/bin/tsc'),
    ['-p', join(managerRepositoryRoot, 'tsconfig.manager.json'), '--noEmit'],
  );
}

export async function buildManagerRuntime(metadata = {}) {
  const builds = join(managerRepositoryRoot, '.state/manager-isolation');
  await mkdir(builds, { recursive: true });
  const buildRoot = await mkdtemp(join(builds, 'run-'));
  const output = join(buildRoot, 'dist');
  console.log(`Transpiling the Manager and shared test runtime into ${output}`);
  runManagerTool(
    join(managerRepositoryRoot, 'node_modules/typescript/bin/tsc'),
    [
      '-p',
      join(managerRepositoryRoot, 'tsconfig.manager-runtime.json'),
      '--outDir',
      output,
    ],
  );
  const agents = await readdir(join(output, 'agents'));
  if (agents.length !== 1 || agents[0] !== 'manager')
    throw new Error(
      `Manager build included another agent implementation: ${agents.join(', ')}`,
    );
  await writeFile(
    join(buildRoot, 'build.json'),
    JSON.stringify(
      {
        ...metadata,
        built_at: new Date().toISOString(),
        node: process.version,
        manager_typecheck_config: join(
          managerRepositoryRoot,
          'tsconfig.manager.json',
        ),
        runtime_transpile_config: join(
          managerRepositoryRoot,
          'tsconfig.manager-runtime.json',
        ),
        shared_runtime_typechecked: false,
        agent_implementations: agents,
      },
      null,
      2,
    ) + '\n',
  );
  return buildRoot;
}
