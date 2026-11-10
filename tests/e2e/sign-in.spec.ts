import { AUTH_STORAGE_KEY } from '../../apps/web/src/lib/auth-storage.ts';
import { eventually, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { testUsers } from './support/users.ts';

// Guards the `signIn` hook that later browser checks rely on.
test('the staff tablet starts with a session Supabase Auth accepts', async ({ devices }) => {
  const { url, anonKey } = supabaseEnv();
  const { staff } = devices;
  await staff.goto('/staff');

  const signedInEmail = () =>
    staff.evaluate(
      async ([key, apiUrl, apikey]) => {
        const stored = window.localStorage.getItem(key);
        if (!stored) return null;
        const { access_token } = JSON.parse(stored) as { access_token: string };
        const response = await fetch(`${apiUrl}/auth/v1/user`, {
          headers: { apikey, authorization: `Bearer ${access_token}` },
        });
        return response.ok ? ((await response.json()) as { email: string }).email : null;
      },
      [AUTH_STORAGE_KEY, url, anonKey] as const,
    );
  await eventually(signedInEmail).toBe(testUsers.staff.email);
});

test.describe('signed out', () => {
  test.use({ staffUser: null });

  test('the staff tablet has no stored session', async ({ devices }) => {
    await devices.staff.goto('/staff');
    await eventually(() =>
      devices.staff.evaluate((key) => window.localStorage.getItem(key), AUTH_STORAGE_KEY),
    ).toBeNull();
  });
});
