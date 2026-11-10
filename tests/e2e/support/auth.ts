import type { Page } from '@playwright/test';
import { AUTH_STORAGE_KEY } from '../../../apps/web/src/lib/auth-storage.ts';
import { supabaseEnv } from './env.ts';
import { testUsers, type TestUserRole } from './users.ts';

/**
 * Signs `page` in as a test user without driving the sign-in screen: it gets a session from
 * Supabase Auth with the user's password and stores it where the app's Supabase client looks
 * for it, before any app script runs. Call it before the first `goto`. Specs that test the
 * sign-in screen itself (A1, #41) should use the UI instead.
 */
export async function signIn(page: Page, role: TestUserRole): Promise<void> {
  await signInAs(page, testUsers[role]);
}

/** Like `signIn`, for any account (one a spec made for itself). */
export async function signInAs(
  page: Page,
  { email, password }: { email: string; password: string },
): Promise<void> {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in as ${email} failed: ${response.status} ${await response.text()}`);
  }
  const session = JSON.stringify(await response.json());
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, session] as const,
  );
}
