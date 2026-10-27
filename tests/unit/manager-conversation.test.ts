import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ManagerConversation,
  type ManagerConversationOptions,
} from '../../app/agents/manager/conversation.js';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import type { AgentModelInput } from '../../app/adapters/agent-model.js';
import { managerChatRequestSchema } from '../../app/contracts/manager-chat.js';
import { TaskStore } from '../../app/tasks/store.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import { createFixtureCollectionAdapter } from '../../app/capabilities/evidence-collection/fixtures.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const request = (message: string, extra: Record<string, unknown> = {}) =>
  managerChatRequestSchema.parse({
    schema_version: 'haze.manager.chat.request.v1',
    conversation_id: randomUUID(),
    turn_id: randomUUID(),
    message,
    ...extra,
  });
const reply = (
  text = 'The requested information is unavailable.',
  citation_ids: string[] = [],
) => ({ type: 'reply', paragraphs: [text], citation_ids });
const model = (decision: (input: AgentModelInput, call: number) => unknown) => {
  let calls = 0;
  return {
    selection: { provider: 'test', model: 'scripted' },
    complete: vi.fn((input: AgentModelInput) => {
      const output = decision(input, calls++);
      return Promise.resolve(
        typeof output === 'string' ? output : JSON.stringify(output),
      );
    }),
  };
};
async function setup(overrides: Partial<ManagerConversationOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manager-conversation-'));
  const store = new TaskStore(directory);
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options: ManagerConversationOptions = {
    store,
    mode: 'fixture',
    env: {},
    modelRoutes: new ModelRouteRegistry({}),
    ...overrides,
  };
  return { store, service: new ManagerConversation(options) };
}
const resolve = (
  service: ManagerConversation,
  message: string,
  extra: Record<string, unknown> = {},
) =>
  service.resolve(
    request(message, extra),
    localTaskIdentity,
    AbortSignal.timeout(10000),
  );
const countTasks = (store: TaskStore) =>
  (
    store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as {
      count: number;
    }
  ).count;

