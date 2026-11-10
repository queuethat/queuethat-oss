import { readFile } from 'node:fs/promises';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2P-RPT3 (#199): owners read wait, throughput and outcome trends for a range.
test.use({ staffUser: 'owner' });

test('AC1, AC2: charts and the table agree, the CSV matches, and axe is clean', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  // Two visits in the queue today: one cancelled, one still waiting.
  await seedGuest(queue.id, 'Analytics Guest', uniquePhone(), 2);

  await staff.goto('/admin/analytics');
  await expect(staff.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await staff.getByLabel('Queue').selectOption(queue.id);
  // Visits added at the desk have no service, so the service filter is left on All.
  await expect(staff.getByLabel('Service')).toBeEnabled();

  await expect(staff.getByRole('img', { name: 'Joined over the selected range' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await staff.getByRole('tab', { name: 'Table' }).click();
  const row = staff.getByRole('row').nth(1);
  await expect(row.getByRole('cell').first()).toHaveText('2');

  const download = staff.waitForEvent('download');
  await staff.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  const [header, line] = csv.trim().split('\r\n');
  expect(header).toContain('Joined');
  expect(line!.split(',')[1]).toBe('2');
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('Group by').selectOption('hour');
  await staff.getByRole('tab', { name: 'Charts' }).click();
  await expect(staff.getByTestId('heatmap')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
