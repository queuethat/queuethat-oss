import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { noonTz } from './clock.ts';
import { supabaseEnv } from './env.ts';
import { uniqueEmail } from './mail.ts';

const env = supabaseEnv();
const admin = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Password for accounts made by `confirmedAccount`. */
export const NEW_ACCOUNT_PASSWORD = 'a-long-password';

/**
 * A fresh, confirmed account that belongs to no organization. Created through the Auth admin API
 * rather than by signing up and opening the emailed link: waiting on the mail catcher late in a
 * loaded suite flaked (counters-admin.spec on iPad, browser pass 8), and the emailed link has its own tests
 * in auth.spec.ts.
 */
export async function confirmedAccount(): Promise<string> {
  const email = uniqueEmail('link');
  const { error } = await admin.auth.admin.createUser({
    email,
    password: NEW_ACCOUNT_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  return email;
}

/** An access token for an account made by `confirmedAccount`. */
export async function accessToken(email: string): Promise<string> {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: NEW_ACCOUNT_PASSWORD }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Calls PostgREST as `email` on the `app` schema, so RLS decides what happens. */
export async function restAs(email: string, path: string, init: RequestInit = {}) {
  const { url, anonKey } = supabaseEnv();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${await accessToken(email)}`,
      'accept-profile': 'app',
      'content-profile': 'app',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

/** Reads app tables as `email`, one JSON body per path. */
export async function readAs(email: string, paths: string[]): Promise<unknown[]> {
  return Promise.all(paths.map(async (path) => (await restAs(email, path)).json()));
}

/** A fresh account that owns a one-location business in Berlin with no queues. */
export async function ownerOfNewBusiness(): Promise<{ email: string; slug: string }> {
  const email = await confirmedAccount();
  const response = await restAs(email, 'rpc/create_organization', {
    method: 'POST',
    headers: { 'content-profile': 'api' },
    body: JSON.stringify({
      p_name: `E2E Business ${Date.now()}`,
      // Unique per call: parallel creates with one name can race for the same slug.
      p_location_name: `Main Street ${randomUUID().slice(0, 8)}`,
      p_tz: noonTz(),
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const [locations] = (await readAs(email, ['locations?select=slug'])) as [{ slug: string }[]];
  return { email, slug: locations[0]!.slug };
}

/** Signs in through the sign-in screen with a `confirmedAccount` password, then opens `next`. */
export async function signInTo(page: Page, email: string, next: string): Promise<void> {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === next);
  // The app can still be navigating to `next` when the URL first matches; a goto sent in that
  // window is aborted on WebKit ("interrupted by another navigation", journeys.spec on iphone).
  await page.waitForLoadState('networkidle');
}
