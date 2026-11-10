import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { backdateServing, guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST14 (#144): remind staff when a guest has been serving too long.

async function startServing(staff: import('@playwright/test').Page, queueId: string) {
  await guestJoins('Long Lena', queueId);
  await openQueue(staff, queueId);
  await staff.getByRole('button', { name: 'Call next' }).click();
  await staff.getByRole('button', { name: /^Start / }).click();
  await expect(staff.getByTestId('section-serving')).toContainText('Long Lena');
  await backdateServing(queueId, 21);
  await staff.reload();
}

test('AC1: a 10-minute service started 21 minutes ago shows the reminder; Complete serves it with undo', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await startServing(staff, queue.id);

  const reminder = staff.getByTestId('serving-reminder');
  await expect(reminder).toContainText(/Serving 2\d min\. Still with them\?/, { timeout: 10_000 });
  await expectNoSeriousA11yViolations(staff);
  await reminder.getByRole('button', { name: /^Complete / }).click();
  await expect(staff.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(staff.getByTestId('serving-reminder')).toHaveCount(0);
  await expect(staff.getByTestId('section-serving')).not.toContainText('Long Lena');
});

test('AC2: "Still serving" hides the reminder for 15 minutes on this tablet only', async ({
  devices,
  browser,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await startServing(staff, queue.id);
  await expect(staff.getByTestId('serving-reminder')).toBeVisible({ timeout: 10_000 });

  const other = await (await browser.newContext({ viewport: staff.viewportSize() })).newPage();
  const { signIn } = await import('./fixtures.ts');
  await signIn(other, 'staff');
  await openQueue(other, queue.id);
  await expect(other.getByTestId('serving-reminder')).toBeVisible({ timeout: 10_000 });

  await staff.getByRole('button', { name: /^Still serving / }).click();
  await expect(staff.getByTestId('serving-reminder')).toHaveCount(0);
  // It stays hidden across a reload, and the other tablet still shows it.
  await staff.reload();
  await expect(staff.getByTestId('section-serving')).toContainText('Long Lena');
  await expect(staff.getByTestId('serving-reminder')).toHaveCount(0);
  await expect(other.getByTestId('serving-reminder')).toBeVisible();

  // After 15 minutes on the clock it returns.
  await staff.clock.install();
  // The tablet measures its offset from the server once per load; let that settle first.
  const offset = staff.waitForResponse((r) => r.request().method() === 'HEAD');
  await staff.reload();
  await offset;
  await expect(staff.getByTestId('section-serving')).toContainText('Long Lena');
  await staff.clock.fastForward(16 * 60_000);
  await expect(staff.getByTestId('serving-reminder')).toBeVisible({ timeout: 10_000 });
  await other.context().close();
});
