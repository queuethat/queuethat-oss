import { defineConfig, devices } from '@playwright/test';

// Runs the day-in-the-shop journey against the live pilot: `pnpm test:e2e:pilot`
// Unlike playwright.config.ts it starts no servers and has
// no global setup, so it never resets a database. The journey creates one queue and one TV
// pairing in the shop and removes both at the end.
//
//   PUBLIC_URL                  the web app, e.g. https://queue.example.com
//   E2E_SUPABASE_URL            the Supabase project URL (public)
//   E2E_SUPABASE_ANON_KEY       the anon key (public)
//   PILOT_LOCATION_SLUG         the shop's join page is /q/<slug>
//   PILOT_OWNER_EMAIL/_PASSWORD, PILOT_STAFF_EMAIL/_PASSWORD   two test accounts of that shop
const baseURL = process.env.PUBLIC_URL;
if (!baseURL)
  throw new Error('Set PUBLIC_URL to the pilot web app, e.g. https://queue.example.com');
// Read by tests/e2e/support (shop, env, users) to take the pilot path.
process.env.E2E_PILOT = '1';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'day-in-the-shop.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
});
