/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { demoChatPlugin } from './scripts/demo-chat-plugin.ts';

// Vite's server.open honours $BROWSER; default to Edge unless overridden.
process.env.BROWSER ??= 'msedge';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), demoChatPlugin()],
  server: {
    open: true,
    // The Haze server (server/) listens on 127.0.0.1:8000 by default.
    proxy: {
      '/api': {
        target: process.env.HAZE_API ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
