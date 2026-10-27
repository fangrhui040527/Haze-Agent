import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryDirectories: string[] = [];
const callMarker = '__DEV_STARTUP_CALL__';
const killMarker = '__DEV_STARTUP_KILL__';

interface Scenario {
  tty?: boolean;
  failAt?: number;
  errorAt?: number;
  interruptAt?: number;
  exitCode?: number;
  signal?: 'SIGINT' | 'SIGTERM';
  outputAt?: number;
  stdout?: string;
  stderr?: string;
  stdoutChunks?: number[][];
  afterReady?: boolean;
  noReady?: boolean;
  apiFailure?: boolean;
  consoleCommands?: string[];
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  stdio: string[];
  banner?: string;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Exercise the real launcher while replacing every child with a disposable stub. */
async function launch(scenario: Scenario = {}, args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-dev-startup-'));
  temporaryDirectories.push(directory);
  const preload = join(directory, 'stub-processes.mjs');
  await writeFile(
    preload,
    `
import childProcess from 'node:child_process';
import nodeModule, { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const scenario = ${JSON.stringify(scenario)};
if (scenario.tty) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true });
  Object.defineProperty(process.stdout, 'columns', { value: 80 });
  process.env.TERM = 'xterm';
}
if (scenario.consoleCommands) Object.defineProperty(process, 'stdin', { value: new PassThrough() });
globalThis.fetch = async (input) => {
  if (scenario.apiFailure) throw new TypeError('connection refused');
  const url = new URL(input);
  if (url.pathname === '/') return new Response('<html>Haze app</html>', { headers: { 'content-type': 'text/html' } });
  const responses = {
    '/api/health': { ok: true, mode: 'fixture', watchers: [], hazeops: { scheduler: 'disabled', reason: 'fixture mode' } },
    '/api/tasks': { tasks: [] },
    '/api/world/records': { counts: { records: 0, relationships: 0, events: 0 } },
    '/api/nightshift/readiness': { routes: [] },
    '/api/nightshift/jobs/readiness': { runtime_reachable: false, ready: false, cli_available: false, reason: 'Nightshift not installed' },
    '/api/nightshift/automation/readiness': { ready: false, released: false, reason: 'Automatic release gate closed' },
  };
  return new Response(JSON.stringify(responses[url.pathname] ?? {}), { headers: { 'content-type': 'application/json' } });
};
const originalCreateRequire = nodeModule.createRequire;
nodeModule.createRequire = (filename) => {
  const require = originalCreateRequire(filename);
  const originalResolve = require.resolve;
  require.resolve = (specifier, options) => specifier === 'vite/package.json'
    ? ${JSON.stringify(join(directory, 'vite', 'package.json'))}
    : originalResolve(specifier, options);
  return require;
};
let nextIndex = 0;
childProcess.spawn = (command, args, options) => {
  const index = nextIndex++;
  console.log(${JSON.stringify(callMarker)} + JSON.stringify({
    command, args, cwd: options.cwd, stdio: options.stdio,
    banner: options.env?.HAZE_DEV_BANNER,
  }));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let keepAlive;
  child.kill = (signal) => {
    clearInterval(keepAlive);
    console.log(${JSON.stringify(killMarker)} + signal);
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  const emitOutput = () => {
    if (scenario.outputAt !== index) return;
    if (scenario.stdout) child.stdout.emit('data', Buffer.from(scenario.stdout));
    if (scenario.stderr) child.stderr.emit('data', Buffer.from(scenario.stderr));
    for (const chunk of scenario.stdoutChunks ?? [])
      child.stdout.emit('data', Buffer.from(chunk));
  };
  setImmediate(() => {
    if (!scenario.afterReady) emitOutput();
    if (scenario.interruptAt === index) {
      process.emit(scenario.signal ?? 'SIGINT');
      return;
    }
    if (scenario.errorAt === index) {
      const error = new Error('spawn docker ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
      child.emit('close', -2, null);
      return;
    }
    if (index === 3 && scenario.failAt !== index && !scenario.noReady) child.emit('message', {
      type: 'haze-dev-ready', local: ['http://localhost:5174/'], network: [],
    });
    if (scenario.afterReady) emitOutput();
    if (index === 3 && scenario.consoleCommands) {
      keepAlive = setInterval(() => {}, 1000);
      scenario.consoleCommands.forEach((line, offset) => setTimeout(() => {
        process.stdin.emit('data', Buffer.from(line + '\\n'));
      }, 100 + offset * 100));
      return;
    }
    child.emit('close', scenario.failAt === index ? scenario.exitCode : 0, null);
  });
  return child;
};
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(preload).href,
      resolve(root, 'scripts/dev.mjs'),
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, npm_execpath: join(directory, 'npm-cli.cjs') },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  const calls = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(callMarker))
    .map((line) => JSON.parse(line.slice(callMarker.length)) as SpawnCall);
  return { ...result, calls, output: result.stdout + result.stderr };
}

describe('root development startup', () => {
  it('owns stdin for an explicit console and exits without stopping Compose', async () => {
    const result = await launch({ consoleCommands: ['help', 'exit'] }, [
      '--console',
    ]);
    expect(result.status).toBe(0);
    expect(result.output).toContain('haze>');
    expect(result.output).toContain('Haze commands');
    expect(result.calls).toHaveLength(4);
    expect(result.calls[3]?.stdio[0]).toBe('ignore');
    expect(result.calls[3]?.args).not.toContain('--console');
    expect(result.output).toContain(killMarker + 'SIGINT');
  });

  it('fails startup if the app API cannot initialize', async () => {
    const result = await launch({ apiFailure: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAILED');
    expect(result.output).toContain('Cannot reach the app API');
  });

  it('starts Zetaris, displays its status, builds, then launches Vite with CLI options', async () => {
    const args = ['--port', '5174', '--host', '127.0.0.1'];
    const result = await launch({}, args);

    expect(result.status).toBe(0);
    expect(result.calls).toHaveLength(4);
    expect(result.calls[0]).toMatchObject({
      command: 'docker',
      args: ['compose', '--progress', 'plain', 'up', '--detach'],
      cwd: root,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    expect(result.calls[1]).toMatchObject({
      command: 'docker',
      args: ['compose', 'ps', '--all', '--format', 'json'],
    });
    expect(result.calls[2]?.command).toBe(process.execPath);
    expect(result.calls[2]?.args.slice(1)).toEqual([
      '--silent',
      'run',
      'build',
    ]);
    expect(result.calls[3]).toMatchObject({
      command: process.execPath,
      cwd: resolve(root, 'frontend'),
      stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
      banner: 'true',
    });
    expect(result.calls[3]?.args[0]?.replaceAll('\\', '/')).toMatch(
      /\/vite\/bin\/vite\.js$/,
    );
    expect(result.calls[3]?.args.slice(1)).toEqual(args);
    expect(result.output).toMatch(/Zetaris platform[^\n]*STARTED/);
    expect(result.output).toMatch(/Haze TypeScript build[^\n]*BUILT/);
    expect(result.output).toMatch(/Haze web app[^\n]*READY/);
    expect(result.output).not.toContain('STARTING');
    expect(result.output).not.toContain('WAITING');
    expect(result.output).not.toContain('\u001b[');
    expect(result.output).toContain('http://localhost:5174/');
    expect(result.output).toMatch(/World Model \(SQLite\)[^\n]*READY/);
    expect(result.output).not.toContain('H-MEM');
    expect(result.output).toMatch(/Nightshift runtime[^\n]*UNREACHABLE/);
    expect(result.output).toMatch(/Nightshift candidate jobs[^\n]*UNAVAILABLE/);
    for (const name of [
      'Zetaris platform',
      'Haze TypeScript build',
      'Haze web app',
    ])
      expect(result.output.split(name)).toHaveLength(2);
  });

  it('stops before the build when Docker startup fails', async () => {
    const result = await launch({ failAt: 0, exitCode: 17 });

    expect(result.status).toBe(17);
    expect(result.calls).toHaveLength(1);
    expect(result.output).toContain('FAILED');
    expect(result.output).not.toContain('Haze TypeScript build: STARTING');
  });

  it('reports a missing Docker executable without starting later stages', async () => {
    const result = await launch({ errorAt: 0 });

    expect(result.status).not.toBe(0);
    expect(result.calls).toHaveLength(1);
    expect(result.output).toContain('FAILED');
    expect(result.output).toContain('ENOENT');
    expect(result.output).not.toContain('Haze TypeScript build: STARTING');
  });

  it('stops before the build when Docker status inspection fails', async () => {
    const result = await launch({ failAt: 1, exitCode: 19 });

    expect(result.status).toBe(19);
    expect(result.calls).toHaveLength(2);
    expect(result.output).toContain('FAILED');
    expect(result.output).not.toContain('Haze TypeScript build: STARTING');
  });

  it('does not launch Vite after a failed backend build', async () => {
    const result = await launch({ failAt: 2, exitCode: 23 });

    expect(result.status).toBe(23);
    expect(result.calls).toHaveLength(3);
    expect(result.output).toContain('FAILED');
    expect(result.output).not.toContain('Haze web app: STARTING');
  });

  it('propagates the Vite process exit code', async () => {
    const result = await launch({ failAt: 3, exitCode: 42 });

    expect(result.status).toBe(42);
    expect(result.calls).toHaveLength(4);
  });

  it('hides successful Compose progress instead of printing status history', async () => {
    const result = await launch({
      outputAt: 0,
      stderr:
        'Container zetaris-api-1 Starting\nContainer zetaris-api-1 Started\n',
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Container zetaris-api-1');
    expect(result.output).toMatch(/Zetaris platform[^\n]*STARTED/);
  });

  it('keeps captured diagnostics visible when a startup command fails', async () => {
    const result = await launch({
      failAt: 2,
      exitCode: 23,
      outputAt: 2,
      stdout: 'TypeScript build diagnostic\n',
      stderr: 'The backend could not compile\n',
    });

    expect(result.status).toBe(23);
    expect(result.output).toContain('TypeScript build diagnostic');
    expect(result.output).toContain('The backend could not compile');
    expect(result.output).toMatch(/Haze TypeScript build[^\n]*FAILED/);
  });

  it('keeps failed-build diagnostics below the frozen panel in an interactive terminal', async () => {
    const diagnostic = 'Error: Source file inventory differs: world_model';
    const result = await launch({
      tty: true,
      failAt: 2,
      exitCode: 23,
      outputAt: 2,
      stderr: `${diagnostic}\n`,
    });

    expect(result.status).toBe(23);
    expect(result.calls).toHaveLength(3);
    expect(result.output).toMatch(/Haze TypeScript build[^\n]*FAILED/);
    expect(result.output).toContain(diagnostic);
    const diagnosticPosition = result.output.lastIndexOf(diagnostic);
    expect(diagnosticPosition).toBeGreaterThan(
      result.output.lastIndexOf('  Haze Agent'),
    );
    expect(result.output.slice(diagnosticPosition)).not.toContain('\u001b[');
  });

  it('preserves runtime lines and UTF-8 characters across output chunks', async () => {
    const bytes = [...Buffer.from('café warning\nfinal tail')];
    const result = await launch({
      outputAt: 3,
      afterReady: true,
      stdoutChunks: [bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)],
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('café warning\nfinal tail\n');
  });

  it('summarizes container health without printing another container table', async () => {
    const result = await launch({
      outputAt: 1,
      stdout: [
        JSON.stringify({ Service: 'api', State: 'running', Health: 'healthy' }),
        JSON.stringify({ Service: 'bootstrap', State: 'exited', ExitCode: 0 }),
      ].join('\n'),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('1 healthy, 1 completed');
    expect(result.output).not.toContain('"Service"');
  });

  it('preserves Vite help output without claiming the server is ready', async () => {
    const result = await launch(
      { outputAt: 3, stdout: 'Vite command help\n', noReady: true },
      ['--help'],
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain('Vite command help');
    expect(result.output).toMatch(/Haze web app[^\n]*STOPPED/);
    expect(result.output).not.toMatch(/Haze web app[^\n]*READY/);
  });

  it.each([
    { interruptAt: 0, signal: 'SIGINT' as const },
    { interruptAt: 2, signal: 'SIGTERM' as const },
    { interruptAt: 3, signal: 'SIGINT' as const },
  ])(
    'forwards $signal during stage $interruptAt and stops startup',
    async (scenario) => {
      const result = await launch(scenario);

      expect(result.calls).toHaveLength(scenario.interruptAt + 1);
      expect(result.output).toContain(killMarker + scenario.signal);
    },
  );
});
