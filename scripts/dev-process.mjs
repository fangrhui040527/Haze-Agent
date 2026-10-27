import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Only target the process tree spawned by this launcher, never a port or name. */
export function terminateDevChild(child, signal = 'SIGTERM') {
  if (!child) return;
  if (
    process.platform === 'win32' &&
    Number.isInteger(child.pid) &&
    child.pid > 0
  ) {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.once('error', () => child.kill(signal));
    killer.unref();
  } else if (
    process.platform !== 'win32' &&
    Number.isInteger(child.pid) &&
    child.pid > 0
  ) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill(signal);
    }
  } else child.kill(signal);
}

/** Run a fixed executable without a shell, separately from the managed app child. */
export function runDevTool(
  command,
  args,
  { cwd, signal, onOutput, timeout = 20_000, env } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const pending = { stdout: '', stderr: '' };
    let captured = '';
    let timedOut = false;
    const capture = (stream, text) => {
      captured = (captured + text).slice(-1024 * 1024);
      if (onOutput) {
        const lines = (pending[stream] + text).split('\n');
        pending[stream] = lines.pop().slice(-1024 * 1024);
        if (lines.length) onOutput(`${lines.join('\n')}\n`);
      }
    };
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', (chunk) =>
        capture(stream, decoders[stream].write(chunk)),
      );
    let killTimer;
    const abort = () => {
      terminateDevChild(child);
      killTimer ??= setTimeout(() => terminateDevChild(child, 'SIGKILL'), 1500);
      killTimer.unref();
    };
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          abort();
        }, timeout)
      : undefined;
    timer?.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new Error(`Cannot run ${command}: ${error.message}`));
    });
    child.once('close', (code) => {
      cleanup();
      for (const stream of ['stdout', 'stderr']) {
        capture(stream, decoders[stream].end());
        if (pending[stream]) onOutput?.(pending[stream]);
      }
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut)
        reject(
          new Error(
            `${command} timed out. Check Docker Desktop and service readiness.`,
          ),
        );
      else if (code === 0) resolve(captured.trimEnd());
      else
        reject(
          new Error(`${command} exited with code ${code}.\n${captured.trim()}`),
        );
    });
  });
}

export function parseComposeStatus(text) {
  const trimmed = text.trim();
  return !trimmed
    ? []
    : trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
}

export function describeComposeStatus(containers) {
  if (!containers.length)
    return 'Zetaris: no project containers found. Check Docker Desktop and docker compose ps --all.';
  return [
    'Zetaris containers',
    ...containers.map((item) => {
      const state = composeServiceState(item);
      return `  ${item.Service ?? item.Name}: ${state}${item.Health ? ` (${item.Health})` : ''}`;
    }),
  ].join('\n');
}

export function composeServiceState(item) {
  if (item.State !== 'exited') return item.State;
  if (item.ExitCode !== 0) return `failed (exit ${item.ExitCode ?? 'unknown'})`;
  return ['init', 'bootstrap'].includes(item.Service) ? 'completed' : 'stopped';
}
