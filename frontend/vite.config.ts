/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite's server.open honours $BROWSER; default to Edge unless overridden.
process.env.BROWSER ??= 'msedge';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    open: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
