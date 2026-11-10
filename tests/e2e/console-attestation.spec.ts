import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openQueue } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';
import { enableDemoSms } from './support/sms.ts';
import { freshQueue } from './support/queues.ts';

// 3-CG4 (#329): staff say the guest agreed before texts are switched on for a walk-in.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test.beforeEach(() => enableDemoSms(service));

function randomPhone() {
  const pick = 200 + Math.floor(Math.random() * 800);
  const exchange = pick % 100 === 11 ? pick + 1 : pick; // N11 exchanges aren't numbers
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return { typed: `+1 415 ${exchange} ${line}`, e164: `+1415${exchange}${line}` };
}

async function consentsFor(e164: string) {
  const { data: contact } = await service
    .schema('app')
    .from('guest_contacts')
    .select('id')
    .eq('org_id', demo.orgId)
    .eq('value', e164)
    .maybeSingle();
  if (!contact) return [];
  const { data } = await service
    .schema('app')
    .from('consents')
    .select('source, status, purpose, attestation_text_version')
    .eq('contact_id', contact.id);
  return data ?? [];
}

test('AC1/AC2: the box is unticked by default, and unticked means no consent call', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const phone = randomPhone();
  const consentCalls: string[] = [];
  staff.on('request', (r) => {
    if (r.url().includes('staff_capture_consent')) consentCalls.push(r.url());
  });
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  const box = dialog.getByLabel('The guest agreed to receive texts about this visit');
  await expect(box).toHaveCount(0); // no number yet
  await dialog.getByLabel('Name (optional)').fill('Quiet Quinn');
  await dialog.getByLabel('Mobile number (optional)').fill(phone.typed);
  await expect(box).not.toBeChecked();
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.getByTestId('section-waiting')).toContainText('Quiet Quinn');
  expect(consentCalls).toHaveLength(0);
  expect(await consentsFor(phone.e164)).toHaveLength(0);
});

test('a ticked box records a staff-attested transactional consent', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const phone = randomPhone();
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Agreed Ada');
  await dialog.getByLabel('Mobile number (optional)').fill(phone.typed);
  await dialog.getByLabel('The guest agreed to receive texts about this visit').check();
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await consentsFor(phone.e164)).map(
        (c) => `${c.source}/${c.purpose}/${c.status}/${c.attestation_text_version}`,
      ),
    )
    .toEqual(['staff/transactional/granted/1']);
});

test('AC3: an opted-out number says so and the visit is still added', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const phone = randomPhone();
  // The guest texted STOP to this business earlier: the inbound keyword path records the opt-out.
  const { error } = await service.schema('api').rpc('process_inbound_message', {
    p_org_id: demo.orgId,
    p_channel: 'sms',
    p_from: phone.e164,
    p_to: '+15005550006',
    p_body: 'STOP',
    p_provider: 'e2e',
    p_provider_message_id: crypto.randomUUID(),
  });
  expect(error).toBeNull();
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Stopped Sid');
  await dialog.getByLabel('Mobile number (optional)').fill(phone.typed);
  await dialog.getByLabel('The guest agreed to receive texts about this visit').check();
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(
    staff.getByRole('region', { name: 'Notifications' }).getByText(/opted out of texts/),
  ).toBeVisible();
  await expect(staff.getByTestId('section-waiting')).toContainText('Stopped Sid');
  expect(await consentsFor(phone.e164)).toHaveLength(0);
});
