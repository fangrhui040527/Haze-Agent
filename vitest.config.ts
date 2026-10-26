import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // Runtime integration tests run SQLite + LangGraph end to end; shared
          // CI runners are slow enough that 10s timed out passing tests.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'postgres',
          environment: 'node',
          include: ['tests/postgres/**/*.test.ts'],
          testTimeout: 15_000,
          hookTimeout: 15_000,
        },
      },
    ],
  },
});
