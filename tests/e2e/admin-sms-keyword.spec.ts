import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, signInTo } from './support/accounts.ts';

// J-8 admin (#357): the text-to-join word is validated as you type, and the poster only shows the
// line when SMS is switched on.

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('a reserved word is refused, and the poster omits the line while SMS is off', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/queues');
    await staff.getByRole('button', { name: 'Add a queue' }).click();
    await staff.getByLabel('Queue name').fill('Barbers');
    await staff.getByLabel('Ticket letters').fill('b');

    // AC1: HELP is a carrier keyword.
    await staff.getByRole('button', { name: 'More options' }).click();
    await staff.getByLabel('Text-to-join word').fill('HELP');
    await expect(staff.getByText(/reserved for stopping, starting, help or replies/)).toBeVisible();
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue')).toHaveCount(0);
    await expectNoSeriousA11yViolations(staff);

    await staff.getByLabel('Text-to-join word').fill('cuts');
    await expect(staff.getByText(/reserved for stopping/)).toHaveCount(0);
    await staff.getByRole('button', { name: 'Save queue' }).click();
    await expect(staff.getByTestId('queue')).toBeVisible();

    // AC2: a keyword is set, but SMS is not enabled, so the poster has no text line.
    await staff.goto('/admin/poster');
    await expect(staff.getByTestId('poster')).toBeVisible();
    await expect(staff.getByTestId('poster-text-to-join')).toHaveCount(0);
  });
});
