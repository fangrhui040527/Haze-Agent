/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generalApiPlugin } from './scripts/general-api-plugin.ts';
import { devDisplayPlugin } from './scripts/dev-display-plugin.ts';

// Vite's server.open honours $BROWSER; default to Edge unless overridden.
process.env.BROWSER ??= 'msedge';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), generalApiPlugin(), devDisplayPlugin()],
  server: {
    open: true,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
