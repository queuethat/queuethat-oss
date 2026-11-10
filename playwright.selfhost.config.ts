import { defineConfig, devices } from '@playwright/test';

// 2P-OPS7 (#213): the self-host smoke journey against a stack that is already running
// (`docker compose up -d --wait` in deploy/selfhost). No dev server and no database reset: the
// journey makes its own owner. Env: SELFHOST_URL, SELFHOST_ANON_KEY, SELFHOST_SERVICE_ROLE_KEY.
export default defineConfig({
  testDir: './tests/e2e/selfhost',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.SELFHOST_URL ?? 'http://localhost',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
