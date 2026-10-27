import { describe, expect, it, vi } from 'vitest';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import { modelReadinessSchema } from '../../app/contracts/model-routes.js';

const base: NodeJS.ProcessEnv = {
  HAZE_PROVIDER: 'nvidia',
  NVIDIA_API_KEY: 'default-secret',
};
function configured(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...base,
    HAZE_MODEL_ROUTES_JSON: JSON.stringify({
      version: 1,
      profiles: {
        specialist: {
          provider: 'openai-compatible',
          model: 'specialist-alias',
          base_url: 'https://specialist.example/v1/',
          credential_env: 'SPECIALIST_KEY',
        },
      },
    }),
    HAZE_AGENT_ROUTES_JSON: JSON.stringify({
      version: 1,
      routes: { HazeOps: 'specialist' },
    }),
    SPECIALIST_KEY: 'special-secret',
    ...extra,
  };
}
const input = {
  role: 'HazeOps',
  instruction: 'Return a strict action.',
  context: {},
  json_mode: true,
  max_output_tokens: 191,
};
function response(model = 'actual-v2') {
  return Response.json({
    model,
    id: 'response-1',
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"type":"finish"}' },
      },
    ],
  });
}
function requestUrl(value: Parameters<typeof fetch>[0] | undefined): string {
  return typeof value === 'string'
    ? value
    : value instanceof URL
      ? value.href
      : (value?.url ?? '');
}
describe('admitted model route registry', () => {
  it('pins credential-free local sample routes and dispatches an actual provider request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((url) =>
        Promise.resolve(
          new URL(String(url)).pathname === '/api/show'
            ? Response.json({ parameters: 'num_ctx 16384' })
            : response('qwen2.5:7b'),
        ),
      );
    const registry = new ModelRouteRegistry({ SAMPLE_MODE: 'true' }, fetcher);
    const route = registry.snapshot().routes.Manager;
    expect(route).toMatchObject({
      provider: 'openai-compatible',
      requested_model: 'haze-sample-qwen2.5-7b-16k-v1:latest',
      base_url: 'http://127.0.0.1:11434/v1',
      credential_ref: null,
      capability_contract: { id: 'ollama-sample-chat-v1' },
    });
    const readiness = await registry.readiness();
    expect(
      readiness.routes.every(
        (entry) =>
          entry.configured &&
          entry.schema_compatible &&
          entry.reachability === 'unchecked' &&
          !entry.live_verified,
      ),
    ).toBe(true);
    const model = await registry.prepare(route, new AbortController().signal);
    expect(
      await model.completeWithReceipt!(input, new AbortController().signal),
    ).toMatchObject({
      text: '{"type":"finish"}',
      receipt: { response_model: 'qwen2.5:7b', response_id: 'response-1' },
    });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });
    expect(() => new ModelRouteRegistry({}).resolve(route)).toThrow(
      'incompatible',
    );
  });

  it('retains explicit hosted profile credentials while the inherited sample route uses a local fallback', async () => {
    const env = configured({ SAMPLE_MODE: 'true', HAZE_PROVIDER: 'offline' });
    const registry = new ModelRouteRegistry(env);
    expect(registry.snapshot().routes.Manager.credential_ref).toBeNull();
    expect(registry.snapshot().routes.HazeOps).toMatchObject({
      provider: 'openai-compatible',
      credential_ref: 'env:SPECIALIST_KEY',
      base_url: 'https://specialist.example/v1',
    });
    expect(
      (await registry.readiness()).routes.every(
        (entry) => entry.reachability === 'unchecked',
      ),
    ).toBe(true);
  });
  it('preserves configured role inference and readiness when sample evidence is enabled', async () => {
    const env = configured({ SAMPLE_MODE: 'true' });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    const registry = new ModelRouteRegistry(env, fetcher);
    expect(registry.snapshot()).toEqual(
      new ModelRouteRegistry(configured()).snapshot(),
    );
    const readiness = await registry.readiness();
    expect(
      readiness.routes.every((route) => route.reachability === 'unchecked'),
    ).toBe(true);
    expect(readiness.routes.every((route) => route.schema_compatible)).toBe(
      true,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const completion = await (
      await registry.prepare(
        registry.snapshot().routes.HazeOps,
        new AbortController().signal,
      )
    ).completeWithReceipt!(input, new AbortController().signal);
    expect(completion.receipt.response_model).toBe('actual-v2');
    expect(completion.receipt.synthetic).toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://specialist.example/v1/chat/completions'),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer special-secret',
        },
      }),
    );
  });
  it('freezes independent role routes and inherited defaults without retaining secret values', () => {
    const env = configured();
    const registry = new ModelRouteRegistry(env);
    const snapshot = registry.snapshot();
    expect(snapshot.routes.HazeOps.provider).toBe('openai-compatible');
    expect(snapshot.routes.Manager.requested_model).toBe(
      'nvidia/nemotron-3.5-lightning-30b-a3b',
    );
    expect(snapshot.routes.HazeOps.base_url).toBe(
      'https://specialist.example/v1',
    );
    expect(Object.isFrozen(snapshot.routes.HazeOps)).toBe(true);
    expect(Object.isFrozen(snapshot.routes)).toBe(true);
    env.HAZE_MODEL = 'changed';
    env.HAZE_AGENT_ROUTES_JSON = '{}';
    expect(registry.snapshot()).toBe(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('special-secret');
    expect(JSON.stringify(snapshot)).not.toContain('default-secret');
    expect(new ModelRouteRegistry(configured()).snapshot()).toEqual(snapshot);
  });
  it.each([
    { HAZE_MODEL_ROUTES_JSON: '{' },
    { HAZE_MODEL_ROUTES_JSON: JSON.stringify({ version: 2, profiles: {} }) },
    {
      HAZE_AGENT_ROUTES_JSON: JSON.stringify({
        version: 1,
        routes: { Unknown: 'specialist' },
      }),
    },
    {
      HAZE_AGENT_ROUTES_JSON: JSON.stringify({
        version: 1,
        routes: { Manager: 'missing' },
      }),
    },
    {
      HAZE_MODEL_ROUTES_JSON: JSON.stringify({
        version: 1,
        profiles: { bad: { provider: 'invalid-secret', model: 'x' } },
      }),
    },
    {
      HAZE_MODEL_ROUTES_JSON: JSON.stringify({
        version: 1,
        profiles: {
          bad: {
            provider: 'openai-compatible',
            model: 'x',
            base_url: 'https://user:secret@host/v1',
          },
        },
      }),
    },
    {
      HAZE_MODEL_ROUTES_JSON: JSON.stringify({
        version: 1,
        profiles: {
          bad: {
            provider: 'openai-compatible',
            model: 'x',
            base_url: 'https://host/v1?token=secret',
          },
        },
      }),
    },
    {
      HAZE_MODEL_ROUTES_JSON: JSON.stringify({
        version: 1,
        profiles: {
          bad: {
            provider: 'nightshift',
            model: 'x',
            base_url: 'https://remote.example/v1',
          },
        },
      }),
    },
    { HAZE_PROVIDER: 'invalid-secret' },
  ])('rejects malformed configuration without echoing input %j', (extra) => {
    expect(() => new ModelRouteRegistry(configured(extra))).toThrow();
    try {
      new ModelRouteRegistry(configured(extra));
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
  it.each([
    {
      HAZE_MODEL_ROUTES_JSON:
        '{"version":1,"profiles":{"specialist":{"provider":"nvidia","model":"first-secret"},"specialist":{"provider":"nvidia","model":"second-secret"}}}',
    },
    {
      HAZE_AGENT_ROUTES_JSON:
        '{"version":1,"routes":{"Manager":"specialist","Manager":"secret-profile"}}',
    },
    {
      HAZE_MODEL_ROUTES_JSON:
        '{"version":1,"profiles":{"specialist":{"provider":"nvidia","provider":"openai-compatible","model":"secret-model","base_url":"https://host/v1"}}}',
    },
  ])(
    'rejects ambiguous duplicate route configuration without exposing values %j',
    (extra) => {
      expect(() => new ModelRouteRegistry(configured(extra))).toThrow(
        'Invalid model route configuration',
      );
      try {
        new ModelRouteRegistry(configured(extra));
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    },
  );
  it('isolates concurrent provider requests and refreshes only credentials for pinned routes', async () => {
    const env = configured();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    const registry = new ModelRouteRegistry(env, fetcher);
    const snapshot = registry.snapshot();
    const first = registry.resolve(snapshot.routes.HazeOps);
    expect(registry.resolve(snapshot.routes.HazeOps)).toBe(first);
    await Promise.all([
      first.complete(input, new AbortController().signal),
      registry
        .resolve(snapshot.routes.Manager)
        .complete({ ...input, role: 'Manager' }, new AbortController().signal),
    ]);
    const requests = fetcher.mock.calls.map(([url, request]) => ({
      url: requestUrl(url),
      headers: request?.headers as Record<string, string>,
      body: JSON.parse(request?.body as string) as Record<string, unknown>,
    }));
    expect(
      requests.find((request) => request.url.includes('specialist')),
    ).toMatchObject({
      headers: { Authorization: 'Bearer special-secret' },
      body: { model: 'specialist-alias', max_completion_tokens: 191 },
    });
    expect(
      requests.find((request) => request.url.includes('nvidia')),
    ).toMatchObject({
      headers: { Authorization: 'Bearer default-secret' },
      body: { max_tokens: 191 },
    });
    env.SPECIALIST_KEY = 'rotated-secret';
    env.HAZE_MODEL = 'changed-default';
    const rotated = registry.resolve(snapshot.routes.HazeOps);
    expect(rotated).not.toBe(first);
    expect(rotated.selection.model).toBe('specialist-alias');
    expect(registry.snapshot()).toBe(snapshot);
    const completion = await rotated.completeWithReceipt!(
      input,
      new AbortController().signal,
    );
    expect(completion.receipt.response_model).toBe('actual-v2');
    expect(completion.receipt.input_tokens).toBeNull();
    expect(completion.receipt.output_tokens).toBeNull();
  });
  it('keeps missing credentials readable and blocks only affected inference', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const registry = new ModelRouteRegistry(
      configured({ SPECIALIST_KEY: '' }),
      fetcher,
    );
    expect(() => registry.resolve(registry.snapshot().routes.HazeOps)).toThrow(
      'credential',
    );
    expect(() =>
      registry.resolve(registry.snapshot().routes.Manager),
    ).not.toThrow();
    const readiness = await registry.readiness();
    expect(
      readiness.routes.find((route) => route.role === 'HazeOps'),
    ).toMatchObject({
      configured: true,
      reachability: 'blocked',
      live_verified: false,
      role_evaluation: 'unverified',
    });
    expect(JSON.stringify(readiness)).not.toContain('credential_ref');
    expect(JSON.stringify(readiness)).not.toContain('SPECIALIST_KEY');
    expect(JSON.stringify(readiness)).not.toContain('https://specialist');
    expect(JSON.stringify(readiness)).not.toContain('default-secret');
    expect(modelReadinessSchema.safeParse(readiness).success).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects changed route or capability authority without fallback', () => {
    const registry = new ModelRouteRegistry(configured());
    const route = structuredClone(registry.snapshot().routes.Manager);
    route.requested_model = 'another';
    expect(() => registry.resolve(route)).toThrow('identity');
    route.capability_contract.hash = 'changed';
    expect(() => registry.resolve(route)).toThrow('capability contract');
  });
  it('fails closed on a configured compute restriction', async () => {
    const env = configured({
      HAZE_MODEL_ROUTES_JSON: JSON.stringify({
        version: 1,
        profiles: {
          specialist: {
            provider: 'openai-compatible',
            model: 'x',
            base_url: 'https://host/v1',
            credential_env: 'SPECIALIST_KEY',
            policy: 'local-only',
          },
        },
      }),
    });
    const registry = new ModelRouteRegistry(env);
    expect(() => registry.resolve(registry.snapshot().routes.HazeOps)).toThrow(
      'local-only',
    );
    expect(
      (await registry.readiness()).routes.find(
        (route) => route.role === 'HazeOps',
      )?.schema_compatible,
    ).toBe(false);
  });
  it('distinguishes reachable Nightshift model discovery from an inadmissible inference contract', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ id: 'installed-model' }] }));
    const registry = new ModelRouteRegistry(
      {
        HAZE_PROVIDER: 'nightshift',
        HAZE_MODEL: 'installed-model',
        METERLESS_TOKEN: 'runtime-secret',
      },
      fetcher,
    );
    const readiness = await registry.readiness();
    expect(readiness.routes).toHaveLength(5);
    expect(readiness.routes[0]).toMatchObject({
      reachability: 'reachable',
      schema_compatible: false,
      live_verified: false,
      role_evaluation: 'unverified',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:8088/v1/haze/contract?model=installed-model',
    );
    expect(() => registry.resolve(registry.snapshot().routes.Manager)).toThrow(
      'verified contract',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(readiness)).not.toContain('runtime-secret');
    expect(JSON.stringify(readiness)).not.toContain('METERLESS_TOKEN');
  });
  it('does not turn Nightshift rejection or malformed discovery into a verified route', async () => {
    for (const reply of [
      new Response('server-secret', { status: 401 }),
      new Response('invalid'),
      new Response('x'.repeat(65_537)),
    ]) {
      const registry = new ModelRouteRegistry(
        {
          HAZE_PROVIDER: 'nightshift',
          HAZE_MODEL: 'x',
          METERLESS_TOKEN: 'runtime-secret',
        },
        vi.fn<typeof fetch>().mockResolvedValue(reply),
      );
      const readiness = await registry.readiness();
      expect(readiness.routes[0]?.reachability).not.toBe('reachable');
      expect(readiness.routes[0]?.live_verified).toBe(false);
      expect(JSON.stringify(readiness)).not.toContain('server-secret');
    }
  });
  it('rejects duplicated public roles', async () => {
    const readiness = await new ModelRouteRegistry({}).readiness();
    readiness.routes[1] = readiness.routes[0]!;
    expect(modelReadinessSchema.safeParse(readiness).success).toBe(false);
  });
});
