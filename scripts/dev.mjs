import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStartupDisplay } from './dev-status.mjs';
import { STARTUP_COMPONENTS } from './dev-readiness.mjs';
import { createDevConsole } from './dev-console.mjs';
import { createDevCommands, localAppUrl } from './dev-commands.mjs';
import { createDevApi } from './dev-api.mjs';
import { createDevConfig } from './dev-config.mjs';
import { createSmokeLedgerSidecar } from './dev-smokeledger.mjs';
import {
  runDevTool,
  terminateDevChild,
  composeServiceState,
} from './dev-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = Date.now();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start local development with npm run dev.');
const args = process.argv.slice(2);
if (args.includes('--console') && args.includes('--no-console'))
  throw new Error('Choose either --console or --no-console.');
const viteArgs = args.filter(
  (arg) => !['--console', '--no-console', '--no-smokeledger'].includes(arg),
);
const withSmokeLedger = !args.includes('--no-smokeledger');

let activeChild;
let appChild;
let stopping = false;
let stopContainers = false;
let consoleSession;
let appUrl;
let stopTimer;
let runtimeLog = '';
const logSubscribers = new Set();
const pendingCommands = new Map();
const probeController = new AbortController();
const interactive =
  args.includes('--console') ||
  (!args.includes('--no-console') &&
    Boolean(
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.env.TERM !== 'dumb',
    ));
const config = createDevConfig({ root });
const launchEnvironment = config.launchEnvironment();
const sampleMode = !['', '0', 'false'].includes(
  launchEnvironment.SAMPLE_MODE?.trim().toLowerCase() ?? '',
);
const api = createDevApi({ getUrl: () => appUrl });
const display = createStartupDisplay({ commands: interactive });
const log = (text) => {
  const message = config.redact(String(text));
  if (consoleSession) consoleSession.log(message);
  else display.log(message);
};
const appendRuntimeLog = (text) => {
  runtimeLog = (runtimeLog + text)
    .slice(-128 * 1024)
    .split('\n')
    .slice(-300)
    .join('\n');
  for (const listener of logSubscribers) listener(config.redact(text));
};
const smokeLedgerRow = STARTUP_COMPONENTS.findIndex(
  (component) => component.id === 'smokeledger',
);
const smokeLedger = createSmokeLedgerSidecar({
  root,
  npmCli,
  signal: probeController.signal,
  onStatus(status, detail) {
    display.update(smokeLedgerRow, status, config.redact(detail ?? ''));
    // The panel closes once the console opens; a late first-time install reports here.
    if (consoleSession && status !== 'STARTING')
      log(`SmokeLedger sidecar: ${status}${detail ? ` | ${detail}` : ''}`);
  },
  onOutput: appendRuntimeLog,
});

