import { createInterface, clearLine, cursorTo } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const commands = {
  help: [
    'status',
    'agents',
    'tasks',
    'nightshift',
    'config',
    'logs',
    'doctor',
    'open',
    'app',
    'exit',
    'shutdown',
  ],
  status: [
    'app',
    'agents',
    'nightshift',
    'zetaris',
    'world',
    'hmem',
    'hazeops',
    '--watch',
  ],
  agents: ['list', 'show'],
  tasks: [
    'run',
    'list',
    'show',
    'watch',
    'pause',
    'resume',
    'cancel',
    'continue',
    'reply',
  ],
  nightshift: ['status', 'jobs', 'show'],
  config: ['show', 'get', 'set', 'validate'],
  logs: ['app', 'zetaris', 'tasks', 'nightshift', '--follow'],
  doctor: [],
  open: ['app', 'world', 'task'],
  app: ['restart'],
  exit: [],
  shutdown: ['--all'],
};

const help = {
  status:
    'status [app|agents|nightshift|zetaris|world|hmem|hazeops] [--watch]\n  Show service readiness and current work. Ctrl+C ends a watch.',
  agents:
    'agents list\nagents show <name>\n  Inspect registered agents, configured models, and current assignments.',
  tasks:
    'tasks run "<objective>"\ntasks list [--active|--failed]\ntasks show <id>\ntasks watch <id>\ntasks pause|resume|cancel|continue <id>\ntasks reply <id> "<answer>" [--question <id>]\n  Resume retains the deadline and remaining budget. Continue creates a linked run.\n  Local cancellation does not confirm remote provider termination.',
  nightshift:
    'nightshift status\nnightshift jobs\nnightshift show <id>\n  Inspect separate candidate-job, direct-inference, and automation readiness.\n  Configure models and fleets in the Nightshift cockpit.',
  config:
    'config\nconfig show\nconfig get <KEY>\nconfig set <KEY> "<value>"\nconfig validate\n  Validate and save supported settings to root .env. Restart to apply.\n  Secrets are redacted and config set commands are excluded from history.',
  logs: "logs [app|zetaris] [--follow]\n  Show recent app output or this project's Compose logs. Ctrl+C ends follow.\n  For durable work history use tasks watch <id> or nightshift show <id>.",
  doctor:
    'doctor\n  Check local APIs, readiness, configuration, and Docker without submitting work.',
  open: 'open [app|world]\nopen task <id>\n  Open a page at the actual local development URL.',
  app: 'app restart [--rebuild]\n  Gracefully restart the app; --rebuild builds first. Zetaris stays running.',
  exit: 'exit\n  Stop the app and console. Zetaris containers stay running. Ctrl+D does the same.',
  shutdown:
    "shutdown --all\n  Gracefully stop the app, then stop this project's Compose services. Data is retained.",
};

/** Parse only command arguments; never expand variables or execute shell syntax. */
export function parseCommand(line) {
  const tokens = [];
  let value = '';
  let quote;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && line[index + 1] === quote)
        value += line[++index];
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(value);
      value = '';
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote)
    throw new Error(
      'Unclosed quote. Wrap objectives and values in matching quotes.',
    );
  if (started) tokens.push(value);
  return tokens;
}

export function completeCommand(line, configKeys = []) {
  const words = line.trimStart().split(/\s+/);
  const fragment = words.at(-1) ?? '';
  const options =
    words.length === 1
      ? Object.keys(commands)
      : words.length === 2
        ? (commands[words[0]] ?? [])
        : words[0] === 'config' &&
            ['get', 'set'].includes(words[1]) &&
            words.length === 3
          ? configKeys
          : [];
  return [options.filter((item) => item.startsWith(fragment)), fragment];
}

export function commandHelp(topic) {
  if (topic) {
    if (!help[topic])
      throw new Error(`Unknown help topic: ${topic}. Type help for commands.`);
    return help[topic];
  }
  return [
    'Haze commands',
    '  status [component] [--watch]    Readiness and current work',
    '  agents list | show <name>       Registered agents and assignments',
    '  tasks run | list | show | watch | pause | resume | cancel | continue | reply',
    '  nightshift status | jobs | show Local jobs and readiness gates',
    '  config [show|get|set|validate]   Inspect and configure supported settings',
    '  logs [app|zetaris] [--follow]    Recent runtime output',
    '  doctor                         Diagnose local setup',
    '  open [app|world|task <id>]       Open the browser',
    '  app restart [--rebuild]         Restart; optionally build first',
    '  exit                           Stop app; keep Zetaris running',
    '  shutdown --all                 Stop app and project containers',
    '  help <command>                 Detailed usage and examples',
    '',
    'Tab: complete | Up/Down: history | Ctrl+C: stop foreground command, or exit when idle',
  ].join('\n');
}

/** Foreground watches deliberately stop on Ctrl+C without stopping the app. */
export async function watchCommand(read, { signal, write, interval = 1500 }) {
  let previous;
  while (!signal.aborted) {
    const value = await read();
    if (value !== previous) write(value);
    previous = value;
    await delay(interval, undefined, { signal });
  }
}

/** One terminal owner: the Vite child never reads this console's stdin. */
export function createDevConsole({
  execute,
  onExit,
  redact = (text) => text,
  configKeys = [],
  input = process.stdin,
  output = process.stdout,
}) {
  const terminal = Boolean(
    input.isTTY && output.isTTY && process.env.TERM !== 'dumb',
  );
  const rl = createInterface({
    input,
    output,
    terminal,
    prompt: 'haze> ',
    historySize: 100,
    removeHistoryDuplicates: true,
    completer: (line) => completeCommand(line, configKeys),
  });
  let active;
  let closed = false;
  const clean = (text) =>
    stripVTControlCharacters(redact(String(text))).replaceAll('\r', '');
  function log(text) {
    if (!text) return;
    if (terminal && !closed) {
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    const message = clean(text);
    output.write(message.endsWith('\n') ? message : `${message}\n`);
    if (!closed && !active) rl.prompt(true);
  }
  function close() {
    if (closed) return;
    closed = true;
    active?.abort();
    rl.close();
    input.pause();
    input.unref?.();
  }
  rl.on('SIGINT', () => {
    if (active) active.abort();
    else onExit();
  });
  rl.on('close', () => {
    if (!closed) {
      closed = true;
      active?.abort();
      input.pause();
      input.unref?.();
      onExit();
    }
  });
  rl.on('line', async (line) => {
    // Readline records history before emitting line. Never retain setting values.
    if (/^\s*config\s+set(?:\s|$)/.test(line))
      rl.history = rl.history.filter((item) => item !== line);
    let tokens;
    try {
      tokens = parseCommand(line);
    } catch (error) {
      log(error.message);
      return;
    }
    if (tokens[0] === 'config' && tokens[1] === 'set')
      rl.history = rl.history.filter((item) => item !== line);
    if (!tokens.length) {
      rl.prompt();
      return;
    }
    if (active) {
      if (tokens.length === 1 && tokens[0] === 'exit') {
        active.abort();
        onExit();
      } else
        log('A command is running. Press Ctrl+C to stop it, or type exit.');
      return;
    }
    const controller = new AbortController();
    active = controller;
    try {
      const result = await execute(tokens, {
        signal: controller.signal,
        write: log,
      });
      if (result && !closed) log(result);
    } catch (error) {
      if (!closed)
        log(
          controller.signal.aborted
            ? 'Command stopped.'
            : `Error: ${error.message}`,
        );
    } finally {
      if (active === controller) active = undefined;
      if (!closed) rl.prompt();
    }
  });
  log('Type help for commands.');
  return { log, close, readline: rl };
}
