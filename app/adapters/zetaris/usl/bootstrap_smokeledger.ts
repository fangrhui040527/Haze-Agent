#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZETARIS_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROJECT_ROOT = path.resolve(ZETARIS_ROOT, '..', '..', '..');
const RUN_SQL = path.join(ZETARIS_ROOT, 'scripts', 'run_sql.py');
const REGISTER_SQL = path.join(
  ZETARIS_ROOT,
  'legacy',
  'smokeledger',
  'sql',
  '02_zetaris_register.sql',
);
const USL_SCHEMA_SQL = path.join(SCRIPT_DIR, 'smokeledger_usl', 'usl_schema.sql');
const USL_ACTIVATE_SQL = path.join(SCRIPT_DIR, 'smokeledger_usl', 'usl_activate.sql');
const VERIFY_SQL = path.join(
  SCRIPT_DIR,
  'smokeledger_usl',
  'smokeledger_queries.sql',
);
const PYTHON_BIN =
  process.env['PYTHON_BIN'] ??
  (process.platform === 'win32' ? 'python' : 'python3');

interface Options {
  dryRun: boolean;
  skipDatabaseInit: boolean;
  skipActivation: boolean;
}

function parseArgs(args: string[]): Options {
  const unknown = args.filter(
    (argument) =>
      !['--dry-run', '--skip-db-init', '--skip-activation', '--help', '-h'].includes(
        argument,
      ),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown.join(', ')}`);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`SmokeLedger Zetaris bootstrap

Usage:
  node --experimental-strip-types app/adapters/zetaris/usl/bootstrap_smokeledger.ts [options]

Options:
  --dry-run          Preview SQL and database setup without running anything
  --skip-db-init     Do not start the local PostgreSQL service
  --skip-activation  Register and compile, but do not populate USL tables
  -h, --help         Show this help`);
    process.exit(0);
  }
  return {
    dryRun: args.includes('--dry-run'),
    skipDatabaseInit: args.includes('--skip-db-init'),
    skipActivation: args.includes('--skip-activation'),
  };
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.on('error', (error: Error) => reject(error));
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with code ${String(code)}.`,
          ),
        );
      }
    });
  });
}

async function runSql(
  name: string,
  file: string,
  dryRun: boolean,
  skipExists = false,
): Promise<void> {
  if (!existsSync(file)) {
    throw new Error(`Required SQL file does not exist: ${file}`);
  }
  console.log(`\n=== ${name} ===`);
  const args = [RUN_SQL];
  if (skipExists) {
    args.push('--skip-exists');
  }
  if (dryRun) {
    args.push('--dry-run');
  }
  args.push(file);
  await run(PYTHON_BIN, args, ZETARIS_ROOT);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log('Legacy PostgreSQL SmokeLedger bootstrap. Current ingestion uses zetaris:bootstrap:sources.');
  if (!options.skipDatabaseInit) {
    if (options.dryRun) {
      console.log(
        '[DRY-RUN] Would run npm run db:init from the project root.',
      );
    } else {
      console.log('\n=== Start local SmokeLedger PostgreSQL ===');
      await run(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['run', 'db:init'],
        PROJECT_ROOT,
      );
    }
  }

  await runSql(
    'Register PostgreSQL datasource and tables',
    REGISTER_SQL,
    options.dryRun,
    true,
  );
  await runSql(
    'Compile SmokeLedger USL schema',
    USL_SCHEMA_SQL,
    options.dryRun,
    true,
  );

  if (!options.skipActivation) {
    await runSql(
      'Activate SmokeLedger USL tables from sl_pg',
      USL_ACTIVATE_SQL,
      options.dryRun,
    );
    await runSql('Verify SmokeLedger USL queries', VERIFY_SQL, options.dryRun);
  }

  console.log(
    options.dryRun
      ? '\nDry run complete; no database or Zetaris changes were made.'
      : '\nSmokeLedger bootstrap completed.',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`SmokeLedger bootstrap failed: ${message}`);
  process.exitCode = 1;
});
