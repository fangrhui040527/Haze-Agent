import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  checkStartupComponents,
  collectorsReadiness,
  memoryReadiness,
} from './dev-readiness.mjs';

export const API_COMMANDS = [
  'status [app|agents|nightshift|world|hmem|hazeops]',
  'agents list | agents show <name>',
  'tasks run "<objective>"',
  'tasks list [--active|--failed] [--cursor <cursor>]',
  'tasks show <id> | tasks watch <id>',
  'tasks pause|resume|cancel|continue <id>',
  'tasks reply <id> "<answer>" [--question <id>]',
  'nightshift status | nightshift jobs | nightshift show <id>',
];

const clean = (value) =>
  stripVTControlCharacters(String(value ?? ''))
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
    .slice(0, 32000);
const line = (value) => clean(value).replace(/[\r\n\t]/gu, ' ');
const pretty = (value) => clean(JSON.stringify(value, null, 2));
const requireId = (value) => {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(value ?? ''))
    throw new Error('Use a valid task or job ID from the list command.');
  return value;
};
const requireArgs = (condition, usage) => {
  if (!condition) throw new Error(`Usage: ${usage}`);
};

/** Keep injected transports bounded too, rather than relying on fetch alone. */
function abortable(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error('Command cancelled.'));
    if (signal.aborted) {
      void Promise.resolve(pending).catch(() => {});
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function taskText(task) {
  return [
    `Task ${line(task.id)} — ${line(task.status)}`,
    line(task.original_request?.objective),
    `Run: ${line(task.current_run_id)} | revision: ${task.objective_revision} | mode: ${line(task.mode)}`,
    `Usage: ${pretty(task.usage)}`,
    ...(task.assignments ?? []).map(
      (assignment) =>
        `  ${line(assignment.role)} ${line(assignment.status)} ${line(assignment.id)}`,
    ),
    ...(task.questions ?? [])
      .filter((question) => question.status === 'open')
      .map(
        (question) =>
          `Question ${line(question.id)}: ${line(question.question)}`,
      ),
    ...(task.result ? ['', clean(task.result.answer)] : []),
    ...(task.error ? [`Error: ${line(task.error.message)}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
}

/** HTTP-only console adapter: the running app remains the sole SQLite owner. */
export function createDevApi({
  getUrl = () => undefined,
  fetchImpl = fetch,
  timeoutMs = 25000,
} = {}) {
  function origin() {
    const value = getUrl();
    if (!value)
      throw new Error('The app is not ready. Wait for startup to finish.');
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('Console commands require the local app URL.');
    return url.origin;
  }

  async function request(path, { signal: suppliedSignal, body } = {}) {
    const base = origin();
    const uncertainMutation =
      body === undefined
        ? ''
        : ' This operation may have been accepted; inspect tasks list or tasks show before retrying.';
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(suppliedSignal ? [suppliedSignal] : []),
    ]);
    try {
      const response = await abortable(
        fetchImpl(new URL(path, base), {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: base,
            Accept: 'application/json',
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Idempotency-Key': randomUUID(),
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          redirect: 'error',
          signal,
        }),
        signal,
      );
      if (!response.headers.get('content-type')?.includes('application/json')) {
        void response.body?.cancel().catch(() => {});
        throw new Error(
          'The app API returned a non-JSON response. Try app restart --rebuild.',
        );
      }
      const reader = response.body?.getReader();
      let value;
      try {
        const chunks = [];
        let bytes = 0;
        if (!reader) throw new Error('The app API returned an empty response.');
        while (true) {
          const item = await abortable(reader.read(), signal);
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 2 * 1024 * 1024)
            throw new Error(
              'The app API response exceeds the console response limit.',
            );
          chunks.push(Buffer.from(item.value));
        }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        void reader?.cancel().catch(() => {});
        if (error instanceof SyntaxError)
          throw new Error(
            'The app API returned invalid JSON. Try app restart --rebuild.',
          );
        throw error;
      } finally {
        reader?.releaseLock();
      }
      if (!response.ok) {
        const message = value?.error?.message ?? value?.error;
        throw new Error(
          `${response.status}: ${typeof message === 'string' ? line(message) : 'App request failed.'}`,
        );
      }
      return value;
    } catch (error) {
      if (suppliedSignal?.aborted)
        throw new Error(`Command cancelled.${uncertainMutation}`);
      if (signal.aborted)
        throw new Error(
          `The app API timed out. Run doctor or inspect logs app.${uncertainMutation}`,
        );
      if (error instanceof TypeError)
        throw new Error(
          `Cannot reach the app API. Run status app or app restart.${uncertainMutation}`,
        );
      throw error;
    }
  }

  async function readTask(id, signal) {
    requireId(id);
    const task = await request(`/api/tasks/${id}`, { signal });
    if (
      task?.schema_version !== 'haze.task.v3' ||
      task.id !== id ||
      !/^[A-Za-z0-9-]{1,128}$/u.test(task.current_run_id ?? '') ||
      !['objective_revision', 'generation', 'state_revision'].every(
        (key) => Number.isSafeInteger(task[key]) && task[key] > 0,
      )
    )
      throw new Error(
        'The saved task response has invalid identity or revision metadata.',
      );
    return task;
  }

  async function probeWeb(suppliedSignal) {
    const base = origin();
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(suppliedSignal ? [suppliedSignal] : []),
    ]);
    try {
      const response = await abortable(
        fetchImpl(new URL('/', base), {
          headers: { Accept: 'text/html' },
          redirect: 'error',
          cache: 'no-store',
          signal,
        }),
        signal,
      );
      void response.body?.cancel().catch(() => {});
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('text/html')
      )
        throw new Error(
          `React web page unavailable (HTTP ${response.status}).`,
        );
    } catch (error) {
      if (signal.aborted)
        throw new Error('Web interface check cancelled or timed out.');
      throw error;
    }
  }

  const startupChecks = (options = {}) =>
    checkStartupComponents({ request, probeWeb, ...options });

  async function agents(tokens, signal) {
    requireArgs(
      (tokens[0] === 'list' && tokens.length === 1) ||
        (tokens[0] === 'show' && tokens.length === 2),
      'agents list | agents show <name>',
    );
    const result = await request('/api/agents', { signal });
    if (!Array.isArray(result?.agents))
      throw new Error('Invalid agent status response.');
    if (tokens[0] === 'show') {
      const agent = result.agents.find(
        (entry) => entry.role.toLowerCase() === tokens[1].toLowerCase(),
      );
      if (!agent)
        throw new Error(`Unknown agent ${line(tokens[1])}. Run agents list.`);
      const { route, assignments } = agent;
      return [
        `Agent: ${line(agent.role)}`,
        `Model: ${line(route.provider)} / ${line(route.requested_model ?? 'none')} | profile ${line(route.profile)}`,
        `Configuration: ${route.configured ? 'configured' : 'unconfigured'} | contract ${route.schema_compatible ? 'compatible' : 'unavailable'} | route ${line(route.reachability)}`,
        `Role evaluation: ${line(route.role_evaluation)} | live execution ${route.live_verified ? 'verified' : 'unverified'}`,
        ...(route.reason ? [`Blocker: ${line(route.reason)}`] : []),
        'Registered definitions:',
        ...agent.definitions.map(
          (definition) =>
            `  ${line(definition.id)} (${line(definition.version)}) — ${line(definition.capability)}`,
        ),
        'Capabilities:',
        ...agent.capabilities.map(
          (card) =>
            `  ${line(card.id)}: ${line(card.readiness)} — ${line(card.purpose)}`,
        ),
        `Current assignments${agent.assignments_truncated ? ' (bounded snapshot)' : ''}: ${assignments.length}`,
        ...assignments.map(
          (assignment) =>
            `  ${line(assignment.id)} ${line(assignment.status)} | task ${line(assignment.task_id)}`,
        ),
      ].join('\n');
    }
    return result.agents
      .map(({ role, route, assignments, assignments_truncated }) =>
        [
          `${line(role).padEnd(18)} ${route.configured ? 'configured' : 'unconfigured'} | ${line(route.provider)} / ${line(route.requested_model ?? 'no model')}`,
          `  ${assignments_truncated ? `at least ${assignments.length} assignment(s); snapshot truncated` : assignments.length ? `${assignments.length} active assignment(s)` : 'idle'} | route ${line(route.reachability)} | role evaluation ${line(route.role_evaluation)}`,
          ...(route.reason ? [`  ${line(route.reason)}`] : []),
        ].join('\n'),
      )
      .join('\n');
  }

  async function tasks(tokens, signal) {
    const [action, id, ...rest] = tokens;
    if (action === 'run') {
      const objective = tokens.slice(1).join(' ').trim();
      requireArgs(
        objective.length > 0 && objective.length <= 16000,
        'tasks run "<objective>"',
      );
      const admission = await request('/api/tasks', {
        signal,
        body: { schema_version: 'haze.task.request.v3', objective },
      });
      requireId(admission?.task_id);
      return `Task admitted: ${admission.task_id}\nUse tasks watch ${admission.task_id} to follow progress.`;
    }
    if (action === 'list') {
      const query = new URLSearchParams({ limit: '50' });
      let status;
      for (let index = 1; index < tokens.length; index++) {
        const option = tokens[index];
        if (['--active', '--failed'].includes(option) && !status) {
          status = option.slice(2);
          query.set('status', status);
        } else if (
          option === '--cursor' &&
          /^\d{1,16}$/u.test(tokens[index + 1] ?? '') &&
          !query.has('cursor')
        ) {
          query.set('cursor', tokens[++index]);
        } else
          throw new Error(
            'Usage: tasks list [--active|--failed] [--cursor <cursor>]',
          );
      }
      const page = await request(`/api/tasks?${query}`, { signal });
      if (!Array.isArray(page?.tasks))
        throw new Error('Invalid task inbox response.');
      return (
        [
          ...page.tasks.map(
            (task) =>
              `${line(task.id)}  ${line(task.status).padEnd(12)} ${line(task.objective).slice(0, 150)}`,
          ),
          ...(page.has_more
            ? [
                `More tasks: tasks list${status ? ` --${status}` : ''} --cursor ${line(page.next_cursor)}`,
              ]
            : []),
        ].join('\n') || 'No tasks found.'
      );
    }
    if (action === 'show' || action === 'watch') {
      requireArgs(tokens.length === 2, `tasks ${action} <id>`);
      return taskText(await readTask(id, signal));
    }
    if (['pause', 'resume', 'cancel', 'continue'].includes(action)) {
      requireArgs(tokens.length === 2, `tasks ${action} <id>`);
      const task = await readTask(id, signal);
      const receipt = await request(`/api/tasks/${id}/control`, {
        signal,
        body: {
          schema_version: 'haze.task.control.v3',
          ...expectation(task),
          action,
        },
      });
      validateReceipt(receipt, id);
      return `Task ${id}: requested ${line(receipt.requested)}, confirmed ${line(receipt.confirmed)}.\nRemote execution termination is not confirmed.${action === 'resume' ? '\nResume retains the original deadline and remaining budget.' : ''}${action === 'continue' ? '\nContinue creates a fresh linked run.' : ''}`;
    }
    if (action === 'reply') {
      const answerTokens = [...rest];
      let questionId;
      if (answerTokens.at(-2) === '--question') {
        questionId = requireId(answerTokens.pop());
        answerTokens.pop();
      }
      const answer = answerTokens.join(' ').trim();
      requireArgs(
        answer.length > 0 && answer.length <= 16000,
        'tasks reply <id> "<answer>" [--question <id>]',
      );
      const task = await readTask(id, signal);
      const questions = (task.questions ?? []).filter(
        (question) =>
          question.status === 'open' &&
          question.run_id === task.current_run_id &&
          question.objective_revision === task.objective_revision,
      );
      const question = questionId
        ? questions.find((entry) => entry.id === questionId)
        : questions.length === 1
          ? questions[0]
          : undefined;
      if (!question)
        throw new Error(
          questions.length
            ? 'Choose an open question with --question <id>; see tasks show.'
            : 'This task has no current open question.',
        );
      const receipt = await request(`/api/tasks/${id}/updates`, {
        signal,
        body: {
          schema_version: 'haze.task.update.v3',
          ...expectation(task),
          kind: 'clarification',
          passage: answer,
          question_id: question.id,
        },
      });
      validateReceipt(receipt, id);
      return `Answer recorded for question ${line(question.id)}: ${line(receipt.confirmed)}.`;
    }
    throw new Error(
      'Usage: tasks run|list|show|watch|pause|resume|cancel|continue|reply (help tasks)',
    );
  }

  async function nightshift(tokens, signal) {
    if (tokens[0] === 'status' && tokens.length === 1) {
      const paths = [
        ['Jobs', '/api/nightshift/jobs/readiness'],
        ['Direct inference routes', '/api/nightshift/readiness'],
        ['Automatic chains', '/api/nightshift/automation/readiness'],
        ['Job inbox', '/api/nightshift/jobs'],
      ];
      const results = await Promise.allSettled(
        paths.map(([, path]) => request(path, { signal })),
      );
      return results
        .map((result, index) => {
          const title = paths[index][0];
          if (result.status === 'rejected')
            return `${title}: unavailable — ${line(result.reason?.message)}`;
          const value = result.value;
          if (title === 'Job inbox') {
            const jobs = Array.isArray(value) ? value : value.jobs;
            if (!Array.isArray(jobs))
              return 'Job inbox: unavailable — invalid response.';
            const counts = new Map();
            for (const job of jobs) {
              const state = line(job.execution_state);
              counts.set(state, (counts.get(state) ?? 0) + 1);
            }
            return `Job inbox: ${jobs.length} job(s)${counts.size ? ` | ${[...counts].map(([state, count]) => `${count} ${state}`).join(', ')}` : ''}`;
          }
          if (Array.isArray(value.routes))
            return `${title}:\n${value.routes.map((route) => `  ${line(route.role)}: ${route.configured ? 'configured' : 'unconfigured'}, ${line(route.reachability)} | ${line(route.provider ?? '')}${route.requested_model ? ` / ${line(route.requested_model)}` : ''}${route.reason ? ` — ${line(route.reason)}` : ''}`).join('\n')}`;
          const state = value.ready
            ? 'ready'
            : value.enabled === false
              ? 'disabled'
              : value.released === false
                ? 'unreleased'
                : value.cli_available === false
                  ? 'unavailable'
                  : 'blocked';
          return [
            `${title}: ${state}`,
            ...(title === 'Jobs'
              ? [
                  `  CLI: ${value.cli_available ? 'available' : 'unavailable'} | runtime: ${value.runtime_reachable ? 'reachable' : 'unreachable'} | cloud compute: ${value.cloud_compute_available ? 'available' : 'unavailable'} | local compute: ${value.local_compute_available ? 'available' : 'unavailable'}`,
                  `  Job contract: ${value.schema_compatible ? 'compatible' : 'unavailable'} | cloud policy: ${value.cloud_enforced ? 'supported' : 'unsupported'} | local-only policy: ${value.local_only_enforced ? 'enforced' : 'not enforced'}`,
                  ...(value.options?.fleets?.length
                    ? [`  Fleets: ${value.options.fleets.map(line).join(', ')}`]
                    : []),
                ]
              : []),
            ...(value.reason ? [`  ${line(value.reason)}`] : []),
            ...(value.gates ?? [])
              .filter((gate) => !gate.passed)
              .map(
                (gate) =>
                  `  Pending: ${line(gate.label)}${gate.reason ? ` — ${line(gate.reason)}` : ''}`,
              ),
          ].join('\n');
        })
        .join('\n');
    }
    if (tokens[0] === 'jobs' && tokens.length === 1) {
      const result = await request('/api/nightshift/jobs', { signal });
      const jobs = Array.isArray(result) ? result : result?.jobs;
      if (!Array.isArray(jobs))
        throw new Error('Invalid Nightshift jobs response.');
      return (
        jobs
          .map(
            (job) =>
              `${line(job.id)}  ${line(job.execution_state)}  task ${line(job.task_id)} | review ${line(job.review_status)}`,
          )
          .join('\n') || 'No Nightshift jobs.'
      );
    }
    if (tokens[0] === 'show' && tokens.length === 2)
      return pretty(
        await request(`/api/nightshift/jobs/${requireId(tokens[1])}`, {
          signal,
        }),
      );
    throw new Error(
      'Usage: nightshift status | nightshift jobs | nightshift show <id>',
    );
  }

  async function status(component, signal) {
    if (component === 'hmem' || component === 'hazeops') {
      const health = await request('/api/health', { signal });
      const value =
        component === 'hmem'
          ? memoryReadiness(health)
          : collectorsReadiness(health);
      return `${component === 'hmem' ? 'H-MEM' : 'HazeOps collectors'}: ${value.status}\n${value.detail}`;
    }
    if (component === 'agents') return agents(['list'], signal);
    if (component === 'nightshift') return nightshift(['status'], signal);
    if (component === 'world') {
      const world = await request('/api/world/records?limit=1', { signal });
      if (!world.counts)
        throw new Error('Invalid World Model status response.');
      return `World Model: available\n${pretty(world.counts)}\nProjection cursor: ${line(world.projection_cursor)}`;
    }
    if (component === 'app') {
      const health = await request('/api/health', { signal });
      return `App: ${health.ok === true ? 'ready' : 'degraded'} — ${origin()}\nMode: ${line(health.mode)} | started: ${line(health.startedAt)}\nWorld Model: ${line(health.worldModel?.backend)} | coverage: ${line(health.coverage)}\nWatchers: ${(health.watchers ?? []).length}`;
    }
    throw new Error('Usage: status app|agents|nightshift|world|hmem|hazeops');
  }

  async function execute(tokens, { signal } = {}) {
    const [group, ...args] = tokens;
    if (group === 'agents') return agents(args, signal);
    if (group === 'tasks') return tasks(args, signal);
    if (group === 'nightshift') return nightshift(args, signal);
    if (group === 'status') {
      requireArgs(
        args.length === 1,
        'status app|agents|nightshift|world|hmem|hazeops',
      );
      return status(args[0], signal);
    }
    if (group === 'doctor') {
      requireArgs(args.length === 0, 'doctor');
      const components = [
        'app',
        'agents',
        'world',
        'hmem',
        'hazeops',
        'nightshift',
      ];
      const results = await Promise.allSettled(
        components.map((component) => status(component, signal)),
      );
      return results
        .map((result, index) =>
          result.status === 'fulfilled'
            ? result.value
            : `${components[index]}: unavailable — ${line(result.reason?.message)}`,
        )
        .join('\n\n');
    }
    throw new Error('Unknown application command. Run help.');
  }
  return { execute, readTask, startupChecks };
}

const expectation = (task) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
function validateReceipt(receipt, taskId) {
  if (
    receipt?.schema_version !== 'haze.task.control.receipt.v3' ||
    receipt.task_id !== taskId ||
    receipt.remote_termination_confirmed !== false
  )
    throw new Error(
      'The operation receipt does not match this task. Inspect tasks show before retrying.',
    );
}
