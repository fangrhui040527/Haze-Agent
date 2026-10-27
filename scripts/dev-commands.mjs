import { commandHelp, watchCommand } from './dev-console.mjs';
import {
  describeComposeStatus,
  parseComposeStatus,
  runDevTool,
} from './dev-process.mjs';

function usage(message) {
  throw new Error(message);
}

export function localAppUrl(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("The console requires the app's loopback development URL.");
  return url;
}

/** Glue between terminal commands, existing APIs, and explicitly owned processes. */
export function createDevCommands({
  root,
  getUrl,
  api,
  config,
  restart,
  stop,
  getLogs,
  subscribeLogs,
  run = runDevTool,
  platform = process.platform,
}) {
  const dockerStatus = async (signal) =>
    describeComposeStatus(
      parseComposeStatus(
        await run('docker', ['compose', 'ps', '--all', '--format', 'json'], {
          cwd: root,
          signal,
        }),
      ),
    );
  const inspect = async (component, options) => {
    if (component === 'zetaris') return dockerStatus(options.signal);
    return api.execute(['status', component], options);
  };
  const status = async (component, options) => {
    if (component) return inspect(component, options);
    const results = await Promise.allSettled(
      ['app', 'agents', 'nightshift', 'zetaris', 'world', 'hazeops'].map(
        (name) => inspect(name, options),
      ),
    );
    if (options.signal.aborted) throw options.signal.reason;
    return results
      .map((result, index) =>
        result.status === 'fulfilled'
          ? result.value
          : `${['App', 'Agents', 'Nightshift', 'Zetaris', 'World Model', 'HazeOps'][index]}: unavailable — ${result.reason.message}`,
      )
      .join('\n\n');
  };
  async function execute(tokens, options) {
    const { signal, write } = options;
    const [command, ...args] = tokens;
    if (command === 'help') {
      if (args.length > 1) usage('Usage: help [command]');
      return commandHelp(args[0]);
    }
    if (command === 'status') {
      const positional = args.filter((arg) => arg !== '--watch');
      if (
        positional.length > 1 ||
        (positional[0] &&
          ![
            'app',
            'agents',
            'nightshift',
            'zetaris',
            'world',
            'hazeops',
          ].includes(positional[0])) ||
        args.filter((arg) => arg === '--watch').length > 1
      )
        usage(commandHelp('status'));
      const read = () => status(positional[0], options);
      if (args.includes('--watch')) return watchCommand(read, options);
      return read();
    }
    if (command === 'config') return config.execute(tokens);
    if (command === 'open') {
      if (
        args.length > 2 ||
        !['app', 'world', 'task'].includes(args[0] ?? 'app') ||
        (args[0] === 'task' ? !args[1] : args[1])
      )
        usage(commandHelp('open'));
      const url = localAppUrl(getUrl());
      url.pathname =
        args[0] === 'world'
          ? '/world-model'
          : args[0] === 'task'
            ? `/task/${encodeURIComponent(args[1])}`
            : '/';
      url.search = '';
      url.hash = '';
      const [binary, params] =
        platform === 'win32'
          ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]]
          : platform === 'darwin'
            ? ['open', [url.href]]
            : ['xdg-open', [url.href]];
      await run(binary, params, { cwd: root, signal });
      return `Opened ${url.href}`;
    }
    if (command === 'tasks' && args[0] === 'watch') {
      if (args.length !== 2) usage('Usage: tasks watch <id>');
      return watchCommand(
        () => api.execute(['tasks', 'show', args[1]], options),
        options,
      );
    }
    if (['agents', 'tasks', 'nightshift'].includes(command))
      return api.execute(tokens, options);
    if (command === 'logs') {
      const positional = args.filter((arg) => arg !== '--follow');
      if (
        positional.length > 1 ||
        args.filter((arg) => arg === '--follow').length > 1
      )
        usage(commandHelp('logs'));
      const component = positional[0] ?? 'app';
      if (['tasks', 'nightshift'].includes(component))
        return 'For durable work history use tasks watch <id> or nightshift show <id>.';
      if (!['app', 'zetaris'].includes(component)) usage(commandHelp('logs'));
      const follow = args.includes('--follow');
      if (component === 'zetaris') {
        const result = await run(
          'docker',
          [
            'compose',
            'logs',
            '--no-color',
            '--tail',
            '100',
            ...(follow ? ['--follow'] : []),
          ],
          {
            cwd: root,
            signal,
            timeout: follow ? 0 : 20_000,
            onOutput: follow ? write : undefined,
          },
        );
        return follow ? undefined : result || 'No Compose logs yet.';
      }
      const history = getLogs();
      if (!follow) return history || 'No app runtime output yet.';
      write(history || 'Following app runtime output. Press Ctrl+C to stop.');
      await new Promise((resolve) => {
        const unsubscribe = subscribeLogs(write);
        const finish = () => {
          unsubscribe();
          resolve();
        };
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
      });
      return;
    }
    if (command === 'doctor') {
      if (args.length) usage(commandHelp('doctor'));
      const checks = await Promise.allSettled([
        api.execute(['doctor'], options),
        config.execute(['config', 'validate']),
        dockerStatus(signal),
      ]);
      if (signal.aborted) throw signal.reason;
      return [
        `Node ${process.versions.node}`,
        ...checks.map((result, index) =>
          result.status === 'fulfilled'
            ? result.value
            : `${['App APIs', 'Configuration', 'Docker'][index]}: ${result.reason.message}`,
        ),
      ].join('\n\n');
    }
    if (command === 'app') {
      if (
        args[0] !== 'restart' ||
        args.length > 2 ||
        (args[1] && args[1] !== '--rebuild')
      )
        usage(commandHelp('app'));
      if (args[1]) {
        write('Building backend before restart…');
        await run(
          process.execPath,
          [process.env.npm_execpath, '--silent', 'run', 'build'],
          { cwd: root, signal, timeout: 120_000, onOutput: write },
        );
      }
      await restart(signal);
      return `App restarted at ${getUrl()}. Zetaris stays running.`;
    }
    if (command === 'exit' || command === 'shutdown') {
      if (
        command === 'exit'
          ? args.length
          : args.length !== 1 || args[0] !== '--all'
      )
        usage(commandHelp(command));
      stop({ all: command === 'shutdown' });
      return;
    }
    usage(`Unknown command: ${command}. Type help for commands.`);
  }
  return { execute };
}
