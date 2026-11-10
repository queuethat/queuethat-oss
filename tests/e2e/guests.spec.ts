import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { freshQueue } from './support/queues.ts';

// 2P-CRM3 (#186): staff search guests, open a profile, manage contacts.

test.describe('as staff', () => {
  test.use({ staffUser: 'staff' });

  test('AC1: a guest with 3 visits shows all 3 newest first', async ({ devices }) => {
    const { staff } = devices;
    const queue = await freshQueue();
    const name = `Regular ${crypto.randomUUID().slice(0, 6)}`;
    await seedGuest(queue.id, name, uniquePhone(), 3);

    await staff.goto('/admin/guests');
    await expect(staff.getByRole('heading', { name: 'Guests' })).toBeVisible();
    await staff.getByLabel('Search by name, phone or email').fill(name);
    const row = staff.getByTestId('guest-row').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('3');
    await expectNoSeriousA11yViolations(staff);

    await row.getByRole('link', { name: `Open ${name}` }).click();
    await expect(staff.getByRole('heading', { name })).toBeVisible();
    const visits = staff.getByTestId('guest-visit');
    await expect(visits).toHaveCount(3);
    // The newest visit is the one still waiting; the two before it were cancelled.
    await expect(visits.nth(0)).toContainText('Waiting');
    await expect(visits.nth(1)).toContainText('Cancelled');
    await expect(visits.nth(2)).toContainText('Cancelled');
    await expectNoSeriousA11yViolations(staff);
  });

  test('AC2: a saved phone shows masked, and a tap reveals it', async ({ devices }) => {
    const { staff } = devices;
    const queue = await freshQueue();
    const name = `Contact ${crypto.randomUUID().slice(0, 6)}`;
    await seedGuest(queue.id, name, uniquePhone(), 1);

    await staff.goto('/admin/guests');
    await staff.getByLabel('Search by name, phone or email').fill(name);
    await staff.getByRole('link', { name: `Open ${name}` }).click();

    const phone = '+14155550' + String(Math.floor(Math.random() * 900) + 100);
    await staff.getByRole('button', { name: 'Add contact' }).click();
    const dialog = staff.getByRole('dialog', { name: 'Add a contact' });
    await dialog.getByLabel('Type').selectOption('email');
    await dialog.getByLabel('Phone number or email').fill('not an email');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toContainText("doesn't look right");
    await dialog.getByLabel('Type').selectOption('phone');
    await dialog.getByLabel('Phone number or email').fill(phone);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const added = staff.getByTestId('guest-contact').filter({ hasText: phone.slice(-4) });
    await expect(added).toHaveCount(1);
    await expect(added).not.toContainText(phone);
    await added.getByRole('button', { name: /^Show/ }).click();
    await expect(added).toContainText(phone);

    // The list shows it masked too.
    await staff.goto('/admin/guests');
    await staff.getByLabel('Search by name, phone or email').fill(name);
    const listed = staff.getByTestId('guest-row').filter({ hasText: name });
    await expect(listed).toContainText('•');
    await expect(listed).not.toContainText(phone);

    // Removing needs a confirmation.
    await staff.goBack();
    await added.getByRole('button', { name: /^Remove/ }).click();
    await staff.getByRole('button', { name: 'Remove contact' }).click();
    await expect(added).toHaveCount(0);
  });

  test('a short search asks for more and a stranger finds nothing', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/guests');
    await expect(staff.getByText('Search for a guest to see their history.')).toBeVisible();
    await staff.getByLabel('Search by name, phone or email').fill('zzzzqq-nobody');
    await expect(staff.getByText('No guests match.')).toBeVisible();
  });
});
