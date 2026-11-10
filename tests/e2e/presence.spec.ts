import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, test } from './fixtures.ts';
import { signInAs } from './support/auth.ts';
import { createMember } from './support/members.ts';

// 2B-S2 (#272): a staff member goes on break; a colleague's team strip shows it and Call next is
// disabled with an explanation for the person on break.

test('AC1: A goes on break and B sees it within seconds', async ({ devices }) => {
  const { staff, guest } = devices;
  const { email } = await createMember(`Colleague ${crypto.randomUUID().slice(0, 6)}`);
  // The second tablet is the signed-out "guest" page, signed in as the new colleague.
  await signInAs(guest, { email, password: DEMO_PASSWORD });
  await guest.goto('/staff');
  await staff.goto('/staff');

  await expect(guest.getByTestId('presence-bar')).toBeVisible();
  await guest.getByLabel('Your status').selectOption('available');
  await staff.getByLabel('Your status').selectOption('break');

  await expect(staff.getByTestId('break-timer')).toContainText('On break for');
  await expect(staff.getByText("You're on break", { exact: false }).first()).toBeVisible();
  await expect(guest.getByTestId('team-strip')).toContainText('On break', { timeout: 10_000 });
  await expect(guest.getByTestId('team-strip')).toContainText('Available');

  await staff.getByLabel('Your status').selectOption('available');
  await expect(guest.getByTestId('team-strip').getByText('On break')).toHaveCount(0, {
    timeout: 10_000,
  });
});
