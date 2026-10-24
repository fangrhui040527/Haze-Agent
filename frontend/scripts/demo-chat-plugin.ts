import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { createDemoChatHandler } from '../../app/demo/chat-http.ts';

/** Local historical harness only. Static hosting still requires a backend adapter. */
export function demoChatPlugin(): Plugin {
  let env: NodeJS.ProcessEnv = process.env;
  return {
    name: 'haze-local-demo-chat',
    configResolved(config) {
      // Server-only root configuration. Vite still exposes only VITE_* to the browser.
      env = {
        ...loadEnv(config.mode, resolve(import.meta.dirname, '../..'), ''),
        ...process.env,
      };
    },
    configureServer(server) {
      server.middlewares.use(createDemoChatHandler({ env }));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createDemoChatHandler({ env }));
    },
  };
}