function appCommand(command, signal) {
  return new Promise((resolveCommand, reject) => {
    if (!appChild?.connected)
      return reject(
        new Error('The app IPC channel is unavailable. Restart npm run dev.'),
      );
    if (signal?.aborted) return reject(signal.reason);
    const id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      pendingCommands.delete(id);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`App ${command} timed out. Inspect logs app.`));
    }, 20_000);
    pendingCommands.set(id, (message) => {
      cleanup();
      if (message.ok) resolveCommand();
      else reject(new Error(message.error ?? `App ${command} failed.`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    appChild.send({ type: 'haze-dev-command', id, command }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

function stop(signal = 'SIGINT', { all = false } = {}) {
  if (stopping) return;
  stopping = true;
  stopContainers = all;
  process.exitCode = 0;
  probeController.abort();
  consoleSession?.close();
  smokeLedger.stop(signal);
  if (appChild?.connected) {
    const child = appChild;
    stopTimer = setTimeout(() => terminateDevChild(child, 'SIGKILL'), 12_000);
    stopTimer.unref();
    void appCommand('stop').catch(() => terminateDevChild(child, 'SIGKILL'));
  } else terminateDevChild(activeChild, signal);
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
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [
        ipc && interactive ? 'ignore' : 'inherit',
        'pipe',
        'pipe',
        ...(ipc ? ['ipc'] : []),
      ],
      ...options,
    });
    activeChild = child;
    if (ipc) appChild = child;
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
      if (appChild === child) {
        appChild = undefined;
        clearTimeout(stopTimer);
        for (const complete of [...pendingCommands.values()])
          complete({ ok: false, error: 'The app process stopped.' });
      }
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
  let startupProbe;
  const commands = createDevCommands({
    root,
    getUrl: () => appUrl,
    api,
    config,
    restart: async (signal) => {
      await appCommand('restart', signal);
      await api.execute(['status', 'app'], { signal });
    },
    stop: (options) => stop('SIGINT', options),
    getLogs: () => config.redact(runtimeLog),
    subscribeLogs: (listener) => {
      logSubscribers.add(listener);
      return () => logSubscribers.delete(listener);
    },
  });
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
    if (sampleMode) {
      finished(
        'SKIPPED',
        'Sample evidence from data/; Docker and Zetaris are not required',
      );
    } else {
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
        const state = container.Health || composeServiceState(container);
        if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
      }
      finished(
        'STARTED',
        [...counts].map(([state, count]) => `${count} ${state}`).join(', '),
      );
      const warnings = docker.stderr
        .split(/\r?\n/)
        .filter((line) => /\bwarn(?:ing)?\b/i.test(line));
      if (warnings.length) log(warnings.join('\n'));
    }

    // Starts alongside the build; its row reports independently of the stages below.
    if (withSmokeLedger) void smokeLedger.start();
    else display.update(smokeLedgerRow, 'DISABLED', '--no-smokeledger');

    starting(1);
    const build = await runCommand(process.execPath, [
      npmCli,
      '--silent',
      'run',
      'build',
    ]);
    if (stopping) return;
    if (build.stderr) log(build.stderr);
    finished('BUILT', 'Haze tasks, World Model and connectors compiled');

    starting(2);
    const frontendRequire = createRequire(
      new URL('../frontend/package.json', import.meta.url),
    );
    const viteCli = resolve(
      dirname(frontendRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    await runCommand(process.execPath, [viteCli, ...viteArgs], {
      cwd: resolve(root, 'frontend'),
      ipc: true,
      onMessage(message) {
        if (message?.type === 'haze-dev-command-result') {
          pendingCommands.get(message.id)?.(message);
          return;
        }
        if (message?.type !== 'haze-dev-ready' || stopping) return;
        const local = (message.local ?? []).find((url) => {
          try {
            localAppUrl(url);
            return true;
          } catch {
            return false;
          }
        });
        const previousUrl = appUrl;
        if (local) appUrl = local;
        if (!frontendReady) {
          frontendReady = true;
          // Initialize the shared runtime and watchers even before a browser opens.
          startupProbe = api
            .startupChecks({
              signal: probeController.signal,
              onStart(id) {
                display.update(
                  STARTUP_COMPONENTS.findIndex(
                    (component) => component.id === id,
                  ),
                  'CHECKING',
                );
              },
              onResult(result) {
                const seconds =
                  result.id === 'web'
                    ? ((Date.now() - stageStartedAt) / 1000).toFixed(1)
                    : result.seconds;
                display.update(
                  STARTUP_COMPONENTS.findIndex(
                    (component) => component.id === result.id,
                  ),
                  result.status,
                  `${config.redact(result.detail)} | ${seconds}s`,
                );
              },
            })
            .then((results) => {
              if (stopping) return;
              const failed = results.find(
                (result) =>
                  ['web', 'tasks'].includes(result.id) &&
                  result.status !== 'READY',
              );
              if (failed)
                throw new Error(
                  `${STARTUP_COMPONENTS.find((component) => component.id === failed.id).label}: ${failed.detail}`,
                );
              startupSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
              if (frontendOutput) log(frontendOutput);
              frontendOutput = '';
              display.urls(
                message.local ?? [],
                message.network ?? [],
                startupSeconds,
              );
              if (interactive && appChild) {
                display.close();
                consoleSession = createDevConsole({
                  execute: commands.execute,
                  configKeys: config.keys,
                  redact: config.redact,
                  onExit: () => stop(),
                });
              }
            })
            .catch((error) => {
              if (!stopping) {
                log(error.message);
                stop();
                process.exitCode = 1;
              }
            });
        } else {
          if (consoleSession && appUrl !== previousUrl)
            log(`App listening at ${appUrl}`);
          else if (startupSeconds)
            display.urls(
              message.local ?? [],
              message.network ?? [],
              startupSeconds,
            );
          // Vite can also restart after a configuration edit without a browser.
          void api
            .execute(['status', 'app'], { signal: probeController.signal })
            .catch((error) => {
              if (!stopping) log(`App API: ${error.message}`);
            });
        }
      },
      onOutput(text) {
        appendRuntimeLog(text);
        if (frontendReady && !logSubscribers.size) log(text);
        else if (!frontendReady)
          frontendOutput = (frontendOutput + text).slice(-10 * 1024 * 1024);
      },
      env: {
        ...launchEnvironment,
        HAZE_DEV_BANNER: 'true',
        HAZE_DEV_STARTED_AT: String(startedAt),
      },
    });
    await startupProbe;
    if (!frontendReady && frontendOutput) log(frontendOutput);
    if (!stopping) finished('STOPPED');
  } catch (error) {
    if (stopping) return;
    finished('FAILED');
    display.skipPending(stage + 1);
    // Leave diagnostics below the frozen panel so the failure stays visible.
    display.close();
    if (error.output && (stage !== 2 || !frontendReady)) log(error.output);
    log(error.message);
    if (stage === 0)
      log(
        '  Check Docker Desktop is running and root .env / image registry access are configured.\n  Inspect Zetaris with: docker compose ps --all / docker compose logs --tail 100',
      );
    process.exitCode = error.exitCode ?? 1;
  } finally {
    probeController.abort();
    consoleSession?.close();
    smokeLedger.stop();
    clearTimeout(stopTimer);
    if (stopContainers && !sampleMode) {
      log("Stopping this project's Zetaris containers…");
      try {
        log(
          await runDevTool('docker', ['compose', 'stop'], {
            cwd: root,
            timeout: 60_000,
          }),
        );
      } catch (error) {
        log(error.message);
        process.exitCode = 1;
      }
    }
    if (stopping) {
      finished(frontendReady ? 'STOPPED' : 'CANCELLED');
      display.skipPending(stage + 1);
    }
    display.close();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

await main();
