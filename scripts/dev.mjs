import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createStartupDisplay } from './dev-status.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start local development with npm run dev.');

let activeChild;
let stopping = false;
const display = createStartupDisplay();

function stop(signal) {
  stopping = true;
  process.exitCode = 0;
  activeChild?.kill(signal);
}
const onInterrupt = () => stop('SIGINT');
const onTerminate = () => stop('SIGTERM');

function runCommand(
  command,
  args,
  { ipc, onMessage, onOutput, ...options } = {},
) {
  return new Promise((resolveCommand, reject) => {
    let stdout = '';
    let stderr = '';
    const decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const pending = { stdout: '', stderr: '' };
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
      ...options,
    });
    activeChild = child;
    const capture = (stream, text) => {
      // Keep bounded diagnostics even during a large first-time image pull.
      if (stream === 'stdout')
        stdout = (stdout + text).slice(-10 * 1024 * 1024);
      else stderr = (stderr + text).slice(-10 * 1024 * 1024);
      if (onOutput) {
        const lines = (pending[stream] + text).split('\n');
        pending[stream] = lines.pop().slice(-10 * 1024 * 1024);
        if (lines.length) onOutput(`${lines.join('\n')}\n`);
      }
    };
    child.stdout.on('data', (chunk) =>
      capture('stdout', decoders.stdout.write(chunk)),
    );
    child.stderr.on('data', (chunk) =>
      capture('stderr', decoders.stderr.write(chunk)),
    );
    if (onMessage) child.on('message', onMessage);
    child.once('error', (error) =>
      reject(Object.assign(error, { output: stdout + stderr })),
    );
    child.once('close', (code, signal) => {
      for (const stream of ['stdout', 'stderr']) {
        capture(stream, decoders[stream].end());
        if (pending[stream]) onOutput?.(pending[stream]);
      }
      if (activeChild === child) activeChild = undefined;
      if (code === 0 || stopping) resolveCommand({ stdout, stderr });
      else
        reject(
          Object.assign(
            new Error(
              signal
                ? `${command} stopped by ${signal}.`
                : `${command} exited with code ${code}.`,
            ),
            { exitCode: code ?? 1, output: stdout + stderr },
          ),
        );
    });
  });
}

async function main() {
  let stage = 0;
  let stageStartedAt;
  let frontendReady = false;
  let frontendOutput = '';
  let startupSeconds;
  const starting = (index) => {
    stage = index;
    stageStartedAt = Date.now();
    display.update(stage, 'STARTING');
  };
  const finished = (status, detail = '') => {
    const seconds = ((Date.now() - stageStartedAt) / 1000).toFixed(1);
    display.update(
      stage,
      status,
      [detail, `${seconds}s`].filter(Boolean).join(' | '),
    );
  };

  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    starting(0);
    // Capture Compose progress so the panel is the only terminal renderer.
    // Whole-project --wait does not handle the standalone bootstrap job.
    const docker = await runCommand('docker', [
      'compose',
      '--progress',
      'plain',
      'up',
      '--detach',
    ]);
    if (stopping) return;
    const status = await runCommand('docker', [
      'compose',
      'ps',
      '--all',
      '--format',
      'json',
    ]);
    if (stopping) return;
    const text = status.stdout.trim();
    const containers = !text
      ? []
      : text.startsWith('[')
        ? JSON.parse(text)
        : text.split(/\r?\n/).map((line) => JSON.parse(line));
    const counts = new Map();
    for (const container of containers) {
      const state =
        container.State === 'exited' && container.ExitCode === 0
          ? 'completed'
          : container.Health || container.State;
      if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    finished(
      'STARTED',
      [...counts].map(([state, count]) => `${count} ${state}`).join(', '),
    );
    const warnings = docker.stderr
      .split(/\r?\n/)
      .filter((line) => /\bwarn(?:ing)?\b/i.test(line));
    if (warnings.length) display.log(warnings.join('\n'));

    starting(1);
    const build = await runCommand(process.execPath, [
      npmCli,
      '--silent',
      'run',
      'build',
    ]);
    if (stopping) return;
    if (build.stderr) display.log(build.stderr);
    finished('READY');

    starting(2);
    const frontendRequire = createRequire(
      new URL('../frontend/package.json', import.meta.url),
    );
    const viteCli = resolve(
      dirname(frontendRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    await runCommand(process.execPath, [viteCli, ...process.argv.slice(2)], {
      cwd: resolve(root, 'frontend'),
      ipc: true,
      onMessage(message) {
        if (message?.type !== 'haze-dev-ready' || stopping) return;
        if (!frontendReady) {
          frontendReady = true;
          finished('READY');
          startupSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
          if (frontendOutput) display.log(frontendOutput);
          frontendOutput = '';
        }
        display.urls(
          message.local ?? [],
          message.network ?? [],
          startupSeconds,
        );
      },
      onOutput(text) {
        if (frontendReady) display.log(text);
        else frontendOutput = (frontendOutput + text).slice(-10 * 1024 * 1024);
      },
      env: {
        ...process.env,
        HAZE_DEV_BANNER: 'true',
        HAZE_DEV_STARTED_AT: String(startedAt),
      },
    });
    if (!frontendReady && frontendOutput) display.log(frontendOutput);
    if (!stopping) finished('STOPPED');
  } catch (error) {
    if (stopping) return;
    finished('FAILED');
    for (let next = stage + 1; next < 3; next++)
      display.update(next, 'SKIPPED');
    if (error.output && (stage !== 2 || !frontendReady))
      display.log(error.output);
    display.log(error.message);
    if (stage === 0)
      display.log(
        '  Check Docker Desktop is running and root .env / image registry access are configured.\n  Inspect Zetaris with: docker compose ps --all / docker compose logs --tail 100',
      );
    process.exitCode = error.exitCode ?? 1;
  } finally {
    if (stopping) {
      finished(frontendReady ? 'STOPPED' : 'CANCELLED');
      for (let next = stage + 1; next < 3; next++)
        display.update(next, 'SKIPPED');
    }
    display.close();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

await main();
