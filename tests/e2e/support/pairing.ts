import type { Page, Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { supabaseDeps } from '../../../supabase/functions/pair-device/deps.ts';
import { createPairDeviceHandler } from '../../../supabase/functions/pair-device/handler.ts';
import { demo } from '../../fixtures/demo.ts';
import { supabaseEnv } from './env.ts';
import { testUsers } from './users.ts';

// CI starts Supabase without the edge runtime, so the browser's call to pair-device is answered
// here by the function's own handler and Supabase wiring (supabase/functions/pair-device),
// running in Node against the real local stack. Only the Deno host is swapped out.

const env = supabaseEnv();
const pairDevice = createPairDeviceHandler(supabaseDeps(createClient, env));
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

// Each screen is its own client, as in a real shop. Without this every test shares one client
// key, and the deliberate wrong code plus reruns trip the 5-failures-per-client limit.
export async function servePairDevice(page: Page) {
  const clientIp = `198.51.100.${Math.floor(Math.random() * 254) + 1}-${crypto.randomUUID()}`;
  await page.route('**/functions/v1/pair-device', async (route: Route) => {
    const request = route.request();
    const response = await pairDevice(
      new Request(request.url(), {
        method: request.method(),
        headers: { ...request.headers(), 'x-forwarded-for': clientIp },
        body: request.method() === 'POST' ? request.postData() : undefined,
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}

/** The e2e owner's `api` client, signed in with a password. */
export async function asOwner() {
  const client = createClient(env.url, env.anonKey, noSession);
  const { error } = await client.auth.signInWithPassword(testUsers.owner);
  if (error) throw error;
  return client.schema('api');
}

// Each device gets a unique name: tests run in parallel against one database, and the revocation
// test must revoke its own TV, not another test's.
export async function newCode(
  kind: 'display' | 'kiosk',
  name = `E2E ${kind} ${crypto.randomUUID()}`,
) {
  const api = await asOwner();
  const { data, error } = await api.rpc('create_pairing_code', {
    p_location_id: demo.locationId,
    p_kind: kind,
    p_name: name,
  });
  if (error) throw error;
  return (data as { code: string }).code;
}

export { pair } from './pair-ui.ts';
