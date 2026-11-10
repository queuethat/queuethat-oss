import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 2B-R4 (#295): owners see a weekday by hour view of arrivals, waits and suggested staff.
test.use({ staffUser: 'owner' });

test('metric toggle, table fallback and axe on the busy-hours view', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/heatmap');
  await expect(staff.getByRole('heading', { name: 'Busy hours' })).toBeVisible();
  await staff.getByLabel('Period').selectOption('26');
  await staff.getByLabel('Show').selectOption('suggestedStaff');
  await expect(staff.getByLabel('Show')).toHaveValue('suggestedStaff');
  // Either the demo shop has history (a table with every weekday) or the empty state shows.
  const table = staff.getByTestId('peak-heatmap');
  const empty = staff.getByText('No visits in this period.');
  await expect(table.or(empty)).toBeVisible();
  if (await table.isVisible()) {
    await expect(table.getByRole('rowheader', { name: 'Monday' })).toBeVisible();
  }
  await expectNoSeriousA11yViolations(staff);
});
