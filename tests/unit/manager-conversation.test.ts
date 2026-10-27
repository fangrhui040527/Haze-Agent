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

  it.each([
    { credentials: {}, expected: 'unconfigured' },
    {
      credentials: {
        OPEN_AQ_KEY: 'PRIVATE_OPENAQ_KEY',
        FIRMS_MAP_KEY: 'PRIVATE_FIRMS_KEY',
      },
      expected: 'available',
    },
  ])(
    'exposes trusted source status $expected without exposing credentials',
    async ({ credentials, expected }) => {
      const injected = model((input) => {
        const context = input.context as {
          execution_mode: string;
          available_sources: {
            provider: string;
            status: string;
            data_kind: string;
            coverage: string;
            reliability: string;
          }[];
        };
        expect(context.execution_mode).toBe('live');
        expect(context.available_sources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              provider: 'open-meteo',
              status: 'available',
              data_kind: 'modeled',
            }),
            expect.objectContaining({
              provider: 'openaq',
              status: expected,
              data_kind: 'observation',
            }),
            expect.objectContaining({
              provider: 'firms',
              status: expected,
            }),
          ]),
        );
        const openAq = context.available_sources.find(
          (source) => source.provider === 'openaq',
        )!;
        expect(openAq.coverage).toContain('75 km');
        expect(openAq.reliability).toContain('low-cost');
        expect(
          context.available_sources.find(
            (source) => source.provider === 'firms',
          )!.coverage,
        ).toContain('bbox 95,-6,120,8');
        expect(JSON.stringify(input)).not.toContain('PRIVATE_');
        expect(input.instruction).toContain(
          'Prefer available OpenAQ observations for current Malaysian haze conditions',
        );
        expect(input.instruction).toContain(
          'the first current-conditions lookup must omit provider or select openaq',
        );
        expect(input.instruction).toContain(
          'Only say observations were unavailable or no observations were returned after an OpenAQ retrieval reports that result',
        );
        return reply();
      });
      const { service } = await setup({
        mode: 'live',
        env: credentials,
        model: injected,
      });
      await resolve(service, 'Hi');
      expect(injected.complete).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { provider: undefined, expected: 'openaq', kind: 'observed' },
    { provider: 'open-meteo', expected: 'open-meteo', kind: 'modeled' },
  ])(
    'uses $expected for a Malaysian lookup with provider $provider',
    async ({ provider, expected, kind }) => {
      const sourceResolver = vi.fn<
        NonNullable<ManagerConversationOptions['sourceResolver']>
      >((selectedProvider, location) => {
        const adapter = createFixtureCollectionAdapter({
          capability: 'evidence-collection',
          provider: selectedProvider,
          locations: [location],
        });
        const run = adapter.run.bind(adapter);
        adapter.run = async (context) => {
          const result = await run(context);
          result.evidence[0]!.record.sourceKind =
            selectedProvider === 'openaq' ? 'observation' : 'modeled';
          result.stations = [
            {
              stationId: 'openaq-test',
              name: 'Kuala Lumpur test sensor',
              lat: location.lat,
              lon: location.lon,
              provider: 'AirGradient',
              isMonitor: false,
              sensorId: 123,
              nearestLocationId: location.id,
              distanceKm: 4,
            },
          ];
          return result;
        };
        return adapter;
      });
      const injected = model((input, call) => {
        const context = input.context as {
          evidence: { id: string }[];
          retrievals: { stations: unknown[] }[];
        };
        if (call === 0)
          return {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Kuala Lumpur',
            fresh: true,
            ...(provider ? { provider } : {}),
          };
        expect(context.retrievals[0]!.stations).toEqual([
          expect.objectContaining({
            name: 'Kuala Lumpur test sensor',
            provider: 'AirGradient',
            isMonitor: false,
            distanceKm: 4,
          }),
        ]);
        return reply('Current source data.', [context.evidence[0]!.id]);
      });
      const { service } = await setup({
        mode: 'live',
        env: { OPEN_AQ_KEY: 'PRIVATE_OPENAQ_KEY' },
        model: injected,
        sourceResolver,
      });
      const result = await resolve(service, 'Current haze in Kuala Lumpur');
      expect(sourceResolver).toHaveBeenCalledExactlyOnceWith(
        expected,
        expect.objectContaining({ countryCode: 'MY' }),
      );
      expect(result.citations[0]!.kind).toBe(kind);
    },
  );

  it.each(['empty', 'failed'])(
    'reports an %s observation lookup before an explicit modeled fallback',
    async (outcome) => {
      const sourceResolver = vi.fn<
        NonNullable<ManagerConversationOptions['sourceResolver']>
      >((provider, location) => {
        const adapter = createFixtureCollectionAdapter({
          capability: 'evidence-collection',
          provider,
          locations: [location],
        });
        const run = adapter.run.bind(adapter);
        adapter.run = async (context) => {
          if (provider === 'openaq' && outcome === 'failed')
            throw new Error('PRIVATE_UPSTREAM_DIAGNOSTIC');
          const result = await run(context);
          if (provider === 'openaq') {
            result.evidence[0]!.record.sourceKind = 'observation';
            result.facts = [];
            result.coverage.covered = 0;
          }
          return result;
        };
        return adapter;
      });
      const injected = model((input, call) => {
        const context = input.context as {
          evidence: { id: string; kind: string }[];
          retrievals: {
            provider: string;
            unavailable?: string;
            source_status?: string;
          }[];
        };
        if (call === 0)
          return {
            type: 'retrieve',
            operation: 'haze_latest',
            location: 'Kuala Lumpur',
            fresh: true,
          };
        if (call === 1) {
          expect(sourceResolver).toHaveBeenCalledTimes(1);
          expect(context.retrievals[0]).toMatchObject({
            provider: 'openaq',
          });
          expect(context.retrievals[0]!.unavailable).toContain(
            outcome === 'empty' ? 'coverage gap' : 'request failed',
          );
          expect(context.retrievals[0]!.source_status).not.toBe('unconfigured');
          expect(JSON.stringify(input.context)).not.toContain('PRIVATE_');
          return {
            type: 'retrieve',
            operation: 'haze_latest',
            provider: 'open-meteo',
            location: 'Kuala Lumpur',
            fresh: true,
          };
        }
        return reply('CAMS modeled fallback; observations unavailable.', [
          context.evidence.find((entry) => entry.kind === 'modeled')!.id,
        ]);
      });
      const { service } = await setup({
        mode: 'live',
        env: { OPEN_AQ_KEY: 'PRIVATE_OPENAQ_KEY' },
        model: injected,
        sourceResolver,
      });
      const result = await resolve(service, 'Current haze in Kuala Lumpur');
      expect(sourceResolver.mock.calls.map(([provider]) => provider)).toEqual([
        'openaq',
        'open-meteo',
      ]);
      expect(result).toMatchObject({
        citations: [{ kind: 'modeled' }],
        error: { category: 'source_unavailable' },
      });
    },
  );

  it.each([
    {
      mode: 'live' as const,
      env: {},
      expected: 'unconfigured',
    },
    {
      mode: 'live' as const,
      env: { SAMPLE_MODE: 'true', OPEN_AQ_KEY: 'PRIVATE_OPENAQ_KEY' },
      expected: 'disabled_sample_mode',
    },
    {
      mode: 'replay' as const,
      env: { OPEN_AQ_KEY: 'PRIVATE_OPENAQ_KEY' },
      expected: 'disabled_replay_mode',
    },
    {
      mode: 'fixture' as const,
      env: {},
      expected: 'synthetic_fixture',
    },
  ])(
    'keeps source status $expected consistent with execution mode',
    async ({ mode, env, expected }) => {
      const injected = model((input, call) => {
        const context = input.context as {
          available_sources: { provider: string; status: string }[];
          retrievals: { source_status?: string }[];
          evidence: { id: string }[];
        };
        expect(
          context.available_sources.find(
            (source) => source.provider === 'openaq',
          )!.status,
        ).toBe(expected);
        if (call === 0)
          return {
            type: 'retrieve',
            operation: 'haze_latest',
            provider: 'openaq',
            location: 'Kuala Lumpur',
            fresh: true,
          };
        if (mode !== 'fixture')
          expect(context.retrievals[0]!.source_status).toBe(expected);
        return reply(
          'Source status checked.',
          context.evidence.map(({ id }) => id),
        );
      });
      const { service } = await setup({ mode, env, model: injected });
      const result = await resolve(service, 'Current haze in Kuala Lumpur');
      expect(result.citations.map(({ kind }) => kind)).toEqual(
        mode === 'fixture' ? ['synthetic_fixture'] : [],
      );
      if (mode !== 'fixture')
        expect(result).toMatchObject({
          error: { category: 'source_unavailable' },
        });
    },
  );

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

  it('corrects a chat reply to a dated smoke-source question towards a task', async () => {
    const injected = model((_input, call) =>
      call === 0
        ? reply('I do not have historical data for those dates.')
        : {
            type: 'start_task',
            title: 'Smoke sources over Kuching',
            objective:
              'Where did the smoke over Kuching on 24–25 October 2026 come from?',
          },
    );
    const { service } = await setup({ model: injected });
    const result = await resolve(
      service,
      'Where did the smoke over Kuching on 24–25 October 2026 come from?',
    );
    expect(result.kind).toBe('start_task');
    expect(injected.complete).toHaveBeenCalledTimes(2);
  });

  it('treats blank optional retrieval fields as not given', async () => {
    const injected = model((_input, call) =>
      call === 0
        ? {
            type: 'retrieve',
            operation: 'world_lookup',
            query: '',
            kind: '',
            record_id: '',
            location: '',
            provider: null,
            period: null,
          }
        : reply('Nothing is stored yet.'),
    );
    const { service, store } = await setup({ model: injected });
    const lookup = vi.spyOn(store.world, 'lookup');
    const result = await resolve(service, 'Look up stored information');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: 'reply',
      paragraphs: ['Nothing is stored yet.'],
    });
    expect(result).not.toHaveProperty('error');
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

  it.each([undefined, '2'])(
    'enforces the model decision budget when configured as %s',
    async (maxModelCalls) => {
      const injected = model(() => ({
        type: 'retrieve',
        operation: 'world_lookup',
      }));
      const { service, store } = await setup({
        model: injected,
        env: {
          HAZE_MANAGER_MAX_RETRIEVALS: '10',
          ...(maxModelCalls
            ? { HAZE_MANAGER_MAX_MODEL_CALLS: maxModelCalls }
            : {}),
        },
      });
      const lookup = vi.spyOn(store.world, 'lookup');
      const result = await resolve(service, 'Look up stored information');
      const expected = maxModelCalls ? Number(maxModelCalls) : 6;
      expect(injected.complete).toHaveBeenCalledTimes(expected);
      expect(lookup).toHaveBeenCalledTimes(expected);
      expect(result).toMatchObject({
        kind: 'reply',
        error: { category: 'model_output_invalid' },
      });
    },
  );

  it('can finish after more than six model decisions when the configured budgets allow it', async () => {
    const injected = model((_input, call) =>
      call < 7
        ? { type: 'retrieve', operation: 'world_lookup' }
        : reply('Lookup complete.'),
    );
    const { service, store } = await setup({
      model: injected,
      env: {
        HAZE_MANAGER_MAX_MODEL_CALLS: '8',
        HAZE_MANAGER_MAX_RETRIEVALS: '7',
      },
    });
    const lookup = vi.spyOn(store.world, 'lookup');
    expect(await resolve(service, 'Look up stored information')).toMatchObject({
      kind: 'reply',
      paragraphs: ['Lookup complete.'],
    });
    expect(injected.complete).toHaveBeenCalledTimes(8);
    expect(lookup).toHaveBeenCalledTimes(7);
    expect(countTasks(store)).toBe(0);
  });

  it.each([0, 2])(
    'stops after %i configured retrieval operations',
    async (maxRetrievals) => {
      const injected = model(() => ({
        type: 'retrieve',
        operation: 'world_lookup',
      }));
      const { service, store } = await setup({
        model: injected,
        env: { HAZE_MANAGER_MAX_RETRIEVALS: String(maxRetrievals) },
      });
      const lookup = vi.spyOn(store.world, 'lookup');
      expect(
        await resolve(service, 'Look up stored information'),
      ).toMatchObject({
        kind: 'reply',
        error: { category: 'source_unavailable' },
      });
      expect(lookup).toHaveBeenCalledTimes(maxRetrievals);
      expect(injected.complete).toHaveBeenCalledTimes(maxRetrievals + 1);
    },
  );

  it.each([0, 2])(
    'allows %i configured malformed-output corrections',
    async (maxCorrections) => {
      const injected = model((_input, call) =>
        call < 2 ? '{bad json' : reply('Corrected answer.'),
      );
      const { service } = await setup({
        model: injected,
        env: { HAZE_MANAGER_MAX_CORRECTIONS: String(maxCorrections) },
      });
      const result = await resolve(service, 'Hi');
      expect(injected.complete).toHaveBeenCalledTimes(maxCorrections + 1);
      if (maxCorrections === 0)
        expect(result).toMatchObject({
          error: { category: 'model_output_invalid' },
        });
      else
        expect(result).toMatchObject({
          kind: 'reply',
          paragraphs: ['Corrected answer.'],
        });
    },
  );

  it('shares the configured correction budget across malformed output and invalid retrieval decisions', async () => {
    const injected = model((_input, call) =>
      call === 1
        ? { type: 'retrieve', operation: 'world_context' }
        : '{bad json',
    );
    const { service } = await setup({
      model: injected,
      env: { HAZE_MANAGER_MAX_CORRECTIONS: '2' },
    });
    expect(await resolve(service, 'Hi')).toMatchObject({
      error: { category: 'model_output_invalid' },
    });
    expect(injected.complete).toHaveBeenCalledTimes(3);
  });

  it('passes configured token and decision budgets to the model', async () => {
    const injected = model(() => reply('Hello'));
    const { service } = await setup({
      model: injected,
      env: {
        HAZE_MANAGER_MAX_MODEL_CALLS: '12',
        HAZE_MANAGER_MAX_RETRIEVALS: '7',
        HAZE_MANAGER_MAX_CORRECTIONS: '2',
        HAZE_MANAGER_MAX_OUTPUT_TOKENS: '733',
      },
    });
    await resolve(service, 'Hi');
    expect(injected.complete.mock.calls[0]?.[0]).toMatchObject({
      max_output_tokens: 733,
      context: {
        model_decisions_remaining: 11,
        retrieval_operations_remaining: 7,
        corrections_remaining: 2,
      },
    });
    expect(injected.complete.mock.calls[0]?.[0].instruction).toContain(
      '7 retrieval operations and 2 malformed-output corrections',
    );
  });

  it('applies the configured deadline to a model that ignores AbortSignal', async () => {
    const injected = model(() => reply());
    injected.complete.mockImplementation(() => new Promise<string>(() => {}));
    const { service } = await setup({
      model: injected,
      env: { HAZE_MANAGER_TIMEOUT_MS: '1000' },
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = service.resolve(
        request('Hi'),
        localTaskIdentity,
        new AbortController().signal,
      );
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({
        error: { category: 'transport_failure' },
      });
      expect(injected.complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['HAZE_MANAGER_MAX_MODEL_CALLS', '0'],
    ['HAZE_MANAGER_MAX_RETRIEVALS', '33'],
    ['HAZE_MANAGER_TIMEOUT_MS', '999'],
    ['HAZE_MANAGER_MAX_OUTPUT_TOKENS', '0'],
    ['HAZE_MANAGER_MAX_CORRECTIONS', '9'],
    ['HAZE_MANAGER_MAX_MODEL_CALLS', 'Infinity'],
  ])('rejects invalid server configuration for %s', async (key, value) => {
    await expect(setup({ env: { [key]: value } })).rejects.toThrow(key);
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

  it.each([
    { maxModelCalls: '6', expectedCalls: 2 },
    { maxModelCalls: '1', expectedCalls: 1 },
  ])(
    'explains historical data requirements when the model repeats an unsupported lookup with $maxModelCalls decisions available',
    async ({ maxModelCalls, expectedCalls }) => {
      const injected = model(() => ({
        type: 'retrieve',
        operation: 'haze_latest',
        location: 'Kuala Lumpur',
        period: {
          start: '2026-09-27T00:00:00Z',
          end: '2026-10-27T00:00:00Z',
        },
      }));
      const sourceResolver = vi.fn(() => {
        throw new Error(
          'A current snapshot cannot establish historical coverage',
        );
      });
      const { service, store } = await setup({
        model: injected,
        sourceResolver,
        env: { HAZE_MANAGER_MAX_MODEL_CALLS: maxModelCalls },
      });
      const result = await resolve(
        service,
        'Which day had the worst haze in Kuala Lumpur during the past month?',
      );
      expect(result).toMatchObject({
        kind: 'reply',
        citations: [],
        error: { category: 'source_unavailable', retryable: false },
      });
      const text = result.paragraphs.join(' ');
      expect(text).toContain('Kuala Lumpur');
      expect(text).toContain('historical hourly or daily PM2.5 records');
      expect(text).toContain('daily means');
      expect(text).toContain('observed from modeled');
      expect(text).toContain('missing days');
      expect(text).not.toContain('turn’s limits');
      expect(injected.complete).toHaveBeenCalledTimes(expectedCalls);
      expect(sourceResolver).not.toHaveBeenCalled();
      expect(countTasks(store)).toBe(0);
    },
  );
});
