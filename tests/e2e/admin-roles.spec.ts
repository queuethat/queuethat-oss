import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { signInAs } from './support/auth.ts';
import { createMember } from './support/members.ts';

// 4-RBAC2 (#374): owners define custom roles and give them to staff; the console follows.

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC2: a role without Call guests hides Call next on the member’s console', async ({
    devices,
  }) => {
    const { staff, guest } = devices;
    const person = `Cashier ${crypto.randomUUID().slice(0, 8)}`;
    const roleName = `Remover ${crypto.randomUUID().slice(0, 8)}`;
    const { email } = await createMember(person);

    // The member signs in on their own tablet and can call.
    await guest.goto('/auth/sign-in');
    await guest.getByLabel('Email').fill(email);
    await guest.getByLabel('Password').fill(DEMO_PASSWORD);
    await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(guest).toHaveURL(/\/staff$/);
    await expect(guest.getByRole('button', { name: 'Call next' })).toBeVisible();

    // The owner creates a role that only removes guests, and gives it to the member.
    await staff.goto('/admin/roles');
    await expect(staff.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    await staff.getByRole('button', { name: 'New role' }).click();
    const create = staff.getByRole('dialog', { name: 'New role' });
    await create.getByLabel('Role name').fill(roleName);
    await create.getByLabel('Remove guests').check();
    await expectNoSeriousA11yViolations(staff);
    await create.getByRole('button', { name: 'Save role' }).click();
    const role = staff.getByTestId('custom-role').filter({ hasText: roleName });
    await expect(role).toContainText('Remove guests');
    await expect(role).toContainText('0 people have this role');

    await staff.goto('/admin/team');
    const row = staff.getByTestId('member').filter({ hasText: person });
    await row.getByRole('button', { name: `Edit ${person}` }).click();
    const edit = staff.getByRole('dialog', { name: `Edit ${person}` });
    await edit.getByText('Advanced').click();
    await edit.getByLabel('Custom role').selectOption({ label: roleName });
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(row).toContainText(roleName);

    // On the member's next load, Call next is gone while the rest of the console works.
    await guest.reload();
    await expect(guest.getByRole('button', { name: 'Add guest' })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Call next' })).toHaveCount(0);

    // A role in use cannot be deleted.
    await staff.goto('/admin/roles');
    await staff
      .getByTestId('custom-role')
      .filter({ hasText: roleName })
      .getByRole('button', { name: `Delete ${roleName}` })
      .click();
    const dialog = staff.getByRole('dialog', { name: `Delete ${roleName}?` });
    await expect(dialog).toContainText('People still have this role');
    await expect(dialog.getByRole('button', { name: 'Delete role' })).toBeDisabled();
  });
});

test.describe('as an admin', () => {
  test.use({ staffUser: null });

  test('AC1: an admin (not an owner) sees the roles read-only', async ({ devices }) => {
    const { staff } = devices;
    const { email } = await createMember(`Admin ${crypto.randomUUID().slice(0, 8)}`, {
      role: 'admin',
    });
    await signInAs(staff, { email, password: DEMO_PASSWORD });
    await staff.goto('/admin/roles');
    await expect(staff.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
    await expect(staff.getByText('Only owners can create or change roles.')).toBeVisible();
    await expect(staff.getByRole('button', { name: 'New role' })).toHaveCount(0);
    await expect(staff.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(staff.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    await expectNoSeriousA11yViolations(staff);
  });
});
