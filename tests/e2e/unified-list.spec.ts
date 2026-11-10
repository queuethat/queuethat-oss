import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import {
  expect,
  expectNoSeriousA11yViolations,
  LIVE_TIMEOUT_MS,
  signIn,
  test,
} from './fixtures.ts';
import { freshQueue } from './support/queues.ts';

// 2P-APT14 (#170): expected appointments sit beside walk-ins; one tap checks them in at the
// policy position, live on every tablet.

const databaseUrl =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

/** An expected visit for an appointment due `minutes` from now (negative = already due). */
async function expectedGuest(queueId: string, name: string, minutes: number) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select private.set_actor('system', null)`;
      const [q] = await tx<{ ticket_prefix: string }[]>`
        select ticket_prefix from app.queues where id = ${queueId}`;
      const id = randomUUID();
      const [n] = await tx<{ next: number }[]>`
        select private.next_ticket(${queueId}, ${q!.ticket_prefix}, private.service_day(${demo.locationId})) as next`;
      await tx`insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                                       display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                                       idempotency_key, scheduled_at)
               values (${id}, ${demo.orgId}, ${demo.locationId}, ${queueId},
                       private.service_day(${demo.locationId}), ${q!.ticket_prefix}, ${n!.next},
                       ${q!.ticket_prefix + String(n!.next).padStart(3, '0')}, 'expected', ${n!.next * 1024},
                       ${name}, private.token_hash(${id}), 'appointment', ${randomUUID()},
                       now() + ${minutes} * interval '1 minute')`;
    });
  } finally {
    await sql.end();
  }
}

async function openQueue(page: Page, queueId: string) {
  await page.goto(`/staff?queue=${queueId}`);
  await expect(page.getByTestId('section-expected')).toBeVisible();
  await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
}

async function twoTablets(
  { devices, browser }: { devices: { staff: Page }; browser: Browser },
  queueId: string,
) {
  const first = devices.staff;
  const context = await browser.newContext({ viewport: first.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  for (const page of [first, second]) await openQueue(page, queueId);
  return { first, second, context };
}

test('AC1: checking in an expected guest moves them to Waiting on both tablets within 3 s', async ({
  devices,
  browser,
}) => {
  const queue = await freshQueue();
  await expectedGuest(queue.id, 'Arrival Ada', 2);
  const { first, second, context } = await twoTablets({ devices, browser }, queue.id);
  const expectedRow = (page: Page) => page.getByTestId('section-expected').getByTestId('visit');
  await expect(expectedRow(first)).toHaveText(/Arrival Ada/);
  await expectNoSeriousA11yViolations(first);
  await first.getByRole('button', { name: /^Check in / }).click();
  for (const page of [first, second]) {
    await expect(page.getByTestId('section-waiting')).toContainText('Arrival Ada', {
      timeout: 3_000,
    });
    await expect(page.getByTestId('section-expected')).not.toContainText('Arrival Ada');
    await expect(page.getByTestId('appointment-badge')).toHaveText('Appointment');
  }
  await context.close();
});

test('AC2: a late appointment is labelled Late in text', async ({ devices }) => {
  const queue = await freshQueue();
  await expectedGuest(queue.id, 'Tardy Tom', -30);
  await openQueue(devices.staff, queue.id);
  await expect(devices.staff.getByTestId('arrival-badge')).toHaveText('Late');
});
