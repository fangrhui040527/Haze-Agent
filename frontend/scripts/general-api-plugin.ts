import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { createTaskHandler } from '../../app/tasks/http.ts';

/** Local evidence task API. Static hosting needs a backend. */
export function generalApiPlugin(): Plugin {
  let env: NodeJS.ProcessEnv = process.env;
  let tasks: ReturnType<typeof createTaskHandler> | undefined;
  let closing: Promise<void> | undefined;
  const closeTasks = () => {
    const current = tasks;
    return (closing ??= (async () => {
      await current?.close();
      if (tasks === current) tasks = undefined;
    })());
  };
  const taskMiddleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    if (
      !/^\/api\/(?:tasks|artifacts|capabilities)(?:[/?]|$)/.test(
        request.url ?? '',
      )
    ) {
      next();
      return;
    }
    try {
      // Vite creates the next server before closing the previous one. Acquire
      // durable state only when a task request reaches the listening server.
      if (!tasks) {
        tasks = createTaskHandler({
          env,
          mode: env.HAZE_EXECUTION_MODE === 'fixture' ? 'fixture' : 'live',
          stateDirectory: resolve(
            import.meta.dirname,
            '../..',
            env.HAZE_TASK_STATE_DIR ?? env.STATE_DIR ?? '.state/general-v2',
          ),
        });
        closing = undefined;
      }
      tasks(request, response);
    } catch {
      response.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(
        JSON.stringify({
          error: {
            code: 'task_runtime_unavailable',
            message:
              'The local task runtime is unavailable. Another server may own this state directory. Use a separate STATE_DIR or stop the other owner. No task was admitted.',
          },
        }),
      );
    }
  };
  const unknownApiMiddleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    // The dashboard server owns these routes. Let Vite proxy them after the
    // local general task handler has claimed its own endpoints.
    if (
      /^\/api\/(?:health|snapshot|items|evidence|stream|hazeops|manager|runtime|heartbeat|runs|reports)(?:[/?]|$)/.test(
        request.url ?? '',
      )
    ) {
      next();
      return;
    }
    if (!/^\/api(?:[/?]|$)/.test(request.url ?? '')) {
      next();
      return;
    }
    response.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(
      JSON.stringify({
        error: { code: 'not_found', message: 'API route not found.' },
      }),
    );
  };
  return {
    name: 'haze-local-task-api',
    // Vitest starts an internal Vite server; unit tests must not acquire live state.
    apply: (_config, { mode }) => mode !== 'test',
    configResolved(config) {
      // Server-only root configuration. Vite still exposes only VITE_* to the browser.
      const sourceEnvPath = resolve(
        import.meta.dirname,
        '../../app/adapters/zetaris/.env.local',
      );
      env = {
        ...loadEnv(config.mode, resolve(import.meta.dirname, '../..'), ''),
        ...(existsSync(sourceEnvPath)
          ? parseEnv(readFileSync(sourceEnvPath, 'utf8'))
          : {}),
        ...process.env,
      };
    },
    configureServer(server) {
      server.middlewares.use(taskMiddleware);
      server.middlewares.use(unknownApiMiddleware);
      server.httpServer?.once('close', () => {
        void closeTasks();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(taskMiddleware);
      server.middlewares.use(unknownApiMiddleware);
      server.httpServer.once('close', () => {
        void closeTasks();
      });
    },
    // Vite awaits this hook before replacing its server on a config restart.
    async closeBundle() {
      await closeTasks();
    },
  };
}
