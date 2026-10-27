import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  managerChatRequestSchema,
  managerChatResponseSchema,
  type ManagerChatRequest,
} from '../../app/contracts/manager-chat.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function turn(message: string, extra: Partial<ManagerChatRequest> = {}) {
  return managerChatRequestSchema.parse({
    schema_version: 'haze.manager.chat.request.v1',
    conversation_id: randomUUID(),
    turn_id: randomUUID(),
    message,
    ...extra,
  });
}
async function api() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-manager-chat-http-'));
  let handler: ReturnType<typeof createTaskHandler>;
  let server: Server;
  let origin = '';
  async function start() {
    handler = createTaskHandler({
      stateDirectory: directory,
      mode: 'fixture',
      env: {},
      dispatchTask: () => {},
    });
    server = createServer(handler);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing address');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
  }
  await start();
  cleanups.push(async () => {
    await stop();
    const target = resolve(directory),
      rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  });
  const post = (body: ManagerChatRequest, key = body.turn_id) =>
    fetch(`${origin}/api/manager/chat`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
  const chat = async (body: ManagerChatRequest, key?: string) => {
    const response = await post(body, key);
    expect(response.status).toBe(200);
    return managerChatResponseSchema.parse(await response.json());
  };
  return {
    chat,
    post,
    get handler() {
      return handler;
    },
    get origin() {
      return origin;
    },
    restart: async () => {
      await stop();
      await start();
    },
  };
}

it('keeps greetings and explanations in conversation with no admissions', async () => {
  const app = await api();
  for (const message of ['Hi', 'What causes haze?']) {
    const response = await app.chat(turn(message));
    expect(response.kind).toBe('reply');
    expect(response.paragraphs.join(' ')).not.toMatch(
      /unavailable|invalid response/i,
    );
    expect(response.task).toBeUndefined();
  }
  expect(
    app.handler.runtime.store.listTaskSummaries(localTaskIdentity).tasks,
  ).toHaveLength(0);
});

it('clarifies a missing location and completes a cited lookup without a task', async () => {
  const app = await api();
  const first = turn('Latest haze information');
  const clarification = await app.chat(first);
  expect(clarification.kind).toBe('clarification');
  const lookup = await app.chat(
    turn('Singapore', {
      conversation_id: first.conversation_id,
      history: [
        { role: 'user', text: first.message },
        { role: 'manager', text: clarification.paragraphs.join('\n') },
      ],
    }),
  );
  expect(lookup.kind).toBe('reply');
  expect(lookup.citations.length).toBeGreaterThan(0);
  expect(lookup.citations[0]).toMatchObject({ kind: 'synthetic_fixture' });
  expect(lookup.citations[0]?.observed_at).toBeDefined();
  expect(
    app.handler.runtime.store.listTaskSummaries(localTaskIdentity).tasks,
  ).toHaveLength(0);
});

it('admits exactly one task for concurrent delivery, retry, and runtime restart', async () => {
  const app = await api();
  const request = turn('Investigate haze in Singapore and write a report.');
  const [first, concurrent] = await Promise.all([
    app.chat(request),
    app.chat(request),
  ]);
  expect(first.kind).toBe('task_admitted');
  expect(concurrent).toEqual(first);
  expect(await app.chat(request, 'second-delivery-key')).toEqual(first);
  await app.restart();
  expect(await app.chat(request)).toEqual(first);
  expect(
    app.handler.runtime.store.listTaskSummaries(localTaskIdentity).tasks,
  ).toHaveLength(1);
  expect(
    (await app.post({ ...request, message: 'A different report' })).status,
  ).toBe(409);
});

it('keeps unrelated chat available and applies answers to exact task questions once', async () => {
  const app = await api();
  const taskResponse = await app.chat(
    turn('Investigate haze in Singapore and write a report.'),
  );
  const taskId = taskResponse.task!.task_id;
  const question = app.handler.runtime.store.askQuestion(
    taskId,
    undefined,
    'Which dates should the report cover?',
  );
  const waiting = app.handler.runtime.store.read(taskId, localTaskIdentity);
  const ref = {
    task_id: taskId,
    question_id: question.id,
    expected_objective_revision: waiting.objective_revision,
    expected_run_id: waiting.current_run_id,
    expected_generation: waiting.generation,
    expected_state_revision: waiting.state_revision,
  };
  expect(
    (await app.chat(turn('What causes haze?', { task_questions: [ref] }))).kind,
  ).toBe('reply');
  expect(
    app.handler.runtime.store.read(taskId, localTaskIdentity).questions[0]
      ?.status,
  ).toBe('open');
  const answer = turn('Use October 23 through October 24, 2026.', {
    answer_to: ref,
  });
  const updated = await app.chat(answer);
  expect(updated.kind).toBe('task_updated');
  expect(updated.task?.task_id).toBe(taskId);
  expect(await app.chat(answer)).toEqual(updated);
  const record = app.handler.runtime.store.read(taskId, localTaskIdentity);
  expect(record.questions[0]?.status).toBe('answered');
  expect(record.corrections).toHaveLength(1);
  const stale = await app.chat(turn('A later answer', { answer_to: ref }));
  expect(stale.kind).toBe('clarification');
});

it('consumes a one-use permission only on admission even when its response is retried', async () => {
  const app = await api();
  const permission = {
    nightshift_permission_id: randomUUID(),
    nightshift_tools: [
      'nightshift.submit',
      'nightshift.result',
      'nightshift.cancel',
    ] as const,
  };
  const grant = {
    ...permission,
    nightshift_tools: [...permission.nightshift_tools],
  };
  await app.chat(turn('Hi', grant));
  const firstRequest = turn(
    'Investigate haze in Singapore and write a report.',
    grant,
  );
  const first = await app.chat(firstRequest);
  const second = await app.chat(
    turn('Investigate haze in Kuala Lumpur and write a report.', grant),
  );
  expect(await app.chat(firstRequest)).toEqual(first);
  const read = (taskId: string) =>
    app.handler.runtime.store.read(taskId, localTaskIdentity);
  expect(read(first.task!.task_id).permissions.tools).toContain(
    'nightshift.submit',
  );
  expect(read(second.task!.task_id).permissions.tools).not.toContain(
    'nightshift.submit',
  );
});

it('enforces the local JSON/idempotency/route boundary for conversational turns', async () => {
  const app = await api();
  expect((await fetch(`${app.origin}/api/manager/chat`)).status).toBe(405);
  expect(
    (
      await fetch(`${app.origin}/api/manager/chat`, {
        method: 'POST',
        headers: { origin: app.origin, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${app.origin}/api/manager/chat`, {
        method: 'POST',
        headers: {
          origin: 'https://foreign.example',
          'content-type': 'application/json',
          'idempotency-key': 'foreign',
        },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  const response = await app.post(turn('Hi'));
  expect(response.headers.get('cache-control')).toBe('no-store');
});
