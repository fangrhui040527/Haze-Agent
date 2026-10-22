import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProbeProvider } from '../../app/adapters/provider.js';

const selected = {
  HAZE_PROVIDER: 'openai-compatible',
  HAZE_MODEL: 'selected-model',
  HAZE_PROVIDER_BASE_URL: 'http://localhost:11434/v1/',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('selected-provider compatibility probe', () => {
  it.each([{}, { HAZE_PROVIDER: 'offline' }])(
    'reports a skipped inference probe for offline configuration %j',
    async (env) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      const provider = resolveProbeProvider(env);

      expect(provider.selection).toEqual({ provider: 'offline', model: null });
      expect(await provider.probe()).toEqual({
        provider: 'offline',
        model: null,
        status: 'skipped',
        kind: 'offline',
        reason: expect.stringContaining('not tested') as string,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['true', '1', 'yes'])(
    'SAMPLE_MODE=%s disables even an explicitly selected provider',
    async (sampleMode) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      const provider = resolveProbeProvider({
        HAZE_PROVIDER: 'openai-compatible',
        SAMPLE_MODE: sampleMode,
      });

      expect(await provider.probe()).toMatchObject({
        status: 'skipped',
        provider: 'offline',
        reason: expect.stringContaining(
          'disabled the selected provider',
        ) as string,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('executes a single bounded request and returns only compatibility metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'HAZE_OK' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const provider = resolveProbeProvider({
      ...selected,
      HAZE_PROVIDER_API_KEY: 'test-secret',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await provider.probe();

    expect(result).toEqual({
      status: 'passed',
      kind: 'chat-completion',
      provider: 'openai-compatible',
      model: 'selected-model',
      responseCharacters: 7,
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(JSON.stringify(result)).not.toContain('HAZE_OK');
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      new URL('http://localhost:11434/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret',
        },
        body: JSON.stringify({
          model: 'selected-model',
          messages: [
            { role: 'user', content: 'Reply with the single word HAZE_OK.' },
          ],
          max_completion_tokens: 32,
          stream: false,
        }),
        signal: expect.any(AbortSignal) as AbortSignal,
        redirect: 'error',
      },
    );
  });

  it('supports a selected local endpoint without an API key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'HAZE_OK' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveProbeProvider(selected).probe()).resolves.toMatchObject(
      {
        status: 'passed',
      },
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('keeps an uncredentialed NVIDIA selection blocked without network access', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveProbeProvider({ HAZE_PROVIDER: 'nvidia' });

    expect(provider.selection).toEqual({
      provider: 'nvidia',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    });
    await expect(provider.probe()).resolves.toEqual({
      ...provider.selection,
      status: 'blocked',
      kind: 'chat-completion',
      reason:
        'NVIDIA_API_KEY or HAZE_PROVIDER_API_KEY is required; no NVIDIA request was made.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['NVIDIA_API_KEY', 'HAZE_PROVIDER_API_KEY'])(
    'uses the documented NVIDIA endpoint, model, and token parameter with %s',
    async (keyName) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'HAZE_OK' } }],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const provider = resolveProbeProvider({
        HAZE_PROVIDER: 'nvidia',
        [keyName]: 'test-secret',
      });

      await expect(provider.probe()).resolves.toMatchObject({
        status: 'passed',
        provider: 'nvidia',
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      });
      const [url, request] = fetchMock.mock.calls[0]!;
      expect(url).toEqual(
        new URL('https://integrate.api.nvidia.com/v1/chat/completions'),
      );
      expect(request?.headers).toMatchObject({
        Authorization: 'Bearer test-secret',
      });
      expect(request?.body).toBe(
        JSON.stringify({
          model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
          messages: [
            { role: 'user', content: 'Reply with the single word HAZE_OK.' },
          ],
          max_tokens: 32,
          chat_template_kwargs: { enable_thinking: false },
          stream: false,
        }),
      );
    },
  );

  it('preserves a selected NVIDIA model and does not apply default-model options', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'HAZE_OK' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = resolveProbeProvider({
      HAZE_PROVIDER: 'nvidia',
      HAZE_MODEL: 'selected-model',
      NVIDIA_API_KEY: 'test-secret',
    });

    await expect(provider.probe()).resolves.toMatchObject({
      status: 'passed',
      model: 'selected-model',
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain(
      'chat_template_kwargs',
    );
  });

  it.each([
    { HAZE_PROVIDER: 'unrecognized-secret-provider' },
    { ...selected, HAZE_MODEL: '' },
    { ...selected, HAZE_PROVIDER_BASE_URL: 'not a URL' },
    {
      ...selected,
      HAZE_PROVIDER_BASE_URL: 'https://user:secret@example.com/v1',
    },
    {
      ...selected,
      HAZE_PROVIDER_BASE_URL: 'https://example.com/v1?key=secret',
    },
    { ...selected, HAZE_PROVIDER_BASE_URL: 'file:///secret' },
  ])('rejects invalid selection without exposing configuration %j', (env) => {
    expect(() => resolveProbeProvider(env)).toThrow();
    try {
      resolveProbeProvider(env);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });

  it.each([
    { choices: [] },
    { choices: [{ message: { role: 'assistant', content: '  ' } }] },
    { choices: [{ message: { role: 'user', content: 'HAZE_OK' } }] },
    { choices: [{ message: { role: 'assistant', content: null } }] },
  ])(
    'rejects a response that does not prove assistant generation %j',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
      );

      await expect(resolveProbeProvider(selected).probe()).rejects.toThrow(
        'did not return a nonempty assistant message',
      );
    },
  );

  it('does not retry or expose an upstream HTTP error body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('test-secret', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveProbeProvider(selected).probe()).rejects.toThrow(
      /^Selected-provider probe request or response failed\.$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose network error details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('test-secret')),
    );

    await expect(resolveProbeProvider(selected).probe()).rejects.toThrow(
      /^Selected-provider probe request or response failed\.$/,
    );
  });

  it('reports an aborted request as a bounded timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')),
    );

    await expect(resolveProbeProvider(selected).probe()).rejects.toThrow(
      'timed out after 60 seconds',
    );
  });

  it.each([
    new Response('not JSON'),
    new Response('x'.repeat(65_537)),
    new Response(null),
  ])('rejects malformed or oversized responses safely', async (response) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(resolveProbeProvider(selected).probe()).rejects.toThrow(
      /^Selected-provider probe request or response failed\.$/,
    );
  });
});
