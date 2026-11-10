import { readFile } from 'node:fs/promises';
import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, signInAs, test } from './fixtures.ts';
import { seedGuest, uniquePhone } from './support/guests.ts';
import { createMember } from './support/members.ts';
import { freshQueue } from './support/queues.ts';

// 2P-PRV4 (#191): owners answer a data request by exporting or erasing a guest.

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: erasing with the typed name removes the guest and shows counts; export downloads JSON', async ({
    devices,
  }) => {
    const { staff } = devices;
    const queue = await freshQueue();
    const name = `Erase Me ${crypto.randomUUID().slice(0, 6)}`;
    const phone = uniquePhone();
    await seedGuest(queue.id, name, phone, 2);

    await staff.goto('/admin/privacy/requests');
    await expect(staff.getByRole('heading', { name: 'Data requests' })).toBeVisible();
    await staff.getByLabel('Phone number or email').fill(phone);
    await staff.getByRole('button', { name: 'Find guest' }).click();
    const match = staff.getByTestId('match').filter({ hasText: name });
    await expect(match).toHaveCount(1);
    await expect(match).toContainText('2 visits');
    await expectNoSeriousA11yViolations(staff);

    const download = staff.waitForEvent('download');
    await match.getByRole('button', { name: `Download export for ${name}` }).click();
    const file = await (await download).path();
    expect(await readFile(file, 'utf8')).toContain(name);

    await match.getByRole('button', { name: `Erase ${name}` }).click();
    const dialog = staff.getByRole('dialog', { name: `Erase ${name}?` });
    const confirm = dialog.getByRole('button', { name: 'Erase guest' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await expect(confirm).toBeDisabled(); // a reason is required too
    await dialog.getByLabel('Reason').fill('request by email');
    await confirm.click();

    await expect(staff.getByTestId('erased-notice')).toContainText('2 visits made anonymous');
    // Gone from search.
    await staff.getByLabel('Phone number or email').fill(phone);
    await staff.getByRole('button', { name: 'Find guest' }).click();
    await expect(staff.getByText('No guest holds that phone number or email.')).toBeVisible();
  });
});

test('AC2: a manager cannot reach the page', async ({ devices }) => {
  const { guest } = devices;
  const { email } = await createMember(`Manager ${crypto.randomUUID().slice(0, 6)}`, {
    role: 'manager',
  });
  // A stored session, not the sign-in form: its own redirect to /staff races the goto below.
  await signInAs(guest, { email, password: DEMO_PASSWORD });

  await guest.goto('/admin/privacy/requests');
  await expect(guest).toHaveURL(/\/admin$/);
  await expect(guest.getByRole('link', { name: 'Data requests' })).toHaveCount(0);
});
