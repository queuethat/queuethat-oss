import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// DS-16 (#1020): a brand new business sees an explanation and one next step on each empty screen.
test.use({ staffUser: null });

test('empty screens of a new business explain themselves and offer a next step', async ({
  devices,
}) => {
  const { staff } = devices;
  const { email } = await ownerOfNewBusiness();
  await signInTo(staff, email, '/admin/queues');

  await expect(staff.getByText('No queues yet')).toBeVisible();
  await expect(staff.getByText('A queue is a line guests can join.')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Use a template' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
  // The one action opens the form instead of sending the owner hunting for a button.
  await staff.getByRole('button', { name: 'Add your first queue' }).click();
  await expect(staff.getByLabel('Queue name')).toBeVisible();

  await staff.goto('/admin/counters');
  await expect(staff.getByText('No counters yet')).toBeVisible();
  await staff.goto('/admin/team');
  await expect(staff.getByText("It's just you")).toBeVisible();
  await staff.goto('/admin/devices');
  await expect(staff.getByText('No screens paired')).toBeVisible();
  await staff.goto('/admin/guests');
  await expect(staff.getByText('No guests yet')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Open your join page' })).toBeVisible();
  await staff.goto('/admin/analytics');
  await expect(staff.getByText('No numbers yet')).toBeVisible();
  await staff.goto('/admin/feedback');
  await expect(staff.getByText('No feedback yet')).toBeVisible();
  await staff.goto('/admin/developers/api-keys');
  await expect(staff.getByText('Nothing here yet')).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});
