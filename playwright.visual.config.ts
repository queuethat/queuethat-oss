import { defineConfig, devices } from '@playwright/test';
import { supabaseEnv } from './tests/e2e/support/env.ts';

// DS-5 (#1009): screenshot baselines for the design tokens. `pnpm test:visual` compares, and
// `pnpm test:visual:update` rewrites the baselines (docs/ops/visual-regression.md). It is its own
// config so it runs alone after the e2e suite: the shared demo data and the global setup (database
// reset, location clocks pinned to noon) make every screen identical from run to run, which a
// parallel e2e run mutating the same queues would not.
const supabase = supabaseEnv();
const port = 5173;

export default defineConfig({
  testDir: './tests/e2e/visual',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-visual' }]],
  // One baseline per screen and project, named by platform: Linux rendering is the reference, so a
  // run on another OS fails loudly instead of comparing unlike pixels.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: `http://localhost:${port}`,
    ...devices['Desktop Chrome'],
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'visual' }],
  webServer: {
    // The dev server: /dev/ui (the component catalogue) only exists there.
    command: `pnpm --filter @qm/web exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { VITE_SUPABASE_URL: supabase.url, VITE_SUPABASE_ANON_KEY: supabase.anonKey },
  },
});
