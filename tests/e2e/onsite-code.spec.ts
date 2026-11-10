import type { Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { ownerOfNewBusiness, NEW_ACCOUNT_PASSWORD } from './support/accounts.ts';
import { pair, servePairDevice } from './support/pairing.ts';

// 2A-JN6 (#116): the TV shows the on-site join code and the join page asks for it. The demo
// location serves every other spec, so this one makes a location of its own that requires the
// code. Three contexts: the TV, the guest's phone and (signed in, unused) the staff tablet.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A business of its own: the demo location serves every other spec, and a second location in
// the demo org would change which one the staff tablet opens.
async function codedLocation() {
  const { email, slug } = await ownerOfNewBusiness();
  const { data: location, error } = await service
    .schema('app')
    .from('locations')
    .update({ onsite_code_required: true, onsite_code_rotate_minutes: 2 })
    .eq('slug', slug)
    .select('id, org_id')
    .single();
  if (error) throw error;
  const { error: queueError } = await service.schema('app').from('queues').insert({
    org_id: location.org_id,
    location_id: location.id,
    name: 'Front desk',
    ticket_prefix: 'C',
  });
  if (queueError) throw queueError;
  return { id: location.id as string, slug, email };
}

async function pairingCode(email: string, locationId: string) {
  const owner = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await owner.auth.signInWithPassword({ email, password: NEW_ACCOUNT_PASSWORD });
  if (signedIn.error) throw signedIn.error;
  const { data, error } = await owner.schema('api').rpc('create_pairing_code', {
    p_location_id: locationId,
    p_kind: 'display',
    p_name: `E2E display ${randomUUID()}`,
  });
  if (error) throw error;
  return (data as { code: string }).code;
}

async function pairTv(
  display: import('@playwright/test').Page,
  location: { id: string; email: string },
) {
  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await pairingCode(location.email, location.id));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
}

test('the guest needs the code on the TV: missing, wrong, then right', async ({ devices }) => {
  const { guest, display } = devices;
  const location = await codedLocation();
  await pairTv(display, location);
  const shown = (await display
    .getByTestId('onsite-code')
    .getByText(/^\d{4}$/)
    .textContent())!;
  await expectNoSeriousA11yViolations(display);

  await guest.goto(`/q/${location.slug}`);
  await guest.getByLabel('First name').fill('Robin');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByRole('alert')).toContainText('asks for the join code');
  const field = guest.getByLabel('Join code');
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  await expect(field).toHaveAttribute('autocomplete', 'off');

  // AC2: a wrong code says to check the screen and keeps what the guest typed.
  await field.fill(shown === '0000' ? '0001' : '0000');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByText("That code isn't right. Check the screen")).toBeVisible();
  await expect(guest.getByLabel('First name')).toHaveValue('Robin');
  await expectNoSeriousA11yViolations(guest);

  await field.fill(shown);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
});

test('AC1: when the code rotates the TV shows the new one within 5 s of valid_until', async ({
  devices,
}) => {
  const { display } = devices;
  const location = await codedLocation();
  const answers = [
    { code: '1111', after: 0 },
    { code: '2222', after: 4_000 },
  ];
  const started = Date.now();
  await display.route('**/rest/v1/rpc/display_onsite_code', async (route: Route) => {
    const next =
      answers.length > 1 && Date.now() - started >= answers[1]!.after ? answers[1]! : answers[0]!;
    // The first code is valid for 4 s from the first request, the second for two minutes.
    const validUntil = new Date(
      next === answers[0] ? started + 4_000 : started + 4_000 + 120_000,
    ).toISOString();
    await route.fulfill({
      json: { required: true, code: next.code, valid_until: validUntil },
      headers: { 'content-range': '*/*' },
    });
  });
  await pairTv(display, location);

  const panel = display.getByTestId('onsite-code');
  await expect(panel).toContainText('1111');
  await expect(panel).toContainText('2222', { timeout: 9_000 });
});
