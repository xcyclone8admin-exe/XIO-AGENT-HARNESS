import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: existsSync(edgePath) ? { executablePath: edgePath } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
