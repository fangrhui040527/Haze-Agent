import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devDisplayPlugin } from './dev-display-plugin.ts';

const originalSend = Object.getOwnPropertyDescriptor(process, 'send');

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSend) Object.defineProperty(process, 'send', originalSend);
  else delete process.send;
});

async function configureDisplay(resolvedUrls: ViteDevServer['resolvedUrls']) {
  const server = {
    resolvedUrls,
    printUrls: vi.fn(),
  } as unknown as ViteDevServer;
  const hook = devDisplayPlugin().configureServer;
  if (typeof hook !== 'function') throw new Error('Expected server hook.');
  await hook.call({} as ThisParameterType<typeof hook>, server);
  return server;
}

describe('development startup display', () => {
  it('sends readiness and URLs to the launcher without printing another banner', async () => {
    const send = vi.fn(() => true);
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: send,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await configureDisplay({
      local: ['http://localhost:5173/'],
      network: ['http://192.0.2.1:5173/'],
    });

    server.printUrls();

    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'haze-dev-ready',
      local: ['http://localhost:5173/'],
      network: ['http://192.0.2.1:5173/'],
    });
    expect(log).not.toHaveBeenCalled();

    server.printUrls();
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it('sends empty URL lists when Vite has not resolved any', async () => {
    const send = vi.fn(() => true);
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: send,
    });
    const server = await configureDisplay(null);

    server.printUrls();

    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'haze-dev-ready',
      local: [],
      network: [],
    });
  });

  it('keeps the standalone banner when no launcher IPC channel exists', async () => {
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await configureDisplay({
      local: ['http://localhost:5173/'],
      network: [],
    });

    server.printUrls();

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('Haze Agent');
    expect(log.mock.calls[0]?.[0]).toContain('http://localhost:5173/');
    expect(log.mock.calls[0]?.[0]).toContain('Frontend + backend API: READY');
  });
});