describe('Manager conversational routing', () => {
  it.each(['Hi', 'What causes haze?'])(
    'answers %s without admitting a task',
    async (message) => {
      const { store, service } = await setup();
      expect((await resolve(service, message)).kind).toBe('reply');
      expect(countTasks(store)).toBe(0);
    },
  );

  it('retrieves a quick lookup with synthetic fixture citations and zero admissions', async () => {
    const { service, store } = await setup();
    const result = await resolve(
      service,
      'Latest haze information for Singapore',
    );
    expect(result.kind).toBe('reply');
    expect(result.citations[0]).toMatchObject({
      kind: 'synthetic_fixture',
      observed_at: '2026-10-24T12:00:00.000Z',
    });
    expect(countTasks(store)).toBe(0);
  });

  it('asks for missing location then completes the lookup from conversation history', async () => {
    const { service, store } = await setup();
    const question = await resolve(service, 'Latest haze information');
    expect(question.kind).toBe('clarification');
    const answer = await resolve(service, 'Singapore', {
      history: [
        { role: 'user', text: 'Latest haze information' },
        { role: 'manager', text: question.paragraphs[0] },
      ],
    });
    expect(answer.kind).toBe('reply');
    expect(answer.citations).toHaveLength(1);
    expect(countTasks(store)).toBe(0);
  });

  it('returns a task request for an investigation without executing or admitting it', async () => {
    const { service, store } = await setup();
    const result = await resolve(
      service,
      'Investigate haze in Singapore and write a report',
    );
    expect(result.kind).toBe('start_task');
    if (result.kind === 'start_task')
      expect(result.request.objective).toContain('Investigate');
    expect(countTasks(store)).toBe(0);
  });

  it('prepares the configured Manager role route in production', async () => {
    const injected = model(() => reply('Hello'));
    const routes = new ModelRouteRegistry({});
    const prepare = vi.spyOn(routes, 'prepare').mockResolvedValue(injected);
    const { service } = await setup({ mode: 'live', modelRoutes: routes });
    expect((await resolve(service, 'Hi')).kind).toBe('reply');
    expect(prepare.mock.calls[0]?.[0]).toEqual(
      routes.snapshot().routes.Manager,
    );
  });

  it('allows exactly one malformed-output correction', async () => {
    const injected = model(() => '{bad json');
    const { service } = await setup({ model: injected });
    const result = await resolve(service, 'Hi');
    expect(result).toMatchObject({
      kind: 'reply',
      error: { category: 'model_output_invalid' },
    });
    expect(injected.complete).toHaveBeenCalledTimes(2);
  });

  it('rejects invented citations and permits one corrected answer', async () => {
    const injected = model((_input, call) =>
      call === 0 ? reply('Claim', ['fabricated']) : reply('Hello'),
    );
    const { service } = await setup({ model: injected });
    const result = await resolve(service, 'Hi');
    expect(result).toMatchObject({
      kind: 'reply',
      paragraphs: ['Hello'],
      citations: [],
    });
    expect(injected.complete).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated retrieval to four actual operations', async () => {
    const injected = model(() => ({
      type: 'retrieve',
      operation: 'world_lookup',
    }));
    const { service, store } = await setup({ model: injected });
    const lookup = vi.spyOn(store.world, 'lookup');
    const result = await resolve(service, 'Look up stored information');
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      kind: 'reply',
      error: { category: 'source_unavailable' },
    });
    expect(countTasks(store)).toBe(0);
  });

  it('keeps unavailable sources in chat and prevents task fallback', async () => {
    const injected = model((_input, call) =>
      call === 0
        ? {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Singapore',
            fresh: true,
          }
        : {
            type: 'start_task',
            title: 'Fallback investigation',
            objective: 'Investigate source failure',
          },
    );
    const diagnostics = vi.fn();
    const { service, store } = await setup({
      model: injected,
      diagnostic: diagnostics,
      sourceResolver() {
        throw new Error('Server diagnostic, not user text');
      },
    });
    const result = await resolve(
      service,
      'Latest haze information for Singapore',
    );
    expect(result).toMatchObject({
      kind: 'reply',
      error: { category: 'model_output_invalid' },
    });
    expect(result.paragraphs.join(' ')).not.toContain('Server diagnostic');
    expect(diagnostics).toHaveBeenCalled();
    expect(countTasks(store)).toBe(0);
  });

  it('classifies source failures separately when the model describes the gap', async () => {
    const injected = model((_input, call) =>
      call === 0
        ? {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Singapore',
            fresh: true,
          }
        : reply(),
    );
    const { service } = await setup({
      model: injected,
      sourceResolver() {
        throw new Error('No source');
      },
    });
    expect(await resolve(service, 'Latest haze in Singapore')).toMatchObject({
      error: { category: 'source_unavailable' },
    });
  });

  it('classifies model transport errors without correcting or admitting', async () => {
    const injected = model(() => {
      throw new Error('Network failed');
    });
    const { service, store } = await setup({ model: injected });
    expect(await resolve(service, 'Hi')).toMatchObject({
      error: { category: 'transport_failure' },
    });
    expect(injected.complete).toHaveBeenCalledTimes(1);
    expect(countTasks(store)).toBe(0);
  });

  it('does not send credential-bearing source URLs to the model or browser', async () => {
    const contexts: string[] = [];
    const injected = model((input, call) => {
      contexts.push(JSON.stringify(input.context));
      const context = input.context as { evidence: { id: string }[] };
      return call === 0
        ? {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Singapore',
            fresh: true,
          }
        : reply('Explicit synthetic fixture data.', [context.evidence[0]!.id]);
    });
    const { service } = await setup({
      model: injected,
      sourceResolver(provider, location) {
        const adapter = createFixtureCollectionAdapter({
          capability: 'evidence-collection',
          provider,
          locations: [location],
        });
        const run = adapter.run.bind(adapter);
        adapter.run = async (context) => {
          const result = await run(context);
          result.evidence[0]!.record.locator.url =
            'https://example.invalid/data?api_key=DO_NOT_DISCLOSE';
          return result;
        };
        return adapter;
      },
    });
    const result = await resolve(service, 'Latest haze in Singapore');
    expect(contexts.join('\n')).not.toContain('DO_NOT_DISCLOSE');
    expect(JSON.stringify(result)).not.toContain('DO_NOT_DISCLOSE');
    expect(result.citations[0]?.href).toBeUndefined();
  });

  it('enforces request history and byte bounds', () => {
    expect(() =>
      request('Hi', {
        history: Array.from({ length: 25 }, () => ({
          role: 'user',
          text: 'Hi',
        })),
      }),
    ).toThrow();
    expect(() =>
      request('Hi', {
        history: Array.from({ length: 12 }, () => ({
          role: 'user',
          text: 'x'.repeat(10000),
        })),
      }),
    ).toThrow();
  });

  it('cancels a model wait even when the injected adapter ignores AbortSignal', async () => {
    const injected = model(() => reply());
    injected.complete.mockImplementation(() => new Promise<string>(() => {}));
    const { service } = await setup({ model: injected });
    const result = await service.resolve(
      request('Hi'),
      localTaskIdentity,
      AbortSignal.timeout(10),
    );
    expect(result).toMatchObject({ error: { category: 'transport_failure' } });
    expect(injected.complete).toHaveBeenCalledTimes(1);
  });

  it('cancels a source wait even when the injected adapter ignores AbortSignal', async () => {
    const injected = model(() => ({
      type: 'retrieve',
      operation: 'haze_latest',
      location: 'Singapore',
      fresh: true,
    }));
    const { service } = await setup({
      model: injected,
      sourceResolver(provider, location) {
        const adapter = createFixtureCollectionAdapter({
          capability: 'evidence-collection',
          provider,
          locations: [location],
        });
        adapter.run = () => new Promise(() => {});
        return adapter;
      },
    });
    const result = await service.resolve(
      request('Latest haze in Singapore'),
      localTaskIdentity,
      AbortSignal.timeout(10),
    );
    expect(result).toMatchObject({ error: { category: 'transport_failure' } });
  });

  it('clarifies an ambiguous answer while allowing unrelated questions during waits', async () => {
    const refs = Array.from({ length: 2 }, () => ({
      task_id: randomUUID(),
      question_id: randomUUID(),
      expected_objective_revision: 1,
      expected_run_id: randomUUID(),
      expected_generation: 1,
      expected_state_revision: 1,
    }));
    const injected = model(() => ({
      type: 'answer_task',
      task_id: refs[0]!.task_id,
      question_id: refs[0]!.question_id,
      passage: 'yes',
    }));
    const { store, service } = await setup({ model: injected });
    vi.spyOn(store, 'read').mockImplementation((taskId) => {
      const ref = refs.find(({ task_id }) => task_id === taskId)!;
      return {
        id: taskId,
        objective_revision: 1,
        current_run_id: ref.expected_run_id,
        generation: 1,
        state_revision: 1,
        original_request: { objective: 'Tracked investigation' },
        questions: [
          {
            id: ref.question_id,
            status: 'open',
            run_id: ref.expected_run_id,
            objective_revision: 1,
            question: 'Proceed with this scope?',
          },
        ],
      } as TaskRecord;
    });
    expect((await resolve(service, 'yes', { task_questions: refs })).kind).toBe(
      'clarification',
    );
    const ordinary = new ManagerConversation({
      store,
      mode: 'fixture',
      env: {},
      modelRoutes: new ModelRouteRegistry({}),
    });
    const explanation = await resolve(ordinary, 'What causes haze?', {
      task_questions: refs,
    });
    expect(explanation.kind).toBe('reply');
    expect(explanation.paragraphs.join(' ')).toContain('particles');
  });

  it('does not return current source data as evidence for an explicit historical period', async () => {
    const injected = model((_input, call) =>
      call === 0
        ? {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Singapore',
            period: {
              start: '2026-10-26T00:00:00Z',
              end: '2026-10-27T00:00:00Z',
            },
          }
        : reply(),
    );
    const sourceResolver = vi.fn(() => {
      throw new Error('Should not retrieve a current snapshot');
    });
    const { service } = await setup({ model: injected, sourceResolver });
    const result = await resolve(service, 'Haze in Singapore yesterday');
    expect(sourceResolver).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'reply',
      citations: [],
      error: { category: 'source_unavailable' },
    });
  });
});
