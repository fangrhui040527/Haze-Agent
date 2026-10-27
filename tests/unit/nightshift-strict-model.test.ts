import { describe, expect, it, vi } from 'vitest';
import {
  AgentModelOutcomeUnknownError,
  AgentModelResponseError,
} from '../../app/adapters/agent-model.js';
import { ModelRouteRegistry } from '../../app/adapters/model-routes.js';
import { NIGHTSHIFT_STRICT_CONTRACT } from '../../app/adapters/nightshift/runtime.js';
import { modelReadinessSchema } from '../../app/contracts/model-routes.js';

const modelName = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const env = (): NodeJS.ProcessEnv => ({
  HAZE_PROVIDER: 'nightshift',
  HAZE_MODEL: modelName,
  METERLESS_TOKEN: 'local-proxy-secret',
});
const input = {
  role: 'HazeOps',
  instruction: 'Return a strict action.',
  context: {},
  json_mode: true,
  max_output_tokens: 191,
};
const signal = () => new AbortController().signal;
function manifest(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    ...NIGHTSHIFT_STRICT_CONTRACT,
    models: [modelName],
    ...extra,
  });
}
function completion(
  extra: Record<string, unknown> = {},
  contractHeader = true,
): Response {
  return Response.json(
    {
      model: modelName,
      id: 'provider-receipt-1',
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"type":"finish"}' },
        },
      ],
      ...extra,
    },
    {
      headers: contractHeader
        ? { 'X-Haze-Nightshift-Contract': NIGHTSHIFT_STRICT_CONTRACT.id }
        : {},
    },
  );
}
function urlOf(value: Parameters<typeof fetch>[0]): URL {
  return new URL(value instanceof Request ? value.url : value.toString());
}
function strictServer(
  get: () => Response = manifest,
  post: () => Response = completion,
) {
  return vi.fn<typeof fetch>().mockImplementation((url, request) => {
    const path = urlOf(url).pathname;
    if (request?.method === 'GET' && path === '/v1/haze/contract')
      return Promise.resolve(get());
    if (request?.method === 'POST' && path === '/v1/haze/chat/completions')
      return Promise.resolve(post());
    return Promise.reject(new Error('Unexpected inference endpoint.'));
  });
}

