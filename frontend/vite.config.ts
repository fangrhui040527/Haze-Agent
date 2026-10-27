/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generalApiPlugin } from './scripts/general-api-plugin.ts';
import { devDisplayPlugin } from './scripts/dev-display-plugin.ts';

// NASA FIRMS only sends CORS headers on some responses, so the browser reaches it
// through this same-origin proxy in dev and preview.
const firmsProxy = {
  '/firms-api': {
    target: 'https://firms.modaps.eosdis.nasa.gov',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/firms-api/, '/api'),
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), generalApiPlugin(), devDisplayPlugin()],
  server: {
    open: false,
    // A fallback port would start a second runtime against the same state.
    strictPort: true,
    proxy: firmsProxy,
  },
  preview: {
    proxy: firmsProxy,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
