import { expect, test } from './fixtures.ts';
import { guestJoins, openQueue, pickRowAction } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// The console leads with the day's work: Call next, then the line, then the queue controls.

test('Call next comes before the line, and the queue controls come after it', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Layout Lee', queue.id);
  await openQueue(staff, queue.id);

  const callNext = staff.getByRole('button', { name: 'Call next' });
  await expect(callNext).toBeVisible();
  const top = async (target: ReturnType<typeof staff.getByTestId>) =>
    (await target.boundingBox())!.y;
  const next = await top(callNext);
  const line = await top(staff.getByTestId('section-waiting'));
  const controls = await top(staff.getByTestId('queue-controls'));

  expect(next).toBeLessThan(line);
  expect(line).toBeLessThan(controls);
  await expect(staff.getByRole('heading', { name: 'Queue controls' })).toBeVisible();
});

test('a waiting guest has one filled action, Call, and no other filled button', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Primary Pat', queue.id);
  await openQueue(staff, queue.id);

  const row = staff.getByTestId('section-waiting').getByTestId('visit').first();
  const call = row.getByRole('button', { name: /^Call / });
  const callFill = await call.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(callFill).not.toBe('rgba(0, 0, 0, 0)');
  const otherFilled = await row
    .getByRole('button')
    .evaluateAll(
      (buttons, fill) =>
        buttons
          .filter(
            (b) =>
              getComputedStyle(b).backgroundColor === fill &&
              !(b.getAttribute('aria-label') ?? '').startsWith('Call '),
          )
          .map((b) => b.getAttribute('aria-label')),
      callFill,
    );
  expect(otherFilled).toEqual([]);
});

test('Scan guest QR sits with the counter picker, above the queue', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await openQueue(staff, queue.id);

  const scan = await staff.getByRole('button', { name: 'Scan guest QR' }).boundingBox();
  const tabs = await staff.getByRole('tab').first().boundingBox();
  expect(scan!.y).toBeLessThan(tabs!.y);
});

// DS-24: Remove and No-show are never next to Call; they wait in the overflow menu, and each
// control on the row is a comfortable target.
test('a row shows Call and a menu; Remove is not adjacent to Call and sits behind a confirm', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Menu Mo', queue.id);
  await openQueue(staff, queue.id);

  const row = staff.getByTestId('section-waiting').getByTestId('visit').first();
  const ticket = ((await row.locator('span').first().textContent()) ?? '').trim();
  const call = row.getByRole('button', { name: `Call ${ticket}` });
  const more = row.getByRole('button', { name: `More actions for ${ticket}` });
  await expect(row.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /^No-show / })).toHaveCount(0);

  const width = staff.viewportSize()!.width;
  const floor = width >= 768 ? 56 : 48;
  for (const control of [call, more]) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(floor);
  }

  await more.click();
  const remove = staff.getByRole('menuitem', { name: 'Remove', exact: true });
  await expect(remove).toBeVisible();
  expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(floor);
  await staff.keyboard.press('Escape');

  // Removing still asks first, and names the guest.
  await pickRowAction(row, 'Remove', ticket);
  const dialog = staff.getByRole('dialog', { name: `Remove ${ticket} from the line?` });
  await expect(dialog.getByTestId('confirm-guest')).toContainText('Menu Mo');
  await dialog.getByRole('button', { name: 'Keep' }).click();
  await expect(row).toBeVisible();
});
