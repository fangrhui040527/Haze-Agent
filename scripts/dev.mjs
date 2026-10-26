import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start local development with npm run dev.');

console.log('\n  Preparing Haze Agent...');
const build = spawnSync(
  process.execPath,
  [npmCli, '--silent', 'run', 'build'],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  },
);
if (build.status !== 0) {
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.error) console.error(build.error);
  process.exit(build.status ?? 1);
}
if (build.stderr) process.stderr.write(build.stderr);

const frontendRequire = createRequire(
  new URL('../frontend/package.json', import.meta.url),
);
const viteCli = resolve(
  dirname(frontendRequire.resolve('vite/package.json')),
  'bin/vite.js',
);
const server = spawn(process.execPath, [viteCli, ...process.argv.slice(2)], {
  cwd: resolve(root, 'frontend'),
  stdio: 'inherit',
  env: {
    ...process.env,
    HAZE_DEV_BANNER: 'true',
    HAZE_DEV_STARTED_AT: String(startedAt),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1);
});
