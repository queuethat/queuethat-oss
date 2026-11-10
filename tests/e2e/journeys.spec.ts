import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, restAs, signInTo } from './support/accounts.ts';
import { openQueue } from './support/console.ts';
import { supabaseEnv } from './support/env.ts';

// 2B-Q9 (#234): staff send a guest to the next queue of a journey; the guest keeps one link.

test.use({ staffUser: null });

async function insert(email: string, table: string, row: object) {
  const r = await restAs(email, table, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  expect(r.ok, await r.clone().text()).toBe(true);
  return ((await r.json()) as { id: string }[])[0]!.id;
}

test('AC1: Send to Triage moves the guest, whose page shows the new queue, and Triage lists them', async ({
  devices,
  browser,
}) => {
  const { staff: reception, guest } = devices;
  const { email } = await ownerOfNewBusiness();
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const base = { org_id: loc!.org_id, location_id: loc!.id };
  const reg = await insert(email, 'queues', { ...base, name: 'Registration', ticket_prefix: 'R' });
  const tri = await insert(email, 'queues', { ...base, name: 'Triage', ticket_prefix: 'T' });
  const service = await insert(email, 'services', { ...base, queue_id: reg, name: 'Check-in' });
  const journey = await insert(email, 'journeys', { ...base, name: 'Clinic' });
  for (const [i, queue_id] of [reg, tri].entries()) {
    await insert(email, 'journey_steps', {
      journey_id: journey,
      org_id: loc!.org_id,
      step_no: i + 1,
      queue_id,
    });
  }
  const set = await restAs(email, `services?id=eq.${service}`, {
    method: 'PATCH',
    body: JSON.stringify({ journey_id: journey }),
  });
  expect(set.ok).toBe(true);

  const { url, anonKey } = supabaseEnv();
  const joined = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: reg,
      p_service_id: service,
      p_name: 'Journey Jo',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  expect(joined.ok, await joined.clone().text()).toBe(true);
  const { token } = (await joined.json()) as { token: string };

  await signInTo(reception, email, `/staff`);
  await openQueue(reception, reg);
  await guest.goto(`/v/${token}`);
  await expect(guest.getByText(/· Registration$/)).toBeVisible();

  const context = await browser.newContext({ viewport: reception.viewportSize() });
  const triage = await context.newPage();
  await signInTo(triage, email, `/staff`);
  await openQueue(triage, tri);

  await reception.getByRole('button', { name: 'Call next' }).click();
  await reception.getByRole('button', { name: /^Start / }).click();
  await reception.getByRole('button', { name: /^Send .* to Triage$/ }).click();

  await expect(guest.getByText(/· Triage$/)).toBeVisible({ timeout: 3_000 });
  await expect(guest.getByRole('status').filter({ hasText: 'You are now in Triage.' })).toHaveCount(
    1,
  );
  await expect(triage.getByTestId('section-waiting')).toContainText('Journey Jo', {
    timeout: 3_000,
  });
  await context.close();
});

test('admin builds a journey from two queues and assigns a service', async ({ devices }) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  const [[loc]] = (await readAs(email, ['locations?select=id,org_id'])) as [
    { id: string; org_id: string }[],
  ];
  const base = { org_id: loc!.org_id, location_id: loc!.id };
  const a = await insert(email, 'queues', { ...base, name: 'Front desk', ticket_prefix: 'F' });
  await insert(email, 'queues', { ...base, name: 'Back office', ticket_prefix: 'B' });
  await insert(email, 'services', { ...base, queue_id: a, name: 'Forms' });

  await signInTo(staff, email, '/admin/journeys');
  await staff.getByRole('button', { name: 'Add a journey' }).click();
  await staff.getByLabel('Journey name').fill('Paperwork');
  await staff.getByLabel('Step 1').selectOption({ label: 'Front desk' });
  await staff.getByLabel('Step 2').selectOption({ label: 'Back office' });
  await staff.getByLabel('Forms · Front desk').check();
  await staff.getByRole('button', { name: 'Save journey' }).click();

  const card = staff.getByTestId('journey');
  await expect(card).toContainText('Paperwork');
  await expect(card).toContainText('Front desk → Back office');
  await expect(card).toContainText('Used by: Forms');
});
