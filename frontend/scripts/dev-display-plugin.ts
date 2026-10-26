import { stripVTControlCharacters } from 'node:util';
import { createLogger, type Plugin } from 'vite';

/** Startup text for the root npm run dev launcher. Warnings and errors stay visible. */
export function devDisplayPlugin(): Plugin {
  const logger = createLogger();
  const info = logger.info.bind(logger);
  logger.info = (message, options) => {
    const text = stripVTControlCharacters(message).trim();
    if (
      text.startsWith('VITE v') ||
      text.startsWith('Re-optimizing dependencies because') ||
      text.endsWith('press h + enter to show help')
    )
      return;
    info(message, options);
  };

  return {
    name: 'haze-dev-display',
    apply: (_config, { mode }) =>
      process.env.HAZE_DEV_BANNER === 'true' && mode !== 'test',
    config: () => ({ customLogger: logger, clearScreen: false }),
    configureServer(server) {
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
