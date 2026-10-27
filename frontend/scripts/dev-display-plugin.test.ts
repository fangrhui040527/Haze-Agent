import { EventEmitter } from 'node:events';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devDisplayPlugin } from './dev-display-plugin.ts';

const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
const originalDisconnect = Object.getOwnPropertyDescriptor(
  process,
  'disconnect',
);
const originalExitCode = process.exitCode;
const cleanups: (() => void)[] = [];
const commandListeners = new Set<(message: unknown) => void>();

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  commandListeners.clear();
  vi.restoreAllMocks();
  if (originalSend) Object.defineProperty(process, 'send', originalSend);
  else delete process.send;
  if (originalConnected)
    Object.defineProperty(process, 'connected', originalConnected);
  else Reflect.deleteProperty(process, 'connected');
  if (originalDisconnect)
    Object.defineProperty(process, 'disconnect', originalDisconnect);
  else delete process.disconnect;
  process.exitCode = originalExitCode;
});

async function configureDisplay(resolvedUrls: ViteDevServer['resolvedUrls']) {
  const existingListeners = new Set(process.listeners('message'));
  const httpServer = new EventEmitter();
  const server = {
    httpServer,
    restart: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      httpServer.emit('close');
      return Promise.resolve();
    }),
    resolvedUrls,
    printUrls: vi.fn(),
  };
  cleanups.push(() => httpServer.emit('close'));
  const hook = devDisplayPlugin().configureServer;
  if (typeof hook !== 'function') throw new Error('Expected server hook.');
  await hook.call(
    {} as ThisParameterType<typeof hook>,
    server as unknown as ViteDevServer,
  );
  for (const listener of process.listeners('message')) {
    if (!existingListeners.has(listener))
      commandListeners.add(listener as (message: unknown) => void);
  }
  return server;
}

function sendCommand(message: unknown) {
  const installed = new Set(process.listeners('message'));
  for (const listener of commandListeners) {
    if (installed.has(listener)) listener(message);
  }
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

describe('launcher lifecycle commands', () => {
  function enableIpc() {
    const send = vi.fn(
      (_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return true;
      },
    );
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: send,
    });
    return send;
  }

  it('acknowledges restart only after it completes, even when closing removes the listener', async () => {
    const send = enableIpc();
    const before = process.listenerCount('message');
    const server = await configureDisplay(null);
    let finish!: () => void;
    vi.mocked(server.restart).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          server.httpServer?.emit('close');
        }),
    );

    sendCommand({
      type: 'haze-dev-command',
      id: 'restart-1',
      command: 'restart',
    });

    expect(server.restart).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(process.listenerCount('message')).toBe(before);
    finish();
    await vi.waitFor(() =>
      expect(send.mock.calls[0]?.[0]).toEqual({
        type: 'haze-dev-command-result',
        id: 'restart-1',
        ok: true,
      }),
    );
  });

  it('awaits shutdown and flushes its acknowledgement before disconnecting', async () => {
    const send = enableIpc();
    const disconnect = vi.fn();
    Object.defineProperty(process, 'connected', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process, 'disconnect', {
      configurable: true,
      value: disconnect,
    });
    const server = await configureDisplay(null);
    let finish!: () => void;
    vi.mocked(server.close).mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let flushed: ((error: Error | null) => void) | undefined;
    send.mockImplementation((_message, callback) => {
      flushed = callback;
      return true;
    });

    sendCommand({
      type: 'haze-dev-command',
      id: 'stop-1',
      command: 'stop',
    });

    expect(server.close).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() =>
      expect(send.mock.calls[0]?.[0]).toEqual({
        type: 'haze-dev-command-result',
        id: 'stop-1',
        ok: true,
      }),
    );
    expect(disconnect).not.toHaveBeenCalled();
    flushed?.(null);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it('reports lifecycle failure and removes its command listener on close', async () => {
    const send = enableIpc();
    const before = process.listenerCount('message');
    const server = await configureDisplay(null);
    vi.mocked(server.restart).mockRejectedValue(new Error('restart failed'));

    sendCommand({
      type: 'haze-dev-command',
      id: 'restart-2',
      command: 'restart',
    });

    await vi.waitFor(() =>
      expect(send.mock.calls[0]?.[0]).toEqual({
        type: 'haze-dev-command-result',
        id: 'restart-2',
        ok: false,
        error: 'restart failed',
      }),
    );
    server.httpServer?.emit('close');
    expect(process.listenerCount('message')).toBe(before);
    sendCommand({
      type: 'haze-dev-command',
      id: 'ignored',
      command: 'restart',
    });
    expect(server.restart).toHaveBeenCalledOnce();
  });

  it('ignores malformed messages and unsupported commands', async () => {
    const send = enableIpc();
    const server = await configureDisplay(null);
    for (const message of [
      null,
      [],
      { type: 'haze-dev-command', id: 'x', command: 'start' },
      { type: 'haze-dev-command', id: '', command: 'stop' },
      { type: 'haze-dev-command', id: 4, command: 'restart' },
      { type: 'haze-dev-command', id: 'x', command: 'stop', extra: true },
    ]) {
      sendCommand(message);
    }
    expect(server.restart).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not install a command listener without launcher IPC', async () => {
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: undefined,
    });
    const before = process.listenerCount('message');
    await configureDisplay(null);
    expect(process.listenerCount('message')).toBe(before);
  });
});
