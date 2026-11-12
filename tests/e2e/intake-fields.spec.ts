import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { addIntakeFields, freshQueue } from './support/queues.ts';

// Q-8 (#131): a queue's questions on the join page, and the answers on the console.

const { url, anonKey } = supabaseEnv();
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

test('AC1 and AC2: the database refuses a required field left empty and the form names it; staff-only fields never show', async ({
  devices,
}) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await addIntakeFields(queue.id, [
    { key: 'reason', label: 'Reason for visit', required: true },
    { key: 'size', label: 'Size', type: 'select', options: ['Small', 'Large'] },
    { key: 'allergy', label: 'Allergy check', visibility: 'staff_only' },
  ]);
  const joins: unknown[] = [];
  guest.on('request', (request) => {
    if (request.url().endsWith('/rpc/join_queue')) joins.push(request.postDataJSON());
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Ida');
  await expect(guest.getByLabel(/Reason for visit/)).toBeVisible();
  // AC2: the staff-only question is not on the page.
  await expect(guest.getByText('Allergy check')).toHaveCount(0);
  await expectNoSeriousA11yViolations(guest);

  // AC1: the page does not judge the answers (rule 2): the join goes out and the database refuses
  // it, naming the field, which takes focus with an error. Nothing was joined.
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByLabel(/Reason for visit/)).toBeFocused();
  await expect(guest.getByText('Please check this answer.')).toBeVisible();
  await expect(guest).toHaveURL(/\/q\//);

  await guest.getByLabel(/Reason for visit/).fill('Haircut');
  await guest.getByLabel(/Size/).selectOption('Large');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  expect((joins.at(-1) as { p_answers: unknown }).p_answers).toEqual({
    reason: 'Haircut',
    size: 'Large',
  });
});

test('AC3: staff fill a staff-only field and another tablet sees it within 3 s', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await addIntakeFields(queue.id, [
    { key: 'reason', label: 'Reason for visit' },
    { key: 'allergy', label: 'Allergy check', visibility: 'staff_only' },
  ]);
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: queue.id,
      p_service_id: null,
      p_name: 'Nell',
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      p_device_key: randomUUID().replaceAll('-', ''),
      p_answers: { reason: 'Colour' },
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const { display_ticket: ticket } = (await response.json()) as { display_ticket: string };

  // A second tablet: another page of the same signed-in staff browser.
  const other = await staff.context().newPage();
  for (const page of [staff, other]) {
    await page.goto(`/staff?queue=${queue.id}`);
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
    await page.getByRole('button', { name: `Details for ${ticket}` }).click();
    await expect(page.getByTestId('visit-answers')).toContainText('Colour');
  }

  await staff.getByLabel('Allergy check').fill('Latex');
  await staff.getByRole('button', { name: 'Save answers' }).click();
  await expect(other.getByLabel('Allergy check')).toHaveValue('Latex', { timeout: 3_000 });
  await expectNoSeriousA11yViolations(staff);

  // F7 (#1283): the console read the answers through api.get_visit_answers, which logged the
  // access (who and which visit, never the values), once per member and visit for 10 minutes.
  const { default: postgres } = await import('postgres');
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ role: string; after: unknown }[]>`
      select l.role, l.after from app.audit_log l
      join app.visits v on v.id::text = l.row_id
      where l.action = 'READ' and v.queue_id = ${queue.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('staff');
    expect(JSON.stringify(rows[0]!.after)).not.toMatch(/Colour|Latex/);
  } finally {
    await sql.end();
  }
});
