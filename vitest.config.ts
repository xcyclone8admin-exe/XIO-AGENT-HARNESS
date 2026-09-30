import { defineConfig } from 'vitest/config';

// One root config. UI tests opt into a DOM with `// @vitest-environment happy-dom`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'modules/*/**/*.test.{ts,tsx}', 'apps/*/src/**/*.test.{ts,tsx}', 'tools/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/.next/**', '**/out/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
