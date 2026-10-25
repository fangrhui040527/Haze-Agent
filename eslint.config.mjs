import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.state/**',
      'tmp/**',
      'vendor/**',
      'third_party/**',
      'app/adapters/zetaris/**',
    ],
  },
  {
    files: [
      'app/tasks/**/*.ts',
      'app/orchestration/**/*.ts',
      'app/adapters/**/*.ts',
      'app/checkpoints/**/*.ts',
      'app/contracts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/capabilities/**', '**/agents/**'],
              message:
                'Register domain implementations at app/composition.ts; core infrastructure must remain domain independent.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
