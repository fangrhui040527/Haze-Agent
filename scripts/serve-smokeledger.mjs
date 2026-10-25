import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Runs the SmokeLedger sidecar on loopback. SmokeLedger reads smokeledger/.env;
// the root .env shares key names with different meanings (STATE_DIR, SAMPLE_MODE,
// PORT), so only process essentials are passed through, never root settings.
const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--sample'))
  throw new Error('Usage: serve-smokeledger.mjs [--sample]');
const sample = flags.includes('--sample');
const cwd = resolve('smokeledger');
if (
  !existsSync(resolve(cwd, 'node_modules')) ||
  !existsSync(resolve(cwd, 'vendor'))
)
  throw new Error(
    'SmokeLedger is not installed. Run: npm run smokeledger:install',
  );

const passthrough = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'APPDATA',
  'USERPROFILE',
];
const env = Object.fromEntries(
  passthrough.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
env.HOST = '127.0.0.1';
env.PORT = process.env.SMOKELEDGER_PORT || '8100';
// Sample state stays apart from live state so fictional rows never mix with real ones.
if (sample)
  Object.assign(env, { SAMPLE_MODE: 'true', STATE_DIR: '.state-demo' });

const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  cwd,
  env,
  stdio: 'inherit',
});
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => child.kill(name));
child.on('exit', (code) => process.exit(code ?? 1));
