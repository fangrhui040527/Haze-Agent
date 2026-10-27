import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { createTaskHandler } from '../../app/tasks/http.ts';
import { TaskError } from '../../app/contracts/tasks.ts';
import { resolveWorldAcceptancePolicy } from '../../app/tasks/world-policy.ts';
import { envFileCandidates } from '../../app/adapters/zetaris/scripts/env-files.ts';
import { sampleStateDirectory } from '../../app/adapters/sample-mode.ts';

/** One local application API for dashboard, HazeOps, tasks and the World Model. */
export function generalApiPlugin(): Plugin {
  let env: NodeJS.ProcessEnv = process.env;
  let tasks: ReturnType<typeof createTaskHandler> | undefined;
  let closing: Promise<void> | undefined;
  let lastFailure: string | undefined;
  let reportFailure = (message: string) => console.error(message);
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
      !/^\/api\/(?:tasks|agents|artifacts|capabilities|reduction-programmes|world|nightshift|health|snapshot|items|evidence|stream|hazeops|manager|runtime|heartbeat|runs|reports)(?:[/?]|$)/.test(
        request.url ?? '',
      )
    ) {
      next();
      return;
    }
    try {
      // Vite creates the next server before closing the previous one. Acquire
      // shared durable state only when an API request reaches the listening server.
      if (!tasks) {
        const policy = resolveWorldAcceptancePolicy(
          env.HAZE_WORLD_ACCEPTANCE_POLICY,
        );
        tasks = createTaskHandler({
          env,
          mode: env.HAZE_EXECUTION_MODE === 'fixture' ? 'fixture' : 'live',
          acceptancePolicy:
            policy.id === 'research-v1' ? 'research-v1' : undefined,
          stateDirectory: resolve(
            import.meta.dirname,
            '../..',
            sampleStateDirectory(env),
          ),
        });
        closing = undefined;
        lastFailure = undefined;
      }
      tasks(request, response);
    } catch (error) {
      const ownerConflict =
        error instanceof TaskError && error.code === 'runtime_owner_exists';
      if (!ownerConflict) {
        const diagnostic =
          error instanceof Error ? error.message : String(error);
        if (diagnostic !== lastFailure) {
          reportFailure(
            `Haze task runtime failed to initialize: ${diagnostic}`,
          );
          lastFailure = diagnostic;
        }
      }
      response.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(
        JSON.stringify({
          error: {
            code: ownerConflict ? error.code : 'task_runtime_unavailable',
            message: ownerConflict
              ? `${error.message} No task was admitted.`
              : 'The local task runtime could not initialize. Check the server log for the cause. No task was admitted.',
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
      reportFailure = (message) => config.logger.error(message);
      // Server-only root configuration. Vite still exposes only VITE_* to the browser.
      const sourceEnv: Record<string, string> = {};
      // Read lower-priority files first; the root .env and Vite mode settings win.
      for (const path of envFileCandidates().reverse()) {
        if (existsSync(path))
          Object.assign(sourceEnv, parseEnv(readFileSync(path, 'utf8')));
      }
      env = {
        ...sourceEnv,
        ...loadEnv(config.mode, resolve(import.meta.dirname, '../..'), ''),
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
