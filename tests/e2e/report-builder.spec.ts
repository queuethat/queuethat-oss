import { readFile } from 'node:fs/promises';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 4-RPT2 (#393): managers build a report from the catalogue, see the table and chart, download and save it.
test.use({ staffUser: 'owner' });

test('AC1, AC2: the table, chart and CSV show the run_report numbers and axe is clean', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  // One seeded guest leaves two visits in the queue today (one cancelled, one waiting).
  await seedGuest(queue.id, 'Report Guest', uniquePhone(), 2);

  await staff.goto('/admin/reports/custom');
  await expect(staff.getByRole('heading', { name: 'Custom reports' })).toBeVisible();
  await staff.getByLabel('Weekday').uncheck();
  await staff.getByLabel('Queue', { exact: true }).check();
  await staff.getByRole('button', { name: 'Run report' }).click();

  const row = staff.getByTestId('report-table').getByRole('row').filter({ hasText: queue.name });
  await expect(row.getByRole('cell').nth(1)).toHaveText('2');
  await expect(staff.getByRole('img', { name: 'Visits for each group' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  const download = staff.waitForEvent('download');
  await staff.getByRole('button', { name: 'Download CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  const [header, ...lines] = csv.trim().split('\r\n');
  expect(header).toBe('Queue,Visits,Served');
  expect(lines.find((l) => l.startsWith(queue.name))).toBe(`${queue.name},2,0`);

  const name = `Queues ${queue.name}`;
  await staff.getByLabel('Report name').fill(name);
  await staff.getByRole('button', { name: 'Save report' }).click();
  await expect(staff.getByText('Report saved.')).toBeVisible();
  await staff.reload();
  await staff.getByLabel('Saved reports').selectOption({ label: name });
  await expect(staff.getByLabel('Queue', { exact: true })).toBeChecked();
});
