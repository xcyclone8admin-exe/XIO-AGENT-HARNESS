// Flat config. Boundary rules implement ADR-0006 / ARCHITECTURE §3; tools/checks.mjs adds path-escape checks.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

const crossModuleInternals = {
  group: ['@xyra/mod-*/*', '!@xyra/mod-*/contracts', '!@xyra/mod-*/manifest'],
  message: 'Modules may only import another module through @xyra/mod-<id>/contracts (ADR-0006).',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/dist/**',
      '**/src/generated/**',
      'apps/web/src/schema/**',
      'packages/brain/schema/**',
      'packages/runtime/schema/**',
      'apps/desktop/**',
      '**/.wrangler/**',
      'coverage/**',
      'playwright-report/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@xyra/mod-*', '@xyra/web', '@xyra/sidecar', '@xyra/cloud'],
              message: 'packages/* never import modules or apps.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['modules/*/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            crossModuleInternals,
            {
              group: ['**/server', '**/server/**', 'node:*', '@xyra/db', '@xyra/agent-core', '@xyra/policy'],
              message: 'UI code cannot import server code, Node APIs or backend packages.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['modules/*/server/**/*.ts', 'modules/*/sample/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            crossModuleInternals,
            {
              group: ['**/ui', '**/ui/**', 'react', 'react-dom', '@xyra/ui', '@xyra/sdk'],
              message: 'Server code cannot import UI code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['modules/*/*.ts', 'modules/*/tests/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [crossModuleInternals] }] },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'tools/**/*.mjs', '**/*.config.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
