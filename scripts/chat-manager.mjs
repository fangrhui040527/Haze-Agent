import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  managerRepositoryRoot,
  checkManagerTypes,
  buildManagerRuntime,
} from './manager-build.mjs';
import { createManagerSandboxRegistry } from './manager-sandbox.mjs';
import { restrictManagerEvaluationTools } from './manager-evaluation-support.mjs';
import {
  ManagerChatSession,
  managerOnlyModelRoutes,
} from './manager-chat-session.mjs';

const help = `Talk directly to the configured live Manager with synthetic specialist results.
Usage: npm run manager:chat [-- --prompt "Your request"]
Type your own messages; messages during work correct the current task.
Reply normally to answer a Manager question. After a result, follow-ups start
a new task with the previous dialogue supplied as context, not source evidence.

/new                 Start a fresh conversation; cancel unfinished work
/correct TEXT        Correct the current request
/status              Show task status and model-call usage
/decisions           Show the current task's validated Manager decisions
/pause /cancel       Control the current task
/resume /continue    Explicitly resume or start a linked continuation
/help                Show these commands
/quit                Exit and retain local traces

Only the Manager calls the real model. eval.* specialists return synthetic
results. External source tools are disabled; arbitrary real-world actions
and scientific/domain accuracy are outside this sandbox.`;
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(help);
  process.exit(0);
}
if (
  args.length &&
  (args.length !== 2 || args[0] !== '--prompt' || !args[1]?.trim())
)
  throw new Error(help);

checkManagerTypes();
const buildRoot = await buildManagerRuntime({ mode: 'live-chat' });
const load = (file) => import(pathToFileURL(join(buildRoot, 'dist', file)));
const [
  { TaskRuntime, localTaskIdentity },
  { ExecutionRegistry },
  { managerAgent },
  { ModelRouteRegistry },
] = await Promise.all([
  load('tasks/runtime.js'),
  load('orchestration/ports.js'),
  load('agents/manager/index.js'),
  load('adapters/model-routes.js'),
]);
const modelRoutes = managerOnlyModelRoutes(new ModelRouteRegistry(process.env));
const managerRoute = modelRoutes.snapshot().routes.Manager;
const model = await modelRoutes.prepare(
  managerRoute,
  AbortSignal.timeout(3000),
);
const sessions = join(managerRepositoryRoot, '.state/manager-chat');
await mkdir(sessions, { recursive: true });
const directory = await mkdtemp(join(sessions, 'session-'));
const registry = createManagerSandboxRegistry({
  ExecutionRegistry,
  managerAgent,
});
const runtime = new TaskRuntime({
  stateDirectory: join(directory, 'state'),
  registry,
  mode: 'live',
  modelRoutes,
  env: process.env,
  limits: { max_model_calls: 20, max_assignments: 16, max_artifacts: 64 },
});
const excludedTools = restrictManagerEvaluationTools(registry);
const session = new ManagerChatSession(runtime, localTaskIdentity, registry);
const reportPath = join(directory, 'session.json');
let saving = Promise.resolve();

async function save() {
  const tasks = session.report();
  const contents =
    JSON.stringify(
      {
        schema_version: 'haze.manager.chat.v1',
        captured_at: new Date().toISOString(),
        build_root: buildRoot,
        state_directory: join(directory, 'state'),
        model: model.selection,
        specialist_mode: 'synthetic-evaluation-stubs',
        excluded_runtime_tool_ids: excludedTools,
        history: session.history,
        isolation_passed: tasks.every((entry) => entry.isolation.passed),
        tasks,
      },
      null,
      2,
    ) + '\n';
  saving = saving.catch(() => {}).then(() => writeFile(reportPath, contents));
  await saving;
  if (tasks.some((entry) => !entry.isolation.passed))
    throw new Error(
      'Manager chat isolation check failed. Inspect the saved session.',
    );
}

function show(task) {
  if (!task) {
    console.log('No current task. Type a request.');
    return;
  }
  if (task.result && task.result.currency !== 'stale') {
    console.log(`\nManager> ${task.result.answer}`);
    for (const item of task.result.uncertainty ?? [])
      console.log(`Uncertainty: ${item}`);
    for (const item of task.result.unfinished ?? [])
      console.log(`Unfinished: ${item}`);
  }
  for (const q of task.questions.filter(
    (q) => q.status === 'open' && q.run_id === task.current_run_id,
  ))
    console.log(`\nManager> ${q.question}`);
  if (task.error)
    console.log(`\nManager error [${task.error.code}]: ${task.error.message}`);
  console.log(
    `[${task.status}; task ${task.id}; revision ${task.objective_revision}; model calls ${task.usage.model_calls}; tool calls ${task.usage.tool_calls}]`,
  );
}

console.log(
  `\nLive Manager chat: ${model.selection.provider} / ${model.selection.model}`,
);
console.log('Other agents are simulated. Type /help for commands.');
console.log(`Session trace: ${reportPath}`);
let observer;
let pending = Promise.resolve();
let rl;
const decisionIds = new Set();
function observe() {
  observer?.abort();
  observer = new AbortController();
  const signal = observer.signal;
  pending = (async () => {
    const task = await session.wait(signal, (task) => {
      for (const { decision } of task.manager?.decisions ?? []) {
        if (decisionIds.has(decision.id)) continue;
        decisionIds.add(decision.id);
        console.log(
          `\n[Manager action: ${decision.action.type}] ${decision.explanation}`,
        );
      }
    });
    if (!task || signal.aborted) return;
    show(task);
    await save();
    rl?.prompt();
    if (
      [
        'failed',
        'timed_out',
        'paused',
        'cancelled',
        'running',
        'queued',
      ].includes(task.status)
    )
      process.exitCode = 1;
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

try {
  if (args[0] === '--prompt') {
    session.send(args[1]);
    observe();
    await pending;
  } else {
    rl = createInterface({
      input: stdin,
      output: stdout,
      terminal: Boolean(stdin.isTTY),
      prompt: 'You> ',
    });
    rl.on('SIGINT', () => rl.close());
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === '/quit' || line === '/exit') break;
      try {
        if (line === '/help') console.log(help);
        else if (line === '/status') show(session.snapshot());
        else if (line === '/decisions')
          console.log(
            JSON.stringify(
              session.snapshot()?.manager?.decisions ?? [],
              null,
              2,
            ),
          );
        else if (line === '/new') {
          observer?.abort();
          session.reset();
          console.log(
            'Fresh conversation. Saved tasks remain in the session trace.',
          );
        } else if (
          ['/pause', '/cancel', '/resume', '/continue'].includes(line)
        ) {
          observer?.abort();
          const task = session.control(line.slice(1));
          show(task);
          if (['queued', 'running'].includes(task.status)) observe();
        } else if (line.startsWith('/') && !line.startsWith('/correct ')) {
          throw new Error('Unknown command. Type /help.');
        } else {
          const correction = line.startsWith('/correct ');
          session.send(correction ? line.slice(9) : line, { correction });
          console.log(
            'Manager is considering your request. You can type a correction while it works.',
          );
          observe();
        }
        await save();
      } catch (error) {
        console.error(error.message);
      }
      rl.prompt();
    }
    rl.close();
  }
} finally {
  observer?.abort();
  await pending;
  try {
    await save();
  } finally {
    await runtime.close();
  }
  console.log(`Saved session: ${reportPath}`);
}
