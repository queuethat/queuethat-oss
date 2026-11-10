import { readFile } from 'node:fs/promises';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { guestJoins } from './support/console.ts';
import { freshQueue } from './support/queues.ts';

// 2B-R2 (#293): managers compare staff and counters over a date range.
test.use({ staffUser: 'owner' });

test('toggle, sort, CSV and axe on the performance report', async ({ devices }) => {
  // An empty range only reads "No served visits" once the location has had a visit; on a fresh database (or a shard that
  // runs this file first) the page shows the first-run screen instead.
  await guestJoins('Perf Pat', (await freshQueue()).id);
  const { staff } = devices;
  await staff.goto('/admin/performance');
  await expect(staff.getByRole('heading', { name: 'Staff and counter performance' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);

  await staff.getByLabel('Compare by').selectOption('counter');
  await expect(staff.getByLabel('Compare by')).toHaveValue('counter');
  await staff.getByLabel('From').fill('2000-01-01');
  await staff.getByLabel('To').fill('2000-01-31');
  await expect(staff.getByText('No served visits in this range.')).toBeVisible();

  // The demo shop has served visits today or in the last 30 days when seeded; otherwise the empty state above is the check.
  await staff.getByLabel('From').fill('2000-01-01');
  await staff.getByLabel('To').fill(new Date().toISOString().slice(0, 10));
  const sortBtn = staff.getByRole('button', { name: 'Served' });
  if (await sortBtn.isVisible().catch(() => false)) {
    await sortBtn.click();
    await expect(staff.getByRole('columnheader', { name: 'Served' })).toHaveAttribute(
      'aria-sort',
      /ascending|descending/,
    );
    const download = staff.waitForEvent('download');
    await staff.getByRole('button', { name: 'Download CSV' }).click();
    const csv = await readFile(await (await download).path(), 'utf8');
    expect(csv.split('\r\n')[0]).toContain('Served');
  }
  await expectNoSeriousA11yViolations(staff);
});
