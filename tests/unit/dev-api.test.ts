import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import { TaskStore } from '../../app/tasks/store.js';

interface DevApi {
  execute(
    tokens: string[],
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  readTask(id: string, signal?: AbortSignal): Promise<unknown>;
}
const { createDevApi } = (await import(
  new URL('../../scripts/dev-api.mjs', import.meta.url).href
)) as {
  createDevApi: (options: {
    getUrl: () => string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) => DevApi;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server address.');
  return `http://127.0.0.1:${address.port}`;
}

async function application() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-dev-api-'));
  const handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    env: {},
  });
  const server = createServer(handler);
  const origin = await listen(server);
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await handler.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { handler, origin, client: createDevApi({ getUrl: () => origin }) };
}

const taskId = 'a7b9b735-0bb3-43b4-bb02-24b8b95e54c4';
const runId = 'bdd56d5e-0d3d-465c-aa8a-e06572749256';
const questionId = '1ce6a439-d449-47b3-809c-e69a51a7d9aa';
const task = {
  schema_version: 'haze.task.v3',
  id: taskId,
  current_run_id: runId,
  objective_revision: 2,
  generation: 3,
  state_revision: 4,
  status: 'waiting',
  original_request: { objective: 'Explain evidence.' },
  questions: [
    {
      id: questionId,
      status: 'open',
      run_id: runId,
      objective_revision: 2,
      question: 'Which location?',
    },
  ],
};
const receipt = {
  schema_version: 'haze.task.control.receipt.v3',
  task_id: taskId,
  requested: 'pause',
  confirmed: 'paused',
  remote_termination_confirmed: false,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const inputUrl = (input: Parameters<typeof fetch>[0]) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

describe('dev console application commands', () => {
  it('uses real identity-scoped task inboxes with bounded pagination', async () => {
    const { handler, origin, client } = await application();
    const store = handler.runtime.store;
    const seed = (objective: string, identity = localTaskIdentity) => {
      const { task: admitted } = store.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective,
          context_refs: [],
          constraints: [],
          desired_deliverables: [],
        },
        identity,
        randomUUID(),
        { mode: 'fixture' },
      );
      store.control(admitted.id, identity, randomUUID(), {
        schema_version: 'haze.task.control.v3',
        action: 'cancel',
        expected_objective_revision: admitted.objective_revision,
        expected_run_id: admitted.current_run_id,
        expected_generation: admitted.generation,
        expected_state_revision: admitted.state_revision,
      });
      return admitted;
    };
    const first = seed('First local objective.');
    const second = seed('Second local objective.');
    const response = await fetch(origin + '/api/tasks?limit=1');
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      tasks: { id: string }[];
      has_more: boolean;
      next_cursor: string;
    };
    expect(page.tasks.map((entry) => entry.id)).toEqual([second.id]);
    expect(page.has_more).toBe(true);
    const next = await fetch(
      `${origin}/api/tasks?limit=1&cursor=${page.next_cursor}`,
    );
    expect(
      ((await next.json()) as { tasks: { id: string }[] }).tasks.map(
        (entry) => entry.id,
      ),
    ).toEqual([first.id]);
    const output = await client.execute(['tasks', 'list']);
    expect(output).toContain('First local objective.');
    expect(output).toContain('Second local objective.');
    expect(output).not.toContain('Foreign private objective.');
    expect(await client.execute(['tasks', 'list', '--active'])).toBe(
      'No tasks found.',
    );
    for (const query of [
      'limit=0',
      'limit=101',
      'status=unknown',
      'cursor=x',
      'limit=1&limit=2',
      'unknown=true',
    ])
      expect((await fetch(`${origin}/api/tasks?${query}`)).status).toBe(400);
    expect(
      (
        await fetch(origin + '/api/tasks', {
          headers: { Origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('never includes another principal or workspace in task summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-dev-inbox-'));
    const store = new TaskStore(directory);
    cleanups.push(async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    const request = {
      schema_version: 'haze.task.request.v3' as const,
      objective: 'Local objective',
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    };
    store.admit(request, localTaskIdentity, randomUUID());
    const foreign = { principal: 'foreign', workspace: 'foreign' };
    store.admit(
      { ...request, objective: 'Foreign private objective' },
      foreign,
      randomUUID(),
    );
    expect(
      store
        .listTaskSummaries(localTaskIdentity)
        .tasks.map((entry) => entry.objective),
    ).toEqual(['Local objective']);
    expect(
      store.listTaskSummaries(foreign).tasks.map((entry) => entry.objective),
    ).toEqual(['Foreign private objective']);
    expect(
      store.listTaskSummaries({
        principal: localTaskIdentity.principal,
        workspace: 'foreign',
      }).tasks,
    ).toEqual([]);
  });

  it('reports registered agents and route configuration without transport secrets', async () => {
    const { origin, client } = await application();
    const output = await client.execute(['agents', 'list']);
    expect(output).toContain('Manager');
    expect(output).toContain('DamageAccountant');
    expect(output).toContain('idle');
    const detail = await client.execute(['agents', 'show', 'manager']);
    expect(detail).toContain('definitions');
    expect(detail).not.toMatch(/credential_ref|base_url|authorization/i);
    await expect(client.execute(['agents', 'show', 'missing'])).rejects.toThrow(
      'Unknown agent',
    );
    expect((await fetch(origin + '/api/agents?bad=1')).status).toBe(400);
    expect(
      (
        await fetch(origin + '/api/agents', {
          method: 'POST',
          headers: { Origin: origin },
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(origin + '/api/agents', {
          headers: { Origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('admits and reads work through the real fixture API', async () => {
    const { client } = await application();
    const output = await client.execute([
      'tasks',
      'run',
      'Explain supplied evidence.',
    ]);
    expect(output).toContain('Task admitted:');
    const id = /Task admitted: ([A-Za-z0-9-]+)/u.exec(output)?.[1];
    expect(id).toBeDefined();
    expect(await client.execute(['tasks', 'show', id!])).toContain(
      'Explain supplied evidence.',
    );
    expect(await client.execute(['status', 'app'])).toContain('App: ready');
    expect(await client.execute(['status', 'world'])).toContain(
      'World Model: available',
    );
    expect(await client.execute(['nightshift', 'jobs'])).toBe(
      'No Nightshift jobs.',
    );
  });

  it('fetches current fences before controls and preserves local cancellation semantics', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      calls.push({ url: inputUrl(input), init });
      return Promise.resolve(json(init?.method === 'POST' ? receipt : task));
    });
    const client = createDevApi({
      getUrl: () => 'http://localhost:5174/',
      fetchImpl,
    });
    const output = await client.execute(['tasks', 'pause', taskId]);
    expect(calls.map((entry) => new URL(entry.url).pathname)).toEqual([
      `/api/tasks/${taskId}`,
      `/api/tasks/${taskId}/control`,
    ]);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
      schema_version: 'haze.task.control.v3',
      action: 'pause',
      expected_objective_revision: 2,
      expected_run_id: runId,
      expected_generation: 3,
      expected_state_revision: 4,
    });
    expect(new Headers(calls[1]!.init!.headers).get('Origin')).toBe(
      'http://localhost:5174',
    );
    expect(new Headers(calls[1]!.init!.headers).get('Idempotency-Key')).toMatch(
      /^[a-f0-9-]{36}$/u,
    );
    expect(calls[1]!.init!.redirect).toBe('error');
    expect(output).toContain('Remote execution termination is not confirmed');
  });

  it('answers the selected current question and rejects ambiguous or obsolete questions', async () => {
    let snapshot = task;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(json(init?.method === 'POST' ? receipt : snapshot)),
    );
    const client = createDevApi({
      getUrl: () => 'http://127.0.0.1:5173',
      fetchImpl,
    });
    expect(await client.execute(['tasks', 'reply', taskId, 'Klang'])).toContain(
      'Answer recorded',
    );
    const post = fetchImpl.mock.calls[1]![1]!;
    expect(JSON.parse(post.body as string)).toMatchObject({
      kind: 'clarification',
      question_id: questionId,
      passage: 'Klang',
      expected_state_revision: 4,
    });
    snapshot = {
      ...task,
      questions: [
        ...task.questions,
        { ...task.questions[0]!, id: randomUUID() },
      ],
    };
    await expect(
      client.execute(['tasks', 'reply', taskId, 'Klang']),
    ).rejects.toThrow('Choose an open question');
    expect(
      await client.execute([
        'tasks',
        'reply',
        taskId,
        'Klang',
        '--question',
        questionId,
      ]),
    ).toContain('Answer recorded');
    snapshot = {
      ...task,
      questions: [{ ...task.questions[0]!, run_id: randomUUID() }],
    };
    await expect(
      client.execute(['tasks', 'reply', taskId, 'Klang']),
    ).rejects.toThrow('no current open question');
  });

  it('keeps separate Nightshift readiness lanes and tolerates one unavailable lane', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = new URL(inputUrl(input)).pathname;
      if (path === '/api/nightshift/jobs') return Promise.resolve(json([]));
      return Promise.resolve(
        path.endsWith('jobs/readiness')
          ? json({
              ready: false,
              runtime_reachable: true,
              reason: 'No eligible fleet.',
            })
          : path.endsWith('automation/readiness')
            ? json({ error: { message: 'Gate unavailable.' } }, 503)
            : json({
                routes: [
                  {
                    role: 'Manager',
                    configured: true,
                    reachability: 'blocked',
                    reason: 'Contract unsupported.',
                  },
                ],
              }),
      );
    });
    const client = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl,
    });
    const result = await client.execute(['nightshift', 'status']);
    expect(result).toContain('Jobs: blocked');
    expect(result).toContain('runtime: reachable');
    expect(result).toContain('Direct inference routes:');
    expect(result).toContain('Contract unsupported');
    expect(result).toContain('Automatic chains: unavailable');
    expect(result).toContain('Job inbox: 0 job(s)');
  });

  it('rejects remote app origins, invalid commands, wrong task identities and non-JSON responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(task)));
    await expect(
      createDevApi({ getUrl: () => 'https://example.com', fetchImpl }).execute([
        'status',
        'app',
      ]),
    ).rejects.toThrow('local app URL');
    expect(fetchImpl).not.toHaveBeenCalled();
    const client = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl,
    });
    await expect(
      client.execute(['tasks', 'cancel', '../other']),
    ).rejects.toThrow('valid task or job ID');
    await expect(client.execute(['tasks', 'run'])).rejects.toThrow('Usage');
    await expect(
      client.execute(['tasks', 'show', randomUUID()]),
    ).rejects.toThrow('invalid identity');
    const html = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl: () => Promise.resolve(new Response('<html>')),
    });
    await expect(html.execute(['status', 'app'])).rejects.toThrow('non-JSON');
  });

  it('bounds transport waits, supports cancellation, and bounds response bytes', async () => {
    const pending = () => new Promise<Response>(() => {});
    const timeout = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl: pending,
      timeoutMs: 15,
    });
    await expect(timeout.execute(['status', 'app'])).rejects.toThrow(
      'timed out',
    );
    const stop = new AbortController();
    const client = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl: pending,
    });
    const waiting = client.execute(['status', 'app'], { signal: stop.signal });
    stop.abort();
    await expect(waiting).rejects.toThrow('cancelled');
    const large = createDevApi({
      getUrl: () => 'http://localhost:5173',
      fetchImpl: () => Promise.resolve(json('x'.repeat(2 * 1024 * 1024))),
    });
    await expect(large.execute(['status', 'app'])).rejects.toThrow(
      'response limit',
    );
  });
});
