import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

// 2P-OPS6 (#212): a stack started with DEMO_MODE=true shows the banner and the seeded Demo Barber
// organization, signs in with the generated DEMO_PASSWORD only, and has no platform operator.
// Env: SELFHOST_DEMO=1, SELFHOST_DEMO_PASSWORD, plus the variables of smoke.spec.ts.

const url = process.env.SELFHOST_URL!;
const anonKey = process.env.SELFHOST_ANON_KEY!;
const password = process.env.SELFHOST_DEMO_PASSWORD ?? '';
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

test.skip(process.env.SELFHOST_DEMO !== '1', 'needs a stack started with DEMO_MODE=true');

test('the banner shows and the demo shop takes guests', async ({ page }) => {
  await page.goto('/q/demo-barber');
  await expect(page.getByTestId('demo-banner')).toContainText('Demo mode');
  await expect(page.getByRole('heading', { name: 'Join the queue' })).toBeVisible();
});

test('the generated password works; password123 and the operator account do not', async () => {
  const auth = createClient(url, anonKey, noSession).auth;
  const ok = await auth.signInWithPassword({ email: 'owner@demo.test', password });
  expect(ok.error).toBeNull();
  const shared = await auth.signInWithPassword({
    email: 'owner@demo.test',
    password: 'password123',
  });
  expect(shared.error).not.toBeNull();
  const ops = await auth.signInWithPassword({ email: 'ops@demo.test', password });
  expect(ops.error).not.toBeNull();
});

test('the owner signs in and reaches the demo shop', async ({ page }) => {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill('owner@demo.test');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
});
