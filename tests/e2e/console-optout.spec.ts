import { createClient } from '@supabase/supabase-js';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openQueue } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// 3-CG10 (#335): staff see whether a guest can receive texts, and a STOP shows up within seconds.

const env = supabaseEnv();
const service = createClient(env.url, env.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

test('AC1: a STOP flips the badge from Texts on to Opted out within 5 s', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const pick = 200 + Math.floor(Math.random() * 800);
  const exchange = pick % 100 === 11 ? pick + 1 : pick; // N11 exchanges aren't numbers
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');

  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Stop Stella');
  await dialog.getByLabel('Mobile number (optional)').fill(`+1 415 ${exchange} ${line}`);
  await dialog.getByLabel('The guest agreed to receive texts about this visit').check();
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog).toHaveCount(0);

  const row = staff.getByTestId('visit').filter({ hasText: 'Stop Stella' });
  await expect(row.getByTestId('text-badge')).toHaveText('Texts on', { timeout: 10_000 });
  await expectNoSeriousA11yViolations(staff);

  // The guest texts STOP: the inbound webhook path records the opt-out.
  const { error } = await service.schema('api').rpc('process_inbound_message', {
    p_org_id: demo.orgId,
    p_channel: 'sms',
    p_from: `+1415${exchange}${line}`,
    p_to: '+15005550006',
    p_body: 'STOP',
    p_provider: 'e2e',
    p_provider_message_id: crypto.randomUUID(),
  });
  expect(error).toBeNull();
  await expect(row.getByTestId('text-badge')).toHaveText('Opted out', { timeout: 5_000 });
});

test('a guest with a number but no consent shows No consent; no number shows nothing', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const pick = 200 + Math.floor(Math.random() * 800);
  const exchange = pick % 100 === 11 ? pick + 1 : pick;
  const line = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  await openQueue(staff, queue.id);
  for (const [name, phone] of [
    ['Silent Sam', `+1 415 ${exchange} ${line}`],
    ['Numberless Nia', ''],
  ] as const) {
    await staff.getByRole('button', { name: 'Add guest' }).click();
    const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
    await dialog.getByLabel('Name (optional)').fill(name);
    if (phone) await dialog.getByLabel('Mobile number (optional)').fill(phone);
    await dialog.getByRole('button', { name: 'Add to the line' }).click();
    await expect(dialog).toHaveCount(0);
  }
  const silent = staff.getByTestId('visit').filter({ hasText: 'Silent Sam' });
  await expect(silent.getByTestId('text-badge')).toHaveText('No consent', { timeout: 10_000 });
  const none = staff.getByTestId('visit').filter({ hasText: 'Numberless Nia' });
  await expect(none.getByTestId('text-badge')).toHaveCount(0);
});
