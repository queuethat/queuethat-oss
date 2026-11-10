import { createClient } from '@supabase/supabase-js';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness } from './support/accounts.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-Q6 (#231): a location that routes offers a service picker and the database picks the queue.
// A business of its own, because routing changes the join page for the whole location.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = () => service.schema('app');

async function routedLocation() {
  const { slug } = await ownerOfNewBusiness();
  const { data: loc, error } = await app()
    .from('locations')
    .select('id, org_id')
    .eq('slug', slug)
    .single();
  if (error) throw error;
  const where = { org_id: loc.org_id, location_id: loc.id };
  const queue = async (name: string, ticket_prefix: string) => {
    const { data, error: e } = await app()
      .from('queues')
      .insert({ ...where, name, ticket_prefix })
      .select('id')
      .single();
    if (e) throw e;
    return data.id as string;
  };
  const front = await queue('Front desk', 'FRD');
  const licences = await queue('Licences', 'LIC');
  const svc = async (queue_id: string, name: string) => {
    const { data, error: e } = await app()
      .from('services')
      .insert({ ...where, queue_id, name, expected_minutes: 10 })
      .select('id')
      .single();
    if (e) throw e;
    return data.id as string;
  };
  await svc(front, 'General enquiry');
  const licence = await svc(licences, 'Licence');
  return { slug, where, front, licences, licence };
}

test('AC1: picking Licence puts the guest in the Licences queue', async ({ devices }) => {
  const { guest } = devices;
  const loc = await routedLocation();
  // The rule sends Licence to its own queue; the front desk catches the rest.
  await app()
    .from('routing_rules')
    .insert([
      { ...loc.where, rank: 0, service_id: loc.licence, target_queue_id: loc.licences },
      { ...loc.where, rank: 1, target_queue_id: loc.front },
    ]);
  await guest.goto(`/q/${loc.slug}`);
  await expect(guest.getByLabel('Queue', { exact: true })).toHaveCount(0);
  await guest.getByLabel('What do you need?').selectOption({ label: 'Licence' });
  await guest.getByLabel('First name').fill('Lena');
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await guest.waitForURL(/\/v\//);
  await expect(guest.getByText(/LIC/)).toBeVisible();
});

test('the guest is sent to the desk when no rule fits', async ({ devices }) => {
  const { guest } = devices;
  const loc = await routedLocation();
  await app()
    .from('routing_rules')
    .insert({
      ...loc.where,
      service_id: loc.licence,
      target_queue_id: loc.licences,
    });
  await guest.goto(`/q/${loc.slug}`);
  await guest.getByLabel('What do you need?').selectOption({ label: 'General enquiry' });
  await guest.getByLabel('First name').fill('Max');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByRole('alert')).toContainText('Please ask at the desk');
});
