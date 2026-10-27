import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runDevTool, terminateDevChild } from './dev-process.mjs';

const READY_TIMEOUT_MS = 120_000;

/**
 * Run the SmokeLedger sidecar next to the dev app: wait for its Postgres, install it on
 * first use, then start scripts/serve-smokeledger.mjs and report /health. Never fatal:
 * Haze runs without SmokeLedger, and its tools report the sidecar as unreachable.
 */
export function createSmokeLedgerSidecar({
  root,
  npmCli,
  signal,
  onStatus = () => {},
  onOutput = () => {},
  env = process.env,
}) {
  const port = env.SMOKELEDGER_PORT || '8100';
  const healthUrl = `http://127.0.0.1:${port}/health`;
  let child;
  let exited = false;

  async function health() {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.any([AbortSignal.timeout(2000), signal]),
      });
      return await response.json();
    } catch {
      return undefined;
    }
  }

  function describe(value) {
    const mode = value.mode === 'offline_sample' ? 'sample' : value.mode;
    const store = value.adapters?.store ?? 'unknown store';
    const query = value.adapters?.evidence_query ?? 'unknown backend';
    return `${mode}; ${store} via ${query} on :${port}`;
  }

  async function waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!signal.aborted && !exited && Date.now() < deadline) {
      const value = await health();
      const starting = value?.reasons?.includes('starting');
      if (value && !starting) {
        if (value.status === 'ready') onStatus('READY', describe(value));
        else
          onStatus(
            'DEGRADED',
            `${(value.reasons ?? []).join('; ')} | ${describe(value)}`,
          );
        return;
      }
      await new Promise((done) => setTimeout(done, 1000).unref());
    }
    if (!signal.aborted && !exited)
      onStatus('UNREACHABLE', `No healthy response from ${healthUrl}`);
  }

  async function start() {
    onStatus('STARTING');
    const existing = await health();
    if (existing) {
      onStatus(
        existing.status === 'ready' ? 'READY' : 'DEGRADED',
        `Already running outside npm run dev; ${describe(existing)}`,
      );
      return;
    }
    try {
      // The schema is created by the sidecar on boot, so its database must accept
      // connections first; compose up already started it.
      await runDevTool(
        'docker',
        ['compose', 'up', '--detach', '--wait', 'smokeledger-db'],
        { cwd: root, signal, timeout: 120_000 },
      );
      const cwd = resolve(root, 'smokeledger');
      if (
        !existsSync(resolve(cwd, 'node_modules')) ||
        !existsSync(resolve(cwd, 'vendor'))
      ) {
        onStatus('STARTING', 'First run: installing SmokeLedger');
        await runDevTool(
          process.execPath,
          [npmCli, '--silent', 'run', 'smokeledger:install'],
          { cwd: root, signal, timeout: 600_000, onOutput },
        );
      }
      if (!existsSync(resolve(cwd, '.env')))
        onOutput(
          'SmokeLedger: smokeledger/.env not found; copy smokeledger/.env.example and fill it in.\n',
        );
    } catch (error) {
      if (!signal.aborted) onStatus('FAILED', error.message.split('\n')[0]);
      return;
    }
    if (signal.aborted) return;

    let tail = '';
    child = spawn(process.execPath, ['scripts/serve-smokeledger.mjs'], {
      cwd: root,
      env: { ...env, SMOKELEDGER_PORT: port },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8');
      child[stream].on('data', (chunk) => {
        const text = decoder.write(chunk);
        tail = (tail + text).slice(-4096);
        onOutput(text.replace(/^(?=.)/gmu, '[smokeledger] '));
      });
    }
    child.once('error', (error) => {
      exited = true;
      onStatus('FAILED', error.message);
    });
    child.once('exit', (code, exitSignal) => {
      exited = true;
      child = undefined;
      if (signal.aborted) return;
      const last = tail.trim().split(/\r?\n/).at(-1) ?? '';
      onStatus(
        'FAILED',
        `Exited ${exitSignal ?? `with code ${code}`}${last ? `: ${last}` : ''}`,
      );
    });
    await waitUntilReady();
  }

  function stop(killSignal = 'SIGTERM') {
    terminateDevChild(child, killSignal);
  }

  return { start, stop };
}
