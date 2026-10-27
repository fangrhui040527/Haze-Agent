/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { generalApiPlugin } from './scripts/general-api-plugin.ts';
import { devDisplayPlugin } from './scripts/dev-display-plugin.ts';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), generalApiPlugin(), devDisplayPlugin()],
  server: {
    open: false,
    // A fallback port would start a second runtime against the same state.
    strictPort: true,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
