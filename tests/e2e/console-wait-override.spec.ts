import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST15 (#148): set and clear a temporary "current wait".

test('AC1: a 30-minute wait shows on the guest status page and as a banner on every tablet', async ({
  devices,
  browser,
}) => {
  const { staff, guest } = devices;
  const queue = await freshQueue();
  await guestJoins('Ahead Abe', queue.id);
  const { token } = await guestJoins('Waiting Wen', queue.id);
  const context = await browser.newContext({ viewport: staff.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  await openQueue(staff, queue.id);
  await openQueue(second, queue.id);
  await guest.goto(`/v/${token}`);

  await staff.getByRole('button', { name: 'Set wait' }).click();
  const dialog = staff.getByRole('dialog', { name: /^Current wait for / });
  await dialog.getByRole('button', { name: '30 min' }).click();
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Set wait', exact: true }).click();

  for (const page of [staff, second]) {
    await expect(page.getByTestId('wait-override-banner')).toContainText(
      'Wait set to about 30 min until',
      {
        timeout: 5_000,
      },
    );
  }
  // The guest, one place back, is told a range around the override.
  const range = guest.getByText(/About \d+–\d+ min/);
  // The range first shows the formula's estimate and follows the override once it arrives, so
  // read it until it does rather than once: a single read raced the update on iPhone.
  await expect
    .poll(
      async () => {
        const [low, high] = ((await range.textContent({ timeout: 1_000 })) ?? '')
          .match(/\d+/g)!
          .map(Number);
        return low! <= 30 && high! >= 30;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // Clearing it on one tablet clears the banner on both.
  await second.getByTestId('wait-override-banner').getByRole('button', { name: 'Clear' }).click();
  for (const page of [staff, second]) {
    await expect(page.getByTestId('wait-override-banner')).toHaveCount(0, { timeout: 5_000 });
  }
  await context.close();
});
