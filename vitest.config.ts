import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 10_000,
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
