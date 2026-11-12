import { expect, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-S5 (#275): an offline action that conflicts waits for a person; nothing is applied silently.

test('AC1: tablet A starts offline while tablet B marks the guest no-show; A sees the conflict and nothing is applied', async ({
  devices,
  browser,
}) => {
  const { staff: a } = devices;
  const queue = await freshQueue();
  await guestJoins('Clash Cleo', queue.id);
  await openQueue(a, queue.id);
  await a.getByRole('button', { name: 'Call next' }).click();
  const called = a.getByTestId('section-called').getByTestId('visit');
  await expect(called).toHaveCount(1);
  const ticket = ((await called.locator('span').first().textContent()) ?? '').trim();

  const context = await browser.newContext({ viewport: a.viewportSize() });
  const b = await context.newPage();
  await signIn(b, 'staff');
  await openQueue(b, queue.id);

  // Tablet A loses Wi-Fi and starts the guest.
  await a.context().setOffline(true);
  await a.getByRole('button', { name: `Start ${ticket}` }).click();
  await expect(a.getByText('Pending', { exact: true })).toBeVisible();
  await expect(a.getByText('Offline: 1 action waiting.')).toBeVisible();

  // Meanwhile tablet B marks the same guest no-show.
  await pickRowAction(b, 'No-show', ticket);
  await b.getByRole('button', { name: 'Mark no-show' }).click();
  await expect(b.getByTestId('section-no_show')).toContainText('Clash Cleo');

  // A reconnects: the action is refused, shown with B's state, and left for A to decide.
  await a.context().setOffline(false);
  const review = a.getByTestId('offline-review');
  await expect(review).toContainText('1 saved action was not applied', { timeout: 15_000 });
  await expect(review).toContainText('now marked no-show');
  await expect(a.getByTestId('section-serving').getByTestId('visit')).toHaveCount(0);

  await review.getByRole('button', { name: `Discard saved action for ${ticket}` }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  await expect(review).toHaveCount(0);
  await context.close();
});
