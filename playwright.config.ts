import { defineConfig, devices } from '@playwright/test';
import { operatorEnv, supabaseEnv } from './tests/e2e/support/env.ts';

// F10 (#20). Needs the local stack (`pnpm db:start`); global setup resets it before each run.
// CI runs the tests tagged @core on `desktop-chrome` for a pull request, everything on
// `desktop-chrome` and `iphone` for a push to main, and every project nightly (tests/e2e/README.md).
const supabase = supabaseEnv();
const port = 5173;
/** Port of the production preview server; csp.spec.ts reads it as E2E_PREVIEW_URL. */
const previewPort = 4173;
process.env.E2E_PREVIEW_URL ??= `http://localhost:${previewPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  // The self-host journey runs against a deployed stack: playwright.selfhost.config.ts.
  testIgnore: ['**/selfhost/**', '**/visual/**'],
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: "nobody gets lost" is a reliability claim, so a flaky cross-device test is a bug.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'ipad', use: { ...devices['iPad Pro 11'] } },
    { name: 'galaxy-tab', use: { ...devices['Galaxy Tab S9'] } },
  ],
  webServer: [
    {
      command: `pnpm --filter @qm/web exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Only public values reach the browser bundle.
      env: {
        VITE_SUPABASE_URL: supabase.url,
        VITE_SUPABASE_ANON_KEY: supabase.anonKey,
        ...operatorEnv,
      },
    },
    {
      // The production build behind `vite preview`, which sends public/_headers. csp.spec.ts
      // needs it: the dev server injects inline styles and has no security headers (#74).
      command: `pnpm --filter @qm/web build && pnpm --filter @qm/web exec vite preview --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        VITE_SUPABASE_URL: supabase.url,
        VITE_SUPABASE_ANON_KEY: supabase.anonKey,
        ...operatorEnv,
      },
    },
  ],
});
