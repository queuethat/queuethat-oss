import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { NEW_ACCOUNT_PASSWORD, ownerOfNewBusiness } from './accounts.ts';
import { supabaseEnv } from './env.ts';
import { pair, servePairDevice } from './pairing.ts';

// A location of its own per test (the demo location serves every other spec), with one queue and
// one service, so "closed" means closed. The tablet is the fixtures' staff page with nobody signed in.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
export const service = createClient(env.url, env.serviceRoleKey, noSession);

export async function shop() {
  const { email, slug } = await ownerOfNewBusiness();
  const { data: location, error } = await service
    .schema('app')
    .from('locations')
    .select('id, org_id')
    .eq('slug', slug)
    .single();
  if (error) throw error;
  const { data: queue, error: queueError } = await service
    .schema('app')
    .from('queues')
    .insert({
      org_id: location.org_id,
      location_id: location.id,
      name: 'Front desk',
      ticket_prefix: 'K',
      // Party size is a queue policy (#104): off stores 1 whatever the kiosk sends.
      party_size_enabled: true,
      party_size_max: 6,
    })
    .select('id')
    .single();
  if (queueError) throw queueError;
  const owner = createClient(env.url, env.anonKey, noSession);
  const signedIn = await owner.auth.signInWithPassword({ email, password: NEW_ACCOUNT_PASSWORD });
  if (signedIn.error) throw signedIn.error;
  const { data: code, error: codeError } = await owner.schema('api').rpc('create_pairing_code', {
    p_location_id: location.id,
    p_kind: 'kiosk',
    p_name: `E2E kiosk ${randomUUID()}`,
  });
  if (codeError) throw codeError;
  return {
    queueId: queue.id as string,
    orgId: location.org_id as string,
    code: (code as { code: string }).code,
  };
}

/** A tablet with a controllable clock, paired as the shop's kiosk and showing the welcome screen. */
export async function openKiosk(page: Page, code: string) {
  await page.clock.install();
  await servePairDevice(page);
  await page.goto('/kiosk');
  await pair(page, code);
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible();
}
