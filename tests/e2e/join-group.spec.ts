import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { freshQueue } from './support/queues.ts';

// 2A-J15B (#118): a parent joins several people in one flow and switches between their tickets.

test('a parent adds two children, double-taps Join, and gets two tabs and two visits', async ({
  devices,
}) => {
  const { guest, staff } = devices;
  const queue = await freshQueue();
  const pending: Promise<string>[] = [];
  guest.on('response', (response) => {
    if (response.url().endsWith('/rpc/join_queue') && response.ok()) {
      pending.push(
        response.json().then((body) => (body as { display_ticket: string }).display_ticket),
      );
    }
  });

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Parent');
  await guest.getByRole('button', { name: 'Add another person' }).click();
  await guest.getByLabel('Name of person 2').fill('Child One');
  await guest.getByRole('button', { name: 'Add another person' }).click();
  await guest.getByLabel('Name of person 3').fill('Child Two');
  await expectNoSeriousA11yViolations(guest);

  await guest.getByRole('button', { name: 'Join the queue' }).dblclick();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);

  // AC1: one status page with a tab per person, each with its own ticket.
  const tabs = guest.getByRole('tablist', { name: 'People in your group' });
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await expect(tabs.getByRole('tab', { name: /Parent/ })).toHaveAttribute('aria-selected', 'true');
  await expectNoSeriousA11yViolations(guest);
  const parentTicket = await guest.getByTestId('ticket').textContent();
  await tabs.getByRole('tab', { name: /Child One/ }).click();
  await expect(tabs.getByRole('tab', { name: /Child One/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(guest.getByTestId('ticket')).not.toHaveText(parentTicket ?? '');

  // AC2: exactly three visits (the parent plus two children), however fast the taps.
  // The page moves on as soon as an answer arrives, which can be before its body is read.
  const joins = await Promise.all(pending);
  expect(new Set(joins).size).toBe(3);
  expect(joins).toHaveLength(3);

  // The console links them with a group badge; each knows the other two.
  await staff.goto(`/staff?queue=${queue.id}`);
  await expect(staff.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(3, {
    timeout: LIVE_TIMEOUT_MS,
  });
  const badges = staff.getByTestId('group-badge');
  await expect(badges).toHaveCount(3);
  await expect(badges.first()).toContainText('Group with');

  // A returning visit to the poster goes back to the status page, not the form.
  await guest.goto(`/q/${demo.locationSlug}`);
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
});

test('a blank extra name is refused, and a person can be removed', async ({ devices }) => {
  const { guest } = devices;
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('First name').fill('Parent');
  await guest.getByRole('button', { name: 'Add another person' }).click();
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByText('Enter a name for person 2, or remove them.')).toBeVisible();
  await guest.getByRole('button', { name: 'Remove person 2' }).click();
  await expect(guest.getByLabel('Name of person 2')).toHaveCount(0);
});

test('a single join is unchanged: no tabs on the status page', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Solo');
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  await expect(guest.getByTestId('ticket')).toBeVisible();
  await expect(guest.getByRole('tablist')).toHaveCount(0);
});
