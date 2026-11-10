import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { backdateVisit, guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST13 (#146): correct a finished visit's times from its history.

/** "HH:mm" moved by `minutes`, staying inside the day. */
function shift(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h! * 60 + m! + minutes;
  if (total >= 24 * 60 || total < 0) total -= 2 * minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Hours to backdate: up to 3, fewer when that would carry the visit back across the location's
 * midnight (the history lists today's finished visits, and a time within 10 minutes of midnight
 * makes the "five minutes earlier" check wrap to a later time, so the order error never comes).
 */
function backdateHours(timeZone = 'America/New_York'): number {
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return Math.min(3, Math.floor((hour! * 60 + minute! - 10) / 60));
}

test('AC1: a correction shows in the history as "times corrected by" with old and new values', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Late Lena', queue.id);
  await openQueue(staff, queue.id);
  const ticket = (
    (await staff
      .getByTestId('section-waiting')
      .getByTestId('visit')
      .locator('span')
      .first()
      .textContent()) ?? ''
  ).trim();
  await staff.getByRole('button', { name: `Call ${ticket}` }).click();
  await staff.getByRole('button', { name: `Start ${ticket}` }).click();
  await staff.getByRole('button', { name: `Done with ${ticket}` }).click();
  await backdateVisit(queue.id, Math.max(0, backdateHours()));
  await openQueue(staff, queue.id);

  const done = staff
    .getByTestId('section-done')
    .getByTestId('done-visit')
    .filter({ hasText: ticket });
  await done.getByRole('button', { name: `History of ${ticket}` }).click();
  await staff.getByRole('button', { name: 'Edit times' }).click();
  const dialog = staff.getByRole('dialog', { name: `Edit times of ${ticket}` });
  const finished = dialog.getByLabel('Finished at');
  const before = await finished.inputValue();
  const after = shift(before, 5);

  // Order is checked before anything is sent: finished before called is refused on the spot.
  await finished.fill(shift(before, -5));
  await dialog.getByLabel('Reason for the correction').fill('Forgot to tap Done');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Times must run in order');

  await finished.fill(after);
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await expect(dialog).toHaveCount(0);

  const history = staff.getByRole('dialog', { name: `History of ${ticket}` });
  const entry = history.getByTestId('history-entry').filter({ hasText: 'times corrected by' });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Finished at:');
  await expect(entry).toContainText('→');
});
