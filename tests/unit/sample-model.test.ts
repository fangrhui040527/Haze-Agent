import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackModelBase,
  sampleModelEnvironment,
  prepareSampleModel,
} from '../../app/adapters/sample-model.js';

describe('local sample model defaults', () => {
  it('prepares and verifies one context-safe alias from cached weights without generating or downloading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let aliasExists = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(options?.body as string) as { model: string };
      if (path === '/api/create') {
        aliasExists = true;
        return Promise.resolve(Response.json({ status: 'success' }));
      }
      if (path === '/api/show' && (body.model === 'qwen2.5:7b' || aliasExists))
        return Promise.resolve(
          Response.json({ parameters: aliasExists ? 'num_ctx 16384\n' : '' }),
        );
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    try {
      await prepareSampleModel(
        { SAMPLE_MODE: 'true' },
        fetcher,
        new AbortController().signal,
      );
      await prepareSampleModel(
        { SAMPLE_MODE: 'true' },
        fetcher,
        new AbortController().signal,
      );
      expect(fetcher).toHaveBeenCalledTimes(4);
      const create = fetcher.mock.calls.find(
        ([url]) => new URL(String(url)).pathname === '/api/create',
      );
      expect(JSON.parse(create?.[1]?.body as string)).toEqual({
        model: 'haze-sample-qwen2.5-7b-16k-v1:latest',
        from: 'qwen2.5:7b',
        parameters: { num_ctx: 16384 },
        stream: false,
      });
      expect(
        fetcher.mock.calls.every(
          ([url, options]) =>
            ['/api/show', '/api/create'].includes(
              new URL(String(url)).pathname,
            ) &&
            options?.redirect === 'error' &&
            !new Headers(options?.headers).has('Authorization'),
        ),
      ).toBe(true);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('does not prepare explicit model overrides or create from an absent cached base', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    await prepareSampleModel(
      { SAMPLE_MODE: 'true', HAZE_SAMPLE_MODEL: 'my-local' },
      fetcher,
      new AbortController().signal,
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      prepareSampleModel(
        { SAMPLE_MODE: 'true' },
        fetcher,
        new AbortController().signal,
      ),
    ).rejects.toThrow('not cached');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses an actual local model for sample data without mutating inherited configuration', () => {
    const env = {
      SAMPLE_MODE: 'true',
      HAZE_PROVIDER: 'offline',
      HAZE_MODEL: 'hosted-old',
      HAZE_PROVIDER_API_KEY: 'hosted-secret',
    };
    expect(sampleModelEnvironment(env)).toMatchObject({
      HAZE_PROVIDER: 'openai-compatible',
      HAZE_MODEL: 'haze-sample-qwen2.5-7b-16k-v1:latest',
      HAZE_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
      HAZE_PROVIDER_API_KEY: '',
    });
    expect(env.HAZE_PROVIDER).toBe('offline');
    const hosted = {
      SAMPLE_MODE: 'true',
      HAZE_PROVIDER: 'nvidia',
      NVIDIA_API_KEY: 'explicit-key',
    };
    expect(sampleModelEnvironment(hosted)).toBe(hosted);
    const offline = { HAZE_PROVIDER: 'offline' };
    expect(sampleModelEnvironment(offline)).toBe(offline);
  });

  it('accepts local model overrides and rejects remote automatic fallback', () => {
    expect(
      sampleModelEnvironment({
        SAMPLE_MODE: 'true',
        HAZE_SAMPLE_MODEL: 'custom-local',
        HAZE_SAMPLE_MODEL_BASE_URL: 'http://[::1]:8080/v1',
      }),
    ).toMatchObject({
      HAZE_MODEL: 'custom-local',
      HAZE_PROVIDER_BASE_URL: 'http://[::1]:8080/v1',
    });
    expect(() =>
      sampleModelEnvironment({
        SAMPLE_MODE: 'true',
        HAZE_SAMPLE_MODEL_BASE_URL: 'https://remote.example/v1',
      }),
    ).toThrow('loopback');
  });

  it.each([
    'https://remote.example/v1',
    'http://localhost.example/v1',
    'http://127.0.0.1.example/v1',
    'http://user:secret@localhost/v1',
    'http://127.0.0.1/v1?key=secret',
    'http://127.0.0.1/v1#fragment',
    'http://127.1/v1',
    'http://2130706433/v1',
    'file:///localhost/v1',
  ])('rejects noncanonical or unsafe no-auth endpoint %s', (url) => {
    expect(isLoopbackModelBase(url)).toBe(false);
  });
});