describe('Nightshift strict inference contract', () => {
  it('negotiates exact-model authority before inference and preserves request controls and unknown usage', async () => {
    const fetcher = strictServer();
    const registry = new ModelRouteRegistry(env(), fetcher);
    const route = registry.snapshot().routes.HazeOps;
    expect(() => registry.resolve(route)).toThrow('Prepare the route');
    expect(fetcher).not.toHaveBeenCalled();
    const model = await registry.prepare(route, signal());
    expect(model.selection).toEqual({
      provider: 'nightshift',
      model: modelName,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(urlOf(fetcher.mock.calls[0]![0]).searchParams.get('model')).toBe(
      modelName,
    );
    const result = await model.completeWithReceipt!(input, signal());
    expect(result).toMatchObject({
      text: '{"type":"finish"}',
      receipt: {
        response_model: modelName,
        response_id: 'provider-receipt-1',
        input_tokens: null,
        output_tokens: null,
        response_status: 'stop',
        http_status: 200,
      },
    });
    const request = fetcher.mock.calls[1]![1]!;
    expect(JSON.parse(request.body as string)).toMatchObject({
      model: modelName,
      max_tokens: 191,
      stream: false,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer local-proxy-secret',
    });
    expect(request.redirect).toBe('error');
  });

  it.each([
    { id: 'legacy-compatible-endpoint' },
    { version: 2 },
    { model_authority: 'app-binding' },
    { output_cap: 'unverified' },
    { usage: 'missing-is-zero' },
    { finish_reason: 'synthetic-stop' },
    { reasoning: 'provider-default' },
    { structured_output: 'ignored' },
    { single_call: false },
    { models: ['different-model'] },
    { models: [modelName, 'different-model'] },
  ])('rejects incompatible preflight without dispatch %j', async (change) => {
    const fetcher = strictServer(() => manifest(change));
    const registry = new ModelRouteRegistry(env(), fetcher);
    await expect(
      registry.prepare(registry.snapshot().routes.Manager, signal()),
    ).rejects.toThrow('verified contract');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.method).toBe('GET');
  });

  it('rechecks the runtime for every admission even when its adapter is cached', async () => {
    let supported = true;
    const fetcher = strictServer(() => manifest({ single_call: supported }));
    const registry = new ModelRouteRegistry(env(), fetcher);
    const route = registry.snapshot().routes.HazeOps;
    const first = await registry.prepare(route, signal());
    expect(await registry.prepare(route, signal())).toBe(first);
    supported = false;
    await expect(registry.prepare(route, signal())).rejects.toThrow(
      'verified contract',
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.every(([, request]) => request?.method === 'GET'),
    ).toBe(true);
  });

  it('rotates only credentials while keeping the admitted route and model', async () => {
    const configuration = env();
    const fetcher = strictServer();
    const registry = new ModelRouteRegistry(configuration, fetcher);
    const snapshot = registry.snapshot();
    const first = await registry.prepare(snapshot.routes.Manager, signal());
    configuration.METERLESS_TOKEN = 'rotated-proxy-secret';
    configuration.HAZE_MODEL = 'another-model';
    const rotated = await registry.prepare(snapshot.routes.Manager, signal());
    expect(rotated).not.toBe(first);
    expect(rotated.selection.model).toBe(modelName);
    expect(registry.snapshot()).toBe(snapshot);
    await rotated.complete(input, signal());
    expect(fetcher.mock.calls[2]![1]!.headers).toMatchObject({
      Authorization: 'Bearer rotated-proxy-secret',
    });
  });

  it.each([
    ['model mismatch', () => completion({ model: 'another-model' })],
    ['missing model', () => completion({ model: null })],
    ['missing response contract', () => completion({}, false)],
    [
      'cap violation',
      () =>
        completion({ usage: { prompt_tokens: 11, completion_tokens: 192 } }),
    ],
  ])(
    'rejects %s while retaining the provider receipt and original output',
    async (_label, reply) => {
      const registry = new ModelRouteRegistry(
        env(),
        strictServer(manifest, reply),
      );
      const model = await registry.prepare(
        registry.snapshot().routes.Manager,
        signal(),
      );
      await expect(
        model.completeWithReceipt!(input, signal()),
      ).rejects.toMatchObject({
        receipt: { response_id: 'provider-receipt-1', http_status: 200 },
        output: '{"type":"finish"}',
      });
    },
  );

  it.each(['length', 'content_filter', 'tool_calls', null])(
    'retains and rejects upstream finish reason %j',
    async (finishReason) => {
      const fetcher = strictServer(manifest, () =>
        completion({
          choices: [
            {
              finish_reason: finishReason,
              message: { role: 'assistant', content: '{"type":"finish"}' },
            },
          ],
          usage: { prompt_tokens: 21, completion_tokens: 191 },
        }),
      );
      const registry = new ModelRouteRegistry(env(), fetcher);
      const model = await registry.prepare(
        registry.snapshot().routes.Manager,
        signal(),
      );
      const result = model.completeWithReceipt!(input, signal());
      await expect(result).rejects.toBeInstanceOf(AgentModelResponseError);
      await expect(result).rejects.toMatchObject({
        receipt: {
          response_status: finishReason,
          input_tokens: 21,
          output_tokens: 191,
        },
        output: '{"type":"finish"}',
      });
    },
  );

  it('keeps genuine zero token usage distinct from missing usage', async () => {
    const registry = new ModelRouteRegistry(
      env(),
      strictServer(manifest, () =>
        completion({
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      ),
    );
    const model = await registry.prepare(
      registry.snapshot().routes.Manager,
      signal(),
    );
    const result = await model.completeWithReceipt!(input, signal());
    expect(result.receipt.input_tokens).toBe(0);
    expect(result.receipt.output_tokens).toBe(0);
  });

  it('negotiates native schema forwarding while retaining the local action boundary', async () => {
    const fetcher = strictServer();
    const registry = new ModelRouteRegistry(env(), fetcher);
    const model = await registry.prepare(
      registry.snapshot().routes.Manager,
      signal(),
    );
    await model.complete(
      { ...input, output_schema: { type: 'object', properties: {} } },
      signal(),
    );
    const body = JSON.parse(
      fetcher.mock.calls[1]![1]!.body as string,
    ) as Record<string, unknown>;
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
  });

  it('reports negotiated compatibility separately from live verification and role quality', async () => {
    const fetcher = strictServer();
    const registry = new ModelRouteRegistry(env(), fetcher);
    const readiness = await registry.readiness();
    expect(readiness.routes).toHaveLength(5);
    expect(readiness.routes.every((route) => route.schema_compatible)).toBe(
      true,
    );
    expect(readiness.routes[0]).toMatchObject({
      reachability: 'reachable',
      live_verified: false,
      role_evaluation: 'unverified',
    });
    expect(modelReadinessSchema.safeParse(readiness).success).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const publicBody = JSON.stringify(readiness);
    expect(publicBody).not.toContain('local-proxy-secret');
    expect(publicBody).not.toContain('METERLESS_TOKEN');
    expect(publicBody).not.toContain('127.0.0.1');
    expect(publicBody).not.toContain('credential_ref');
  });

  it('does not silently upgrade historical unverified route snapshots', async () => {
    const fetcher = strictServer();
    const registry = new ModelRouteRegistry(env(), fetcher);
    const route = structuredClone(registry.snapshot().routes.Manager);
    route.capability_contract.id = 'nightshift-direct-contract-unverified-v1';
    await expect(registry.prepare(route, signal())).rejects.toThrow(
      'capability contract',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a hanging read-only preflight without dispatch', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const registry = new ModelRouteRegistry(env(), fetcher);
    const controller = new AbortController();
    const prepared = registry.prepare(
      registry.snapshot().routes.Manager,
      controller.signal,
    );
    controller.abort();
    await expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([502, 504])(
    'preserves an unknown provider outcome through a gateway HTTP %i without retry',
    async (status) => {
      const fetcher = strictServer(
        manifest,
        () =>
          new Response('upstream-local-proxy-secret', {
            status,
            headers: {
              'X-Haze-Nightshift-Contract': NIGHTSHIFT_STRICT_CONTRACT.id,
              'X-Haze-Nightshift-Outcome': 'unknown',
            },
          }),
      );
      const registry = new ModelRouteRegistry(env(), fetcher);
      const model = await registry.prepare(
        registry.snapshot().routes.Manager,
        signal(),
      );
      const result = model.completeWithReceipt!(input, signal());
      await expect(result).rejects.toBeInstanceOf(
        AgentModelOutcomeUnknownError,
      );
      await expect(result).rejects.not.toThrow('local-proxy-secret');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.filter(([, request]) => request?.method === 'POST'),
      ).toHaveLength(1);
    },
  );

  it('retains a known provider rejection separately from an unknown transport outcome', async () => {
    const fetcher = strictServer(
      manifest,
      () => new Response('provider-local-proxy-secret', { status: 429 }),
    );
    const registry = new ModelRouteRegistry(env(), fetcher);
    const model = await registry.prepare(
      registry.snapshot().routes.Manager,
      signal(),
    );
    await expect(
      model.completeWithReceipt!(input, signal()),
    ).rejects.toMatchObject({
      receipt: { http_status: 429, response_model: null, output_tokens: null },
      output: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
