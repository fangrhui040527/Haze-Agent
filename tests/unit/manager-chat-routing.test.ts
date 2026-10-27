import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managerAgent } from '../../app/agents/manager/index.js';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import { NIGHTSHIFT_STRICT_CONTRACT } from '../../app/adapters/nightshift/runtime.js';
import type { ManagerContext } from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type { ModelRouteService } from '../../app/orchestration/model-service.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

interface ChatSession {
  send(text: string): TaskRecord;
  wait(signal?: AbortSignal): Promise<TaskRecord>;
  report(): {
    isolation: { passed: boolean; specialist_model_calls: number };
  }[];
}
const sessionUrl = new URL(
  '../../scripts/manager-chat-session.mjs',
  import.meta.url,
).href;
const { ManagerChatSession, managerOnlyModelRoutes } = (await import(
  sessionUrl
)) as {
  ManagerChatSession: new (
    runtime: TaskRuntime,
    identity: typeof localTaskIdentity,
    registry: ExecutionRegistry,
  ) => ChatSession;
  managerOnlyModelRoutes: (registry: ModelRouteService) => ModelRouteService;
};
const sandboxUrl = new URL('../../scripts/manager-sandbox.mjs', import.meta.url)
  .href;
const { createManagerSandboxRegistry } = (await import(sandboxUrl)) as {
  createManagerSandboxRegistry: (options: {
    ExecutionRegistry: typeof ExecutionRegistry;
    managerAgent: typeof managerAgent;
  }) => ExecutionRegistry;
};
const supportUrl = new URL(
  '../../scripts/manager-evaluation-support.mjs',
  import.meta.url,
).href;
const { restrictManagerEvaluationTools } = (await import(supportUrl)) as {
  restrictManagerEvaluationTools: (registry: ExecutionRegistry) => string[];
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const modelName = 'nvidia/nemotron-3.5-lightning-30b-a3b';
function configuration(profile: boolean): NodeJS.ProcessEnv {
  return {
    HAZE_PROVIDER: profile ? 'offline' : 'nightshift',
    HAZE_MODEL: profile ? 'unused-inherited-model' : modelName,
    METERLESS_TOKEN: 'synthetic-test-token',
    ...(profile
      ? {
          HAZE_MODEL_ROUTES_JSON: JSON.stringify({
            version: 1,
            profiles: { chat: { provider: 'nightshift', model: modelName } },
          }),
          HAZE_AGENT_ROUTES_JSON: JSON.stringify({
            version: 1,
            routes: { Manager: 'chat' },
          }),
        }
      : {}),
  };
}
function strictServer() {
  const state = { supported: true };
  const fetcher = vi.fn<typeof fetch>().mockImplementation((value, request) => {
    const url = new URL(
      value instanceof Request ? value.url : value.toString(),
    );
    expect(url.origin).toBe('http://127.0.0.1:8088');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer synthetic-test-token',
    });
    if (request?.method === 'GET' && url.pathname === '/v1/haze/contract') {
      expect(url.searchParams.get('model')).toBe(modelName);
      return Promise.resolve(
        Response.json({
          ...NIGHTSHIFT_STRICT_CONTRACT,
          single_call: state.supported,
          models: [modelName],
        }),
      );
    }
    if (
      request?.method === 'POST' &&
      url.pathname === '/v1/haze/chat/completions'
    ) {
      const body = JSON.parse(request.body as string) as {
        model: string;
        messages: { content: string }[];
      };
      expect(body.model).toBe(modelName);
      const context = JSON.parse(body.messages[1]!.content) as ManagerContext;
      const decision = {
        id: randomUUID(),
        run_id: context.run_id,
        generation: context.generation,
        objective_revision: context.objective_revision,
        plan_revision: context.plan_revision,
        event_cursor: context.event_cursor,
        explanation: 'Answer the isolated chat request.',
        references: [],
        action: {
          type: 'finalize',
          answer: 'The Manager can answer through the configured route.',
          work_products: [],
          sources: [],
          uncertainty: [],
          unfinished: [],
        },
      };
      return Promise.resolve(
        Response.json(
          {
            id: 'strict-chat-receipt',
            model: modelName,
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(decision),
                },
              },
            ],
            usage: { prompt_tokens: 103, completion_tokens: 120 },
          },
          {
            headers: {
              'X-Haze-Nightshift-Contract': NIGHTSHIFT_STRICT_CONTRACT.id,
            },
          },
        ),
      );
    }
    throw new Error(`Unexpected endpoint ${request?.method} ${url.pathname}`);
  });
  return { fetcher, state };
}
async function setup(profile = false) {
  const env = configuration(profile);
  const server = strictServer();
  const configured = new ModelRouteRegistry(env, server.fetcher);
  const modelRoutes = managerOnlyModelRoutes(configured);
  // The CLI performs the same read-only startup preflight before showing its prompt.
  await modelRoutes.prepare!(
    modelRoutes.snapshot().routes.Manager,
    AbortSignal.timeout(3000),
  );
  const directory = await mkdtemp(join(tmpdir(), 'haze-manager-chat-routing-'));
  const registry = createManagerSandboxRegistry({
    ExecutionRegistry,
    managerAgent,
  });
  const runtime = new TaskRuntime({
    stateDirectory: directory,
    registry,
    env,
    mode: 'live',
    modelRoutes,
  });
  restrictManagerEvaluationTools(registry);
  cleanups.push(async () => {
    await runtime.close();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Unsafe cleanup target.');
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...server,
    runtime,
    modelRoutes,
    session: new ManagerChatSession(runtime, localTaskIdentity, registry),
  };
}

describe('Manager chat live model routing', () => {
  it.each([false, true])(
    'uses the configured Nightshift Manager route with profile override %s and retains live receipts',
    async (profile) => {
      const { session, runtime, fetcher } = await setup(profile);
      for (const prompt of ['Explain an evidence gap.', 'Explain it again.']) {
        session.send(prompt);
        const task = await session.wait();
        expect(task.error).toBeUndefined();
        expect(task.status).toBe('completed');
        expect(
          runtime.store.modelRoutes.snapshot(task.current_run_id)?.routes
            .Manager,
        ).toMatchObject({ provider: 'nightshift', requested_model: modelName });
        const attempts = runtime.store.attempts(task.id, localTaskIdentity);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.receipt).toMatchObject({
          response_id: 'strict-chat-receipt',
          response_model: modelName,
          input_tokens: 103,
          output_tokens: 120,
        });
        expect(attempts[0]?.receipt).not.toHaveProperty('synthetic');
        expect(task.usage.model_calls).toBe(1);
      }
      // Startup preflight plus a fresh contract negotiation before each charged call.
      expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual([
        'GET',
        'GET',
        'POST',
        'GET',
        'POST',
      ]);
      expect(session.report().every((entry) => entry.isolation.passed)).toBe(
        true,
      );
      expect(
        session
          .report()
          .every((entry) => entry.isolation.specialist_model_calls === 0),
      ).toBe(true);
    },
  );

  it('stops before a charged completion when the contract changes after startup', async () => {
    const { session, fetcher, state } = await setup();
    state.supported = false;
    session.send('Explain an evidence gap.');
    const task = await session.wait();
    expect(task.status).toBe('failed');
    expect(task.error).toMatchObject({ code: 'model_route_unavailable' });
    expect(task.usage.model_calls).toBe(0);
    expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual([
      'GET',
      'GET',
    ]);
  });

  it('guards both completion APIs after asynchronous strict route preparation', async () => {
    const { modelRoutes, fetcher } = await setup();
    const signal = new AbortController().signal;
    const model = await modelRoutes.prepare!(
      modelRoutes.snapshot().routes.Manager,
      signal,
    );
    const input = { role: 'HazeOps', instruction: 'Do work.', context: {} };
    expect(() => model.complete(input, signal)).toThrow('refused');
    expect(() => model.completeWithReceipt!(input, signal)).toThrow('refused');
    expect(
      fetcher.mock.calls.every(([, request]) => request?.method === 'GET'),
    ).toBe(true);
  });
});
