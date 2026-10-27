import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CommandOptions {
  signal: AbortSignal;
  write: (text: string) => void;
}
interface Session {
  close(): void;
  log(text: string): void;
  readline: { history: string[]; emit(event: string): void };
}
const { parseCommand, completeCommand, createDevConsole } = (await import(
  new URL('../../scripts/dev-console.mjs', import.meta.url).href
)) as {
  parseCommand: (line: string) => string[];
  completeCommand: (line: string, keys?: string[]) => [string[], string];
  createDevConsole: (options: {
    input: PassThrough;
    output: PassThrough;
    execute: (
      tokens: string[],
      options: CommandOptions,
    ) => Promise<string | void>;
    onExit: () => void;
    redact?: (text: string) => string;
  }) => Session;
};
const { createDevCommands } = (await import(
  new URL('../../scripts/dev-commands.mjs', import.meta.url).href
)) as {
  createDevCommands: (options: Record<string, unknown>) => {
    execute(tokens: string[], options: CommandOptions): Promise<string | void>;
  };
};
const sessions: Session[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('development command console', () => {
  it('exits after closing a console even when its parent keeps the input pipe open', async () => {
    const moduleUrl = new URL('../../scripts/dev-console.mjs', import.meta.url)
      .href;
    const source = `import {createDevConsole} from ${JSON.stringify(moduleUrl)};let session;session=createDevConsole({execute:()=>{session.close();return Promise.resolve();},onExit:()=>session.close()});`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', source],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let started = false;
    child.stdout.on('data', () => {
      if (!started) {
        started = true;
        child.stdin.write('exit\n');
      }
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                'Console kept its input pipe referenced after closing.',
              ),
            ),
          5000,
        );
      });
      expect(code).toBe(0);
    } finally {
      clearTimeout(timeout);
      child.stdin.destroy();
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('preserves quoted objectives, JSON, empty values, and Windows paths without shell expansion', () => {
    expect(parseCommand('tasks run "Explain this report"')).toEqual([
      'tasks',
      'run',
      'Explain this report',
    ]);
    expect(
      parseCommand(
        `config set HAZE_MODEL_ROUTES_JSON '{"version":1,"profiles":{}}'`,
      ),
    ).toEqual([
      'config',
      'set',
      'HAZE_MODEL_ROUTES_JSON',
      '{"version":1,"profiles":{}}',
    ]);
    expect(parseCommand('config set STATE_DIR C:\\Users\\test')).toEqual([
      'config',
      'set',
      'STATE_DIR',
      'C:\\Users\\test',
    ]);
    expect(parseCommand('config set NVIDIA_API_KEY ""')).toEqual([
      'config',
      'set',
      'NVIDIA_API_KEY',
      '',
    ]);
    expect(parseCommand('tasks run "$(whoami); $HOME"')).toEqual([
      'tasks',
      'run',
      '$(whoami); $HOME',
    ]);
    expect(() => parseCommand('tasks run "unfinished')).toThrow(
      'Unclosed quote',
    );
  });

  it('completes commands, subcommands, and supported setting names', () => {
    expect(completeCommand('nig')[0]).toEqual(['nightshift']);
    expect(completeCommand('tasks re')[0]).toEqual(['resume', 'reply']);
    expect(
      completeCommand('config get HAZE_', ['HAZE_MODEL', 'STATE_DIR'])[0],
    ).toEqual(['HAZE_MODEL']);
  });

  it('recovers after a command error and sanitizes asynchronous runtime output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    const execute = vi.fn((tokens: string[]) => {
      if (tokens[0] === 'broken')
        return Promise.reject(new Error('try doctor'));
      return Promise.resolve('working');
    });
    const session = createDevConsole({
      input,
      output,
      execute,
      onExit: vi.fn(),
      redact: (value) => value.replaceAll('secret-value', '[REDACTED]'),
    });
    sessions.push(session);
    input.write('broken\n');
    await vi.waitFor(() => expect(text).toContain('Error: try doctor'));
    session.log('\u001b[2Jsecret-value');
    input.write('help\n');
    await vi.waitFor(() => expect(text).toContain('working'));
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('\u001b[2J');
  });

  it('interrupts a foreground watch, then exits on an idle interrupt', async () => {
    const onExit = vi.fn();
    let commandSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async (_tokens: string[], options: CommandOptions) => {
        commandSignal = options.signal;
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    );
    const input = new PassThrough();
    const session = createDevConsole({
      input,
      output: new PassThrough(),
      execute,
      onExit,
    });
    sessions.push(session);
    input.write('status --watch\n');
    await vi.waitFor(() => expect(commandSignal).toBeDefined());
    session.readline.emit('SIGINT');
    await vi.waitFor(() => expect(commandSignal?.aborted).toBe(true));
    expect(onExit).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    session.readline.emit('SIGINT');
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('removes configuration writes from terminal history, including quoted command names', async () => {
    vi.stubEnv('TERM', 'xterm');
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
    });
    const execute = vi.fn(() => Promise.resolve('Saved setting.'));
    const session = createDevConsole({
      input,
      output,
      execute,
      onExit: vi.fn(),
    });
    sessions.push(session);
    input.write('config set NVIDIA_API_KEY "first-secret"\n');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(session.readline.history.join('\n')).not.toContain('first-secret');
    input.write('"config" set NVIDIA_API_KEY "second-secret"\n');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(session.readline.history.join('\n')).not.toContain('second-secret');
  });

  it('closes on EOF and does not invoke exit when disposed by the launcher', () => {
    const onExit = vi.fn();
    const input = new PassThrough();
    const session = createDevConsole({
      input,
      output: new PassThrough(),
      execute: () => Promise.resolve(''),
      onExit,
    });
    session.close();
    expect(onExit).not.toHaveBeenCalled();
    const next = createDevConsole({
      input: new PassThrough(),
      output: new PassThrough(),
      execute: () => Promise.resolve(''),
      onExit,
    });
    sessions.push(next);
    next.readline.emit('close');
    expect(onExit).toHaveBeenCalledOnce();
  });
});

