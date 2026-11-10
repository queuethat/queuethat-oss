import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { freshQueue } from './support/queues.ts';

// G5 (#55): a waiting guest leaves with one confirmed action, and staff see it at once.

test('AC1: a guest who confirms leaving is gone from the staff console within 3 s @core', async ({
  devices,
}) => {
  const { guest, staff } = devices;
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Leah');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const ticket = (await guest.getByTestId('ticket').textContent())!.trim();

  await staff.goto(`/staff?queue=${queue.id}`);
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  await expect(staff.getByRole('tabpanel').getByText(ticket)).toBeVisible();

  // Nothing happens until the separate confirm (I-9).
  await guest.getByRole('button', { name: 'Leave the line' }).click();
  await expect(guest.getByRole('dialog', { name: 'Leave the line?' })).toBeVisible();
  await expectNoSeriousA11yViolations(guest);
  await guest.getByRole('button', { name: 'Stay in line' }).click();
  await expect(guest.getByRole('dialog')).toHaveCount(0);
  await expect(staff.getByRole('tabpanel').getByText(ticket)).toBeVisible();

  await guest.getByRole('button', { name: 'Leave the line' }).click();
  await guest.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(guest.getByText('You left the line.')).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Leave the line' })).toHaveCount(0);
  // Gone from the live lists; it stays reachable under "Done today" as left (#139).
  await expect(staff.getByRole('heading', { name: 'Waiting (0)' })).toBeVisible({ timeout: 3_000 });
  await expect(
    staff.getByRole('listitem').filter({ hasText: ticket }).getByText('Left ·'),
  ).toBeVisible();

  // The way back is the poster page this phone joined from.
  await guest.getByRole('link', { name: 'Join again' }).click();
  await expect(guest).toHaveURL(new RegExp(`/q/${demo.locationSlug}$`));
  await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeVisible();
});

// #528: a guest who left by mistake gets their place back with one tap.
test('a guest who left by mistake gets their place back @core', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Uma');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  const ticket = (await guest.getByTestId('ticket').textContent())!.trim();

  await guest.getByRole('button', { name: 'Leave the line' }).click();
  await guest.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(guest.getByText('You left the line.')).toBeVisible();

  await guest.getByRole('button', { name: 'Get my place back' }).click();
  await expect(guest.getByTestId('position')).toBeVisible();
  await expect(guest.getByTestId('ticket')).toHaveText(ticket);
  await expect(guest.getByText('You left the line.')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Get my place back' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Leave the line' })).toBeVisible();
});
