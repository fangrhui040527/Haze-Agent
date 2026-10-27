import { createLogger, type Plugin } from 'vite';

/** Startup text for the root npm run dev launcher. Warnings and errors stay visible. */
export function devDisplayPlugin(): Plugin {
  let removeCommandListener: (() => void) | undefined;
  const logger = createLogger('warn');

  return {
    name: 'haze-dev-display',
    apply: (_config, { mode }) =>
      process.env.HAZE_DEV_BANNER === 'true' && mode !== 'test',
    config: () => ({
      customLogger: logger,
      logLevel: 'warn',
      clearScreen: false,
    }),
    closeBundle() {
      removeCommandListener?.();
    },
    configureServer(server) {
      removeCommandListener?.();
      if (process.send) {
        const send = process.send.bind(process);
        let busy = false;
        const acknowledge = (
          id: string,
          result: { ok: true } | { ok: false; error: string },
          flushed?: () => void,
        ) => {
          send({ type: 'haze-dev-command-result', id, ...result }, (error) => {
            if (error) console.error(`Launcher IPC: ${error.message}`);
            flushed?.();
          });
        };
        const execute = async (id: string, command: 'restart' | 'stop') => {
          try {
            if (command === 'restart') {
              await server.restart();
              acknowledge(id, { ok: true });
            } else {
              await server.close();
              acknowledge(id, { ok: true }, () => {
                if (process.connected) process.disconnect?.();
                process.exitCode = 0;
              });
            }
          } catch (error) {
            acknowledge(id, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            busy = false;
          }
        };
        const onMessage = (message: unknown) => {
          if (!message || typeof message !== 'object' || Array.isArray(message))
            return;
          const value = message as Record<string, unknown>;
          if (
            Object.keys(value).length !== 3 ||
            value.type !== 'haze-dev-command' ||
            typeof value.id !== 'string' ||
            !value.id.length ||
            value.id.length > 128 ||
            (value.command !== 'restart' && value.command !== 'stop')
          )
            return;
          if (busy) {
            acknowledge(value.id, {
              ok: false,
              error: 'Another development lifecycle command is running.',
            });
            return;
          }
          busy = true;
          void execute(value.id, value.command);
        };
        const cleanup = () => {
          process.off('message', onMessage);
          server.httpServer?.off('close', cleanup);
          if (removeCommandListener === cleanup)
            removeCommandListener = undefined;
        };
        removeCommandListener = cleanup;
        process.on('message', onMessage);
        server.httpServer?.once('close', cleanup);
      }
      let startupSeconds: string | undefined;
      server.printUrls = () => {
        const urls = server.resolvedUrls;
        if (process.send) {
          process.send({
            type: 'haze-dev-ready',
            local: urls?.local ?? [],
            network: urls?.network ?? [],
          });
          return;
        }
        startupSeconds ??= (
          (Date.now() - Number(process.env.HAZE_DEV_STARTED_AT ?? Date.now())) /
          1000
        ).toFixed(1);
        console.log(
          [
            '',
            '  Haze Agent',
            `  Local development | Started in ${startupSeconds}s`,
            '',
            ...(urls?.local.map((url) => `  App     ${url}`) ?? []),
            ...(urls?.network.map((url) => `  Network ${url}`) ?? []),
            '  Frontend + backend API: READY',
            '',
            '  h + Enter: help | Ctrl+C: stop app',
            '  Zetaris stays running | docker compose stop: stop Zetaris',
            '',
          ].join('\n'),
        );
      };
    },
  };
}
