import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { operatorEnv, supabaseEnv } from './tests/e2e/support/env.ts';

// Browser specs for ee/ pages. The web app is built with the ee extensions installed
// (QT_WEB_EXTENSIONS), which the core suite in playwright.config.ts never is. Needs the local stack.
const supabase = supabaseEnv();
const port = 5174;

export default defineConfig({
  testDir: './ee/tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: `pnpm --filter @qm/web exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: supabase.url,
      VITE_SUPABASE_ANON_KEY: supabase.anonKey,
      QT_WEB_EXTENSIONS: fileURLToPath(new URL('./ee/web/extensions.ts', import.meta.url)),
      ...operatorEnv,
    },
  },
});
