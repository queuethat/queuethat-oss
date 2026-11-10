import { randomUUID } from 'node:crypto';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { expectedVisit, guestJoins, openQueue } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2A-ST10 (#143): today's appointments and walk-ins on one timeline, with check-in.

/** The timeline spans the whole location, so each test names its guests apart from other runs'. */
const uniq = (name: string) => `${name} ${randomUUID().slice(0, 5)}`;

test('AC1: an appointment and two walk-ins render at their times, in order, with a now-line', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const [wes, wil, lou] = [uniq('Walk Wes'), uniq('Walk Wil'), uniq('Later Lou')];
  await guestJoins(wes, queue.id);
  await guestJoins(wil, queue.id);
  await expectedVisit(queue.id, lou, 60);
  await openQueue(staff, queue.id);

  await staff.getByRole('button', { name: 'Timeline' }).click();
  const timeline = staff.getByTestId('timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText(wes);
  await expect(timeline).toContainText(wil);
  await expect(timeline).toContainText(lou);
  await expect(staff.getByTestId('timeline-now')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  const entries = staff.getByTestId('timeline-entry');
  // Walk-ins joined just now, so they come before the appointment an hour away.
  const names = await entries.allTextContents();
  expect(names.findIndex((x) => x.includes(lou))).toBeGreaterThan(
    names.findIndex((x) => x.includes(wil)),
  );
  await expect(staff.getByTestId('timeline-entry').filter({ hasText: lou })).toHaveAttribute(
    'data-status',
    'expected',
  );
});

test('AC2: checking in an overdue arrival moves them to waiting within 3 s', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const ada = uniq('Arrival Ada');
  await expectedVisit(queue.id, ada, -5);
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Timeline' }).click();

  const entry = staff.getByTestId('timeline-entry').filter({ hasText: ada });
  await expect(entry).toHaveAttribute('data-status', 'expected');
  await expect(entry).toContainText('Late');
  await entry.getByRole('button', { name: /^Check in / }).click();
  await expect(entry).toHaveAttribute('data-status', 'waiting', { timeout: 3_000 });
  await expect(entry.getByRole('button', { name: /^Check in / })).toHaveCount(0);
  await expect(entry).not.toContainText('Late');
});

test('the timeline fits a phone-width screen', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const nia = uniq('Narrow Nia');
  await expectedVisit(queue.id, nia, 30);
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Timeline' }).click();
  await staff.setViewportSize({ width: 375, height: 800 });
  await expect(staff.getByTestId('timeline')).toContainText(nia);
  const overflow = await staff.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
