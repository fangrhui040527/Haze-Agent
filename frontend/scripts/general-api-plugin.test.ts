import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { PreviewServer, ViteDevServer } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { taskRequests, taskDirectories } = vi.hoisted(() => ({
  taskRequests: [] as string[],
  taskDirectories: [] as string[],
}));
vi.mock('../../app/tasks/http.ts', () => ({
  createTaskHandler: (options: { stateDirectory: string }) => {
    taskDirectories.push(options.stateDirectory);
    return Object.assign(
      (request: IncomingMessage, response: ServerResponse) => {
        taskRequests.push(request.url ?? '');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ current_task_api: true }));
      },
      { close: async () => {} },
    );
  },
}));

import { generalApiPlugin } from './general-api-plugin.ts';

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

async function requestTo(mode: 'dev' | 'preview', url: string) {
  const middlewares: Middleware[] = [];
  const server = {
    middlewares: { use: (handler: Middleware) => middlewares.push(handler) },
    httpServer: { once: vi.fn() },
  } as unknown as ViteDevServer & PreviewServer;
  const plugin = generalApiPlugin();
  const hook =
    mode === 'dev' ? plugin.configureServer : plugin.configurePreviewServer;
  if (typeof hook !== 'function')
    throw new Error('Missing server middleware hook.');
  await hook.call({} as ThisParameterType<typeof hook>, server);
  const writeHead = vi.fn();
  const end = vi.fn();
  const response = { writeHead, end } as unknown as ServerResponse;
  let nextIndex = 0;
  let fellThrough = false;
  const next = () => {
    const handler = middlewares[nextIndex++];
    if (handler) handler({ url } as IncomingMessage, response, next);
    else fellThrough = true;
  };
  next();
  return { writeHead, end, fellThrough };
}

beforeEach(() => {
  taskRequests.length = 0;
  taskDirectories.length = 0;
  vi.unstubAllEnvs();
});

describe.each(['dev', 'preview'] as const)('local task plugin (%s)', (mode) => {
  it('keeps task storage separate from the configured legacy dashboard directory', async () => {
    vi.stubEnv('STATE_DIR', '.state/legacy-dashboard');
    vi.stubEnv('HAZE_TASK_STATE_DIR', '.state/separate-general-tasks');
    await requestTo(mode, '/api/capabilities');
    expect(taskDirectories).toEqual([
      resolve(import.meta.dirname, '../..', '.state/separate-general-tasks'),
    ]);
    expect(process.env.STATE_DIR).toBe('.state/legacy-dashboard');
  });
  it('returns JSON 404 for retired and unknown API routes without starting a task runtime', async () => {
    for (const path of [
      '/api/demo/crew-scheduling/sample',
      '/api/unknown',
      '/api?unknown=true',
    ]) {
      const response = await requestTo(mode, path);
      expect(response.writeHead).toHaveBeenCalledWith(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      expect(JSON.parse(response.end.mock.calls[0]?.[0] as string)).toEqual({
        error: { code: 'not_found', message: 'API route not found.' },
      });
      expect(response.fellThrough).toBe(false);
    }
    expect(taskRequests).toEqual([]);
  });

  it('lets the current task handler answer task requests before the API fallback', async () => {
    for (const path of [
      '/api/tasks',
      '/api/tasks/current/events?after=2',
      '/api/tasks/current/updates',
      '/api/tasks/current/control',
      '/api/artifacts',
      '/api/artifacts/current',
      '/api/capabilities',
    ]) {
      const response = await requestTo(mode, path);
      expect(response.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(response.end).toHaveBeenCalledWith('{"current_task_api":true}');
      expect(response.writeHead).toHaveBeenCalledTimes(1);
      expect(response.fellThrough).toBe(false);
    }
    expect(taskRequests).toEqual([
      '/api/tasks',
      '/api/tasks/current/events?after=2',
      '/api/tasks/current/updates',
      '/api/tasks/current/control',
      '/api/artifacts',
      '/api/artifacts/current',
      '/api/capabilities',
    ]);
  });

  it('preserves page and asset requests for Vite and its SPA fallback', async () => {
    for (const path of [
      '/',
      '/item/example',
      '/demo-data',
      '/assets/current.js',
      '/apiculture',
    ]) {
      const response = await requestTo(mode, path);
      expect(response.fellThrough).toBe(true);
      expect(response.writeHead).not.toHaveBeenCalled();
      expect(response.end).not.toHaveBeenCalled();
    }
    expect(taskRequests).toEqual([]);
  });

  it('passes dashboard data and report routes to the server proxy without admitting a general task', async () => {
    for (const path of [
      '/api/health',
      '/api/snapshot',
      '/api/items/hz-example',
      '/api/stream',
      '/api/runs',
      '/api/reports/report-id/events',
    ]) {
      const response = await requestTo(mode, path);
      expect(response.fellThrough).toBe(true);
      expect(response.writeHead).not.toHaveBeenCalled();
    }
    expect(taskRequests).toEqual([]);
  });
});
