import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = (value) =>
  !['', '0', 'false'].includes(value?.trim().toLowerCase() ?? '');
const readInput = async (path) =>
  JSON.parse(await readFile(resolve(path), 'utf8'));

/** Selects an entry point by mode/contract; filenames never select results. */
export async function selectStartTarget(args, env, readJson = readInput) {
  if (enabled(env.SAMPLE_MODE))
    return {
      entry: 'run-samples.mjs',
      args: args.length ? [...args] : ['--all'],
    };
  if (['--all', '--list'].includes(args[0]))
    return { entry: 'run-samples.mjs', args: [...args] };
  if (args[0] && !args[0].startsWith('--')) {
    const input = await readJson(args[0]);
    if (
      ['haze.sample.request.v1', 'haze.task.request.v3'].includes(
        input?.schema_version,
      )
    )
      return { entry: 'run-samples.mjs', args: [...args] };
  }
  return { entry: 'run-example.mjs', args: [...args] };
}

async function launch(target, env) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(target.entry, import.meta.url)), ...target.args],
    {
      env,
      stdio: 'inherit',
    },
  );
  const onInterrupt = () => child.kill('SIGINT');
  const onTerminate = () => child.kill('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    return await new Promise((ready, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => ready(code ?? 1));
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

export async function runStart(args, env, options = {}) {
  const target = await selectStartTarget(
    args,
    env,
    options.readJson ?? readInput,
  );
  return (options.launch ?? launch)(target, env);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runStart(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