function harness() {
  const run = vi.fn(() => Promise.resolve(''));
  const restart = vi.fn(() => Promise.resolve());
  const stop = vi.fn();
  const api = {
    execute: vi.fn((tokens: string[]) => Promise.resolve(tokens.join(' '))),
  };
  const config = {
    execute: vi.fn(() => Promise.resolve('Configuration valid')),
  };
  const handler = createDevCommands({
    root: 'C:/workspace',
    getUrl: () => 'http://127.0.0.1:5174/',
    api,
    config,
    run,
    restart,
    stop,
    getLogs: () => 'retained log',
    subscribeLogs: () => () => {},
    platform: 'win32',
  });
  const options = { signal: new AbortController().signal, write: vi.fn() };
  return { ...handler, run, restart, stop, api, config, options };
}

describe('development command dispatch', () => {
  it('routes tasks through the API and settings through the config service', async () => {
    const h = harness();
    await h.execute(['tasks', 'pause', 'task-id'], h.options);
    await h.execute(['config', 'set', 'HAZE_MODEL', 'model'], h.options);
    expect(h.api.execute).toHaveBeenCalledWith(
      ['tasks', 'pause', 'task-id'],
      h.options,
    );
    expect(h.config.execute).toHaveBeenCalledWith([
      'config',
      'set',
      'HAZE_MODEL',
      'model',
    ]);
  });

  it('uses the actual app port and a fixed executable to open pages', async () => {
    const h = harness();
    await h.execute(['open', 'world'], h.options);
    expect(h.run).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'http://127.0.0.1:5174/world-model'],
      expect.objectContaining({ cwd: 'C:/workspace' }),
    );
    await expect(
      h.execute(['open', 'https://remote.example'], h.options),
    ).rejects.toThrow('open');
  });

  it('keeps the running app when rebuild fails and never restarts Docker for app restart', async () => {
    const h = harness();
    h.run.mockRejectedValueOnce(new Error('Build failed'));
    await expect(
      h.execute(['app', 'restart', '--rebuild'], h.options),
    ).rejects.toThrow('Build failed');
    expect(h.restart).not.toHaveBeenCalled();
    await h.execute(['app', 'restart'], h.options);
    expect(h.restart).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('requires explicit all-service shutdown and distinguishes exit', async () => {
    const h = harness();
    await expect(h.execute(['shutdown'], h.options)).rejects.toThrow(
      'shutdown --all',
    );
    expect(h.stop).not.toHaveBeenCalled();
    await h.execute(['exit'], h.options);
    expect(h.stop).toHaveBeenLastCalledWith({ all: false });
    await h.execute(['shutdown', '--all'], h.options);
    expect(h.stop).toHaveBeenLastCalledWith({ all: true });
  });

  it('diagnoses partial failures without hiding healthy components', async () => {
    const h = harness();
    h.api.execute.mockRejectedValueOnce(new Error('API down'));
    h.run.mockRejectedValueOnce(new Error('Docker unavailable'));
    const result = await h.execute(['doctor'], h.options);
    expect(result).toContain('API down');
    expect(result).toContain('Configuration valid');
    expect(result).toContain('Docker unavailable');
  });

  it('does not silently accept unknown commands or invalid flags', async () => {
    const h = harness();
    await expect(
      h.execute(['exec', 'echo', 'unsafe'], h.options),
    ).rejects.toThrow('Unknown command');
    await expect(h.execute(['status', '--bad'], h.options)).rejects.toThrow(
      'status',
    );
    await expect(h.execute(['logs', '--bad'], h.options)).rejects.toThrow(
      'logs',
    );
  });
});
