import { defineConfig, devices } from '@playwright/test';

// By default the suite starts its own stack (real nats-server, real worker + server from dist,
// fake OpenAI upstream) and talks to it over real HTTPS with the dev self-signed cert.
// Set E2E_START_STACK=0 and E2E_BASE_URL to point at an already-running deployment instead.
const startStack = process.env.E2E_START_STACK !== '0';
const insecure = process.env.E2E_INSECURE_TLS === '1' || startStack;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost:8443',
    ignoreHTTPSErrors: insecure,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
