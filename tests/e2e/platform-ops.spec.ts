import postgres from 'postgres';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signedInOperator } from './support/totp.ts';

// PLT13 (#419): the operator console's health and usage pages.
test.use({ staffUser: null });

const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

test('AC1: a dead notification shows on the health page as a warning (AC3: axe)', async ({
  devices,
}) => {
  const { staff } = devices;
  // As the superuser: a dead letter is the dispatcher's final state, which no API writes.
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1 });
  const dedupe = `e2e-dead-${crypto.randomUUID()}`;
  try {
    await sql`
      insert into app.notifications
        (org_id, channel, recipient_ref, template_key, template_version, dedupe_key, status)
      values (${demo.orgId}, 'email', gen_random_uuid(), 'called', 1, ${dedupe}, 'dead')`;
    await signedInOperator(staff);
    await staff.goto('/platform/health');
    await expect(staff.getByRole('heading', { name: 'Platform health' })).toBeVisible();
    const dead = staff.locator('[data-health]').filter({ hasText: 'Dead notifications' });
    await expect(dead).toHaveAttribute('data-health', 'warning');
    await expect(dead.getByText('Needs attention')).toBeVisible();
    await expect(staff.getByRole('cell', { name: 'platform-stats-tick' })).toBeVisible();
    await expectNoSeriousA11yViolations(staff);
  } finally {
    await sql`delete from app.notifications where dedupe_key = ${dedupe}`;
    await sql.end();
  }
});

test('the usage page shows 30 days and names each business, linked to its page (AC3: axe)', async ({
  devices,
}) => {
  const { staff } = devices;
  // The nightly rollup hasn't run on a fresh stack: give the demo business a row for today.
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    await sql`
      insert into app.platform_daily_stats (day, org_id, joins)
      values (current_date, ${demo.orgId}, 3)
      on conflict (day, org_id) do update set joins = excluded.joins`;
    await signedInOperator(staff);
    await staff.getByRole('link', { name: 'Usage' }).click();
    await expect(staff.getByRole('heading', { name: 'Usage, last 30 days' })).toBeVisible();
    await expect(staff.getByRole('img', { name: 'Joins per day, last 30 days' })).toBeVisible();
    await expect(staff.getByRole('heading', { name: 'Per business' })).toBeVisible();
    // #582: a name, not the uuid.
    const demoRow = staff.getByRole('region', { name: 'Per business' }).getByRole('link', {
      name: 'Demo Barber',
    });
    await expect(demoRow).toHaveAttribute('href', `/platform/orgs/${demo.orgId}`);
    await expectNoSeriousA11yViolations(staff);
  } finally {
    await sql`delete from app.platform_daily_stats where org_id = ${demo.orgId} and day = current_date`;
    await sql.end();
  }
});

test('an operator schedules an announcement, sees it before it starts, and cancels it (AC3: axe)', async ({
  devices,
}) => {
  const { staff } = devices;
  const message = `Maintenance ${crypto.randomUUID().slice(0, 8)}`;
  await signedInOperator(staff);
  await staff.getByRole('link', { name: 'Announcements' }).click();
  await expect(staff.getByRole('heading', { name: 'Announcements', level: 1 })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  // Tomorrow 09:00 to 10:00 in the browser's zone, as the datetime-local fields take it.
  const day = new Date(Date.now() + 86_400_000);
  const local = (hour: number) =>
    `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00`;
  await staff.getByLabel('Type').selectOption('maintenance');
  await staff.getByLabel('Message').fill(message);
  await staff.getByLabel('Starts').fill(local(9));
  await staff.getByLabel('Ends').fill(local(10));
  await staff.getByRole('button', { name: 'Publish announcement' }).click();

  const item = staff.getByRole('listitem').filter({ hasText: message });
  await expect(item.getByText(/^Scheduled: /)).toBeVisible();
  await item.getByRole('button', { name: `End announcement now: ${message}` }).click();
  await staff.getByRole('dialog').getByRole('button', { name: 'End announcement' }).click();
  await expect(staff.getByText(message)).toHaveCount(0);
});

test('org detail shows entitlement overrides (AC3: axe)', async ({ devices }) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.goto(`/platform/orgs/${demo.orgId}`);
  await expect(staff.getByRole('heading', { name: 'Entitlement overrides' })).toBeVisible();
  // The plan limits (M-2) define entitlements, so the section lists them with their defaults.
  await expect(staff.getByText('limit.locations').first()).toBeVisible();
  await expect(staff.getByText('No entitlements are defined yet.')).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test('AC2: a blocked contact is listed without the contact, and stops a join (AC3: axe)', async ({
  devices,
}) => {
  const { staff, guest } = devices;
  const email = `blocked-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await signedInOperator(staff);
  await staff.getByRole('link', { name: 'Blocks' }).click();
  await expect(staff.getByRole('heading', { name: 'Blocked contacts' })).toBeVisible();
  await staff.getByLabel('Type').first().selectOption('email');
  await staff.getByLabel('Phone or email', { exact: true }).fill(email);
  await staff.getByLabel('Reason').fill('E2E abuse report');
  await staff.getByRole('button', { name: 'Block contact' }).click();

  const row = staff.getByTestId('block').filter({ hasText: 'E2E abuse report' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Email');
  await expect(row).toContainText('Until removed');
  await expect(staff.locator('body')).not.toContainText(email);
  await expectNoSeriousA11yViolations(staff);

  // The block holds at join: the database answers a blocked email like the per-client cap.
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('First name').fill('Blocked');
  await guest.getByLabel('Email (optional)').fill(email);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).not.toHaveURL(/\/v\//);

  // Removing it by the same contact lets it join again.
  await staff.getByLabel('Type').last().selectOption('email');
  await staff.getByLabel('Phone or email to unblock').fill(email);
  await staff.getByRole('button', { name: 'Remove block' }).click();
  await staff.getByRole('dialog').getByRole('button', { name: 'Remove block' }).click();
  await expect(staff.getByTestId('block').filter({ hasText: 'E2E abuse report' })).toHaveCount(0);
});

test('an unknown platform page is the 404, and a registered one is not (#1159)', async ({
  devices,
}) => {
  const { staff } = devices;
  await signedInOperator(staff);
  await staff.goto('/platform/not-a-page');
  await expect(staff.getByTestId('not-found')).toBeVisible();
  await staff.goto('/platform/health/');
  await expect(staff.getByRole('heading', { name: 'Platform health' })).toBeVisible();
});
