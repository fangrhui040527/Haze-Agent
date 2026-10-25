import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentModel } from '../../app/adapters/agent-model.js';

const selected = {
  HAZE_PROVIDER: 'openai-compatible',
  HAZE_MODEL: 'selected-model',
  HAZE_PROVIDER_BASE_URL: 'https://example.com/v1/',
  HAZE_PROVIDER_API_KEY: 'test-server-secret',
};
const input = {
  role: 'HazeOps',
  instruction: 'Summarize the supplied observations without inventing data.',
  context: { crew: 'Klang', station: 'sample-station', pm25: 35 },
};

function completion(
  content = 'Observed conditions support the proposed schedule.',
) {
  return Response.json({
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content } },
    ],
  });
}

function run(fetcher: typeof fetch, env: NodeJS.ProcessEnv = selected) {
  return resolveAgentModel(env, fetcher).complete(
    input,
    new AbortController().signal,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('office agent model adapter', () => {
  it.each([{}, { HAZE_PROVIDER: 'offline' }])(
    'requires a real provider for %j without issuing a request',
    (env) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(() => resolveAgentModel(env, fetcher)).toThrow('offline mode');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['true', '1', 'yes'])(
    'enforces SAMPLE_MODE=%s before checking credentials',
    (sampleMode) => {
      const fetcher = vi.fn<typeof fetch>();
      expect(() =>
        resolveAgentModel(
          { HAZE_PROVIDER: 'nvidia', SAMPLE_MODE: sampleMode },
          fetcher,
        ),
      ).toThrow('SAMPLE_MODE disables model requests');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { HAZE_PROVIDER: 'nvidia' },
    { ...selected, HAZE_PROVIDER_API_KEY: '' },
  ])('rejects a missing key before network access for %j', (env) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => resolveAgentModel(env, fetcher)).toThrow('API_KEY');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...selected, HAZE_PROVIDER: 'secret-invalid-provider' },
    { ...selected, HAZE_MODEL: '' },
    { ...selected, HAZE_PROVIDER_BASE_URL: '' },
    {
      ...selected,
      HAZE_PROVIDER_BASE_URL: 'https://user:secret@example.com/v1',
    },
    {
      ...selected,
      HAZE_PROVIDER_BASE_URL: 'https://example.com/v1?key=secret',
    },
    { ...selected, HAZE_PROVIDER_BASE_URL: 'https://example.com/v1#secret' },
    { ...selected, HAZE_PROVIDER_BASE_URL: 'file:///secret' },
  ])('sanitizes invalid configuration %j', (env) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => resolveAgentModel(env, fetcher)).toThrow();
    try {
      resolveAgentModel(env, fetcher);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends one authenticated completion with a system role and JSON evidence context', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completion('  Validated schedule.  '));
    const model = resolveAgentModel(
      { ...selected, SAMPLE_MODE: 'false' },
      fetcher,
    );
    expect(model.selection).toEqual({
      provider: 'openai-compatible',
      model: 'selected-model',
    });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      model.complete(input, new AbortController().signal),
    ).resolves.toBe('Validated schedule.');

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://example.com/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-server-secret',
        },
        body: JSON.stringify({
          model: 'selected-model',
          messages: [
            {
              role: 'system',
              content: `You are ${input.role}.\n${input.instruction}`,
            },
            { role: 'user', content: JSON.stringify(input.context) },
          ],
          max_completion_tokens: 700,
          stream: false,
        }),
        signal: expect.any(AbortSignal) as AbortSignal,
        redirect: 'error',
      },
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(
      'test-server-secret',
    );
  });

  it.each(['NVIDIA_API_KEY', 'HAZE_PROVIDER_API_KEY'])(
    'uses the NVIDIA model, endpoint and inference options with %s',
    async (keyName) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion());
      const model = resolveAgentModel(
        { HAZE_PROVIDER: 'nvidia', [keyName]: 'test-server-secret' },
        fetcher,
      );
      expect(model.selection.model).toBe(
        'nvidia/nemotron-3.5-lightning-30b-a3b',
      );
      await model.complete(input, new AbortController().signal);
      expect(fetcher.mock.calls[0]?.[0]).toEqual(
        new URL('https://integrate.api.nvidia.com/v1/chat/completions'),
      );
      expect(fetcher.mock.calls[0]?.[1]?.body).toContain('"max_tokens":700');
      expect(fetcher.mock.calls[0]?.[1]?.body).toContain(
        '"chat_template_kwargs":{"enable_thinking":false}',
      );
      expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(
        'max_completion_tokens',
      );
    },
  );

  it('preserves explicit NVIDIA model and base URL overrides', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion());
    await run(fetcher, { ...selected, HAZE_PROVIDER: 'nvidia' });
    expect(fetcher.mock.calls[0]?.[0]).toEqual(
      new URL('https://example.com/v1/chat/completions'),
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toContain(
      '"model":"selected-model"',
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(
      'chat_template_kwargs',
    );
  });

  it.each([
    { choices: [] },
    {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: ' ' } },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: null },
        },
      ],
    },
    {
      choices: [
        { finish_reason: 'stop', message: { role: 'user', content: 'text' } },
      ],
    },
    { choices: [{ message: { role: 'assistant', content: 'text' } }] },
    {
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: 'partial' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: 'partial' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 'content_filter',
          message: { role: 'assistant', content: 'partial' },
        },
      ],
    },
  ])(
    'rejects missing, empty, or incomplete assistant output %j',
    async (body) => {
      await expect(
        run(vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))),
      ).rejects.toThrow('complete, nonempty assistant message');
    },
  );

  it.each([
    new Response('not JSON'),
    new Response('x'.repeat(65_537)),
    new Response(null),
    completion('x'.repeat(12_001)),
  ])('rejects invalid and oversized responses', async (response) => {
    await expect(
      run(vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toThrow(/Agent model/);
  });

  it('bounds the streamed body even when its content-length header is absent', async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(32_768));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      run(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))),
    ).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(4);
  });

  it('rejects oversized or nonserializable context before requesting a model', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const model = resolveAgentModel(selected, fetcher);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const context of [cyclic, 'x'.repeat(131_073), undefined]) {
      await expect(
        model.complete({ ...input, context }, new AbortController().signal),
      ).rejects.toThrow('bounded, JSON-serializable');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sanitizes upstream HTTP bodies and network errors without retrying', async () => {
    for (const fetcher of [
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('upstream-secret', { status: 401 })),
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('URL contains upstream-secret')),
    ]) {
      const error: unknown = await run(fetcher).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('secret');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('redacts the credential if an upstream message unexpectedly echoes it', async () => {
    await expect(
      run(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(completion('Echo test-server-secret')),
      ),
    ).resolves.toBe('Echo [redacted]');
  });

  it('returns the actual provider model and usage receipt from the same completion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        model: 'provider-resolved-model-v2',
        id: 'response-123',
        usage: { prompt_tokens: 219, completion_tokens: 37 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '  Cited evidence summary.  ',
            },
          },
        ],
      }),
    );
    const model = resolveAgentModel(selected, fetcher);
    expect(model.selection.model).toBe('selected-model');
    await expect(
      model.completeWithReceipt?.(input, new AbortController().signal),
    ).resolves.toEqual({
      text: 'Cited evidence summary.',
      receipt: {
        response_model: 'provider-resolved-model-v2',
        response_id: 'response-123',
        input_tokens: 219,
        output_tokens: 37,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps absent receipt fields unknown instead of inferring the configured model', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion());
    const model = resolveAgentModel(selected, fetcher);
    const result = await model.completeWithReceipt?.(
      input,
      new AbortController().signal,
    );
    expect(result?.receipt).toEqual({
      response_model: null,
      response_id: null,
      input_tokens: null,
      output_tokens: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds and sanitizes receipt metadata without inventing usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        model: 'x'.repeat(257),
        id: `echo-${selected.HAZE_PROVIDER_API_KEY}`,
        usage: { prompt_tokens: '219', completion_tokens: -1 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: `Echo ${selected.HAZE_PROVIDER_API_KEY}`,
            },
          },
        ],
      }),
    );
    const result = await resolveAgentModel(
      selected,
      fetcher,
    ).completeWithReceipt?.(input, new AbortController().signal);
    expect(result).toEqual({
      text: 'Echo [redacted]',
      receipt: {
        response_model: null,
        response_id: 'echo-[redacted]',
        input_tokens: null,
        output_tokens: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      selected.HAZE_PROVIDER_API_KEY,
    );
  });

  it('preserves zero token counts and rejects fractional or unsafe reported counts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        model: 45,
        id: '',
        usage: { prompt_tokens: 0, completion_tokens: 0.5 },
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Summary.' },
          },
        ],
      }),
    );
    const result = await resolveAgentModel(
      selected,
      fetcher,
    ).completeWithReceipt?.(input, new AbortController().signal);
    expect(result?.receipt).toEqual({
      response_model: null,
      response_id: null,
      input_tokens: 0,
      output_tokens: null,
    });
  });

  it('does not request a model when already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error('secret-reason'));
    await expect(
      resolveAgentModel(selected, fetcher).complete(input, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Agent model request was cancelled.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the upstream request and rejects even if fetch ignores it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = resolveAgentModel(selected, fetcher).complete(
      input,
      controller.signal,
    );
    controller.abort(new Error('secret-reason'));
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Agent model request was cancelled.',
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('bounds an unresponsive provider to 60 seconds and aborts the request', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = run(fetcher);
    const rejected = expect(pending).rejects.toThrow(
      'timed out after 60 seconds',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a stalled response stream when cancelled', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    const pending = resolveAgentModel(selected, fetcher).complete(
      input,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
