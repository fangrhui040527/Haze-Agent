#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZETARIS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = {
  pm25: 'air_quality/fetch_air_quality.ts',
  wind: 'wind/fetch_wind.ts',
  firms: 'nasa_firms/fetch_nasa_firms.ts',
} as const;
type Source = keyof typeof SOURCES;

interface Options {
  sources: Source[];
  locations: string[];
  dryRun: boolean;
  skipApi: boolean;
}

function parseArgs(args: string[]): Options {
  const sources: Source[] = [];
  const locations: string[] = [];
  let dryRun = false;
  let skipApi = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--skip-api') skipApi = true;
    else if (argument === '--source' || argument === '--location') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} requires a value.`);
      if (argument === '--location') locations.push(value);
      else {
        if (!Object.hasOwn(SOURCES, value))
          throw new Error(`Unknown source: ${value}. Choose pm25, wind or firms.`);
        sources.push(value as Source);
      }
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Zetaris source bootstrap

Registers and publishes source snapshots directly to the running Zetaris driver.
No PostgreSQL database or USL activation is needed by the PM2.5 task.

Options:
  --source pm25|wind|firms  Select a source; repeatable, defaults to all three
  --location ID            Limit locations; repeatable, defaults to all
  --dry-run                Preview actions and SQL without fetching or publishing
  --skip-api               Republish an existing local snapshot

Example:
  npm run zetaris:bootstrap:sources -- --source pm25 --location kuala-lumpur --dry-run`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return {
    sources: [...new Set(sources.length ? sources : (Object.keys(SOURCES) as Source[]))],
    locations: [...new Set(locations)],
    dryRun,
    skipApi,
  };
}

async function runSource(source: Source, options: Options): Promise<void> {
  const args = [
    '--experimental-strip-types',
    path.join(ZETARIS_ROOT, 'sources', SOURCES[source]),
    ...options.locations.flatMap((location) => ['--location', location]),
    ...(options.dryRun ? ['--dry-run'] : []),
    ...(options.skipApi ? ['--skip-api'] : []),
  ];
  console.log(`\n=== Zetaris source: ${source} ===`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ZETARIS_ROOT,
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Source ${source} exited with code ${String(code)}.`));
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  for (const source of options.sources) await runSource(source, options);
  console.log(options.dryRun ? '\nPreview complete; no source data changed.' : '\nSource snapshots published to Zetaris.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
