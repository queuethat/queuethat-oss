import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { withPublicJoin } from './support/public-join.ts';
import { freshQueue } from './support/queues.ts';

// 2B-Q11 (#236): a geofenced queue asks the guest to share their position once.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PREMISES = { latitude: 51.5, longitude: -0.1 };

async function geofencedQueue() {
  const queue = await freshQueue();
  const { error: locationError } = await service
    .schema('app')
    .from('locations')
    .update({ lat: PREMISES.latitude, lng: PREMISES.longitude, geofence_m: 150 })
    .eq('id', demo.locationId);
  if (locationError) throw locationError;
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ join_restriction: 'geofence' })
    .eq('id', queue.id);
  if (error) throw error;
  return queue;
}

test('AC2: a guest who says no is told what to do instead, and nothing asks again', async ({
  devices,
}) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'dev');
  const queue = await geofencedQueue();
  let prompts = 0;
  await guest.addInitScript(() => {
    // A browser that denies the request: counted, so a loop would show.
    navigator.geolocation.getCurrentPosition = (_ok, fail) => {
      (window as unknown as { __asks: number }).__asks =
        ((window as unknown as { __asks?: number }).__asks ?? 0) + 1;
      fail?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1 } as GeolocationPositionError);
    };
  });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Geo Gus');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  const panel = guest.getByTestId('share-location');
  await expect(panel).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await panel.getByRole('button', { name: 'Share my location' }).click();
  await expect(panel.getByText(/ask staff to add you/)).toBeVisible();
  prompts = await guest.evaluate(() => (window as unknown as { __asks?: number }).__asks ?? 0);
  expect(prompts).toBe(1);
});

test('a guest at the premises shares their position once and joins', async ({ devices }) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'dev');
  const queue = await geofencedQueue();
  await guest.context().grantPermissions(['geolocation']);
  await guest.context().setGeolocation({ ...PREMISES, accuracy: 20 });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Geo Gia');
  await guest.getByRole('button', { name: 'Join the queue' }).click();

  const panel = guest.getByTestId('share-location');
  await panel.getByRole('button', { name: 'Share my location' }).click();
  await expect(panel.getByText('Location shared.')).toBeVisible();
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
});

test('a guest two kilometres away is refused even with permission', async ({ devices }) => {
  const { guest } = devices;
  await withPublicJoin(guest, 'dev');
  const queue = await geofencedQueue();
  await guest.context().grantPermissions(['geolocation']);
  await guest.context().setGeolocation({ latitude: 51.518, longitude: -0.1, accuracy: 20 });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Geo Far');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest
    .getByTestId('share-location')
    .getByRole('button', { name: 'Share my location' })
    .click();
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByText(/This queue is for people who are here/)).toBeVisible();
  await expect(guest).toHaveURL(/\/q\//);
});
