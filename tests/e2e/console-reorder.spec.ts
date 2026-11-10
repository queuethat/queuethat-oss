import type { Browser, Page } from '@playwright/test';
import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST2 (#135): reorder the waiting list by drag, keyboard or buttons, live on every tablet.

const waitingRows = (page: Page) => page.getByTestId('section-waiting').getByTestId('visit');
const order = (...names: string[]) => names.map((n) => new RegExp(n));

/** Three guests in a queue of their own, shown on the project's staff tablet and a second one. */
async function threeGuestsOnTwoTablets({
  devices,
  browser,
}: {
  devices: { staff: Page };
  browser: Browser;
}) {
  const queue = await freshQueue();
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await guestJoins(name, queue.id);
  const first = devices.staff;
  const context = await browser.newContext({ viewport: first.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  for (const page of [first, second]) {
    await openQueue(page, queue.id);
    await expect(waitingRows(page)).toHaveText(order('Alpha', 'Bravo', 'Charlie'));
  }
  return { first, second, context };
}

test('AC1: a drag on one tablet shows the new order on another within 3 s', async ({
  devices,
  browser,
}) => {
  const { first, second, context } = await threeGuestsOnTwoTablets({ devices, browser });
  const grip = first.getByRole('button', { name: /^Drag .* to reorder$/ }).first();
  // Mouse coordinates are viewport coordinates, so both rows must be on screen.
  await first.getByTestId('section-waiting').scrollIntoViewIfNeeded();
  const target = (await waitingRows(first).nth(2).boundingBox())!;
  const from = (await grip.boundingBox())!;
  await first.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await first.mouse.down();
  await first.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 20, { steps: 4 });
  await first.mouse.move(from.x + from.width / 2, target.y + target.height / 2 + 10, { steps: 12 });
  await first.mouse.up();

  await expect(waitingRows(first)).toHaveText(order('Bravo', 'Charlie', 'Alpha'));
  await expect(waitingRows(second)).toHaveText(order('Bravo', 'Charlie', 'Alpha'), {
    timeout: 3_000,
  });
  await context.close();
});

test('AC2: keyboard alone reorders (space, arrows, space) and announces it', async ({
  devices,
  browser,
}) => {
  const { first, second, context } = await threeGuestsOnTwoTablets({ devices, browser });
  await waitingRows(first)
    .nth(2)
    .getByRole('button', { name: /^Drag .* to reorder$/ })
    .focus();
  await first.keyboard.press('Space');
  // One arrow at a time, each after the announcement that follows the last key. The keyboard
  // sensor measures the rows after every step and drops an arrow pressed before it has (dnd-kit's
  // sortableKeyboardCoordinates returns nothing without a measured rect). After Space that takes
  // some tens of milliseconds, which a person does not beat and a script does. The row is
  // announced as over its own position once the measuring is done.
  const announcer = first.locator('[role="status"][aria-live="assertive"]');
  await expect(announcer).toContainText('is over position 3.');
  await first.keyboard.press('ArrowUp');
  await expect(announcer).toContainText('is over position 2.');
  await first.keyboard.press('ArrowUp');
  await expect(announcer).toContainText('is over position 1.');
  await first.keyboard.press('Space');
  await expect(announcer).toContainText(/Dropped .* at position 1\./);

  await expect(waitingRows(first)).toHaveText(order('Charlie', 'Alpha', 'Bravo'));
  await expect(waitingRows(second)).toHaveText(order('Charlie', 'Alpha', 'Bravo'), {
    timeout: 3_000,
  });
  await context.close();
});

test('the move buttons reorder, and Undo puts the guest back', async ({ devices, browser }) => {
  const { first, second, context } = await threeGuestsOnTwoTablets({ devices, browser });
  const charlie = waitingRows(first).filter({ hasText: 'Charlie' });
  await charlie.getByRole('button', { name: /^Move .* to the top$/ }).click();
  await expect(waitingRows(first)).toHaveText(order('Charlie', 'Alpha', 'Bravo'));
  await expect(waitingRows(second)).toHaveText(order('Charlie', 'Alpha', 'Bravo'), {
    timeout: 3_000,
  });

  await waitingRows(first)
    .filter({ hasText: 'Charlie' })
    .getByRole('button', { name: /^Move .* down$/ })
    .click();
  await expect(waitingRows(first)).toHaveText(order('Alpha', 'Charlie', 'Bravo'));

  // The first row cannot move up or to the top; the last cannot move down.
  await expect(
    waitingRows(first)
      .first()
      .getByRole('button', { name: /to the top$/ }),
  ).toBeDisabled();
  await expect(waitingRows(first).last().getByRole('button', { name: /down$/ })).toBeDisabled();

  await first
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Undo' })
    .last()
    .click();
  await expect(waitingRows(first)).toHaveText(order('Charlie', 'Alpha', 'Bravo'));
  await expectNoSeriousA11yViolations(first);
  await context.close();
});
