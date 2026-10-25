/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generalApiPlugin } from './scripts/general-api-plugin.ts';

// Vite's server.open honours $BROWSER; default to Edge unless overridden.
process.env.BROWSER ??= 'msedge';

const apiProxy = {
  '/api': {
    target: process.env.HAZE_API ?? 'http://127.0.0.1:8000',
    changeOrigin: true,
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), generalApiPlugin()],
  server: {
    open: true,
    // The Haze server (server/) listens on 127.0.0.1:8000 by default.
    proxy: apiProxy,
  },
  preview: { proxy: apiProxy },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
