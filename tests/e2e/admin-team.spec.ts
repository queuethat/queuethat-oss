import { DEMO_PASSWORD } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { createMember } from './support/members.ts';

// 2A-TM3 (#97): owners see the team, invite people, change roles and remove members.

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: the owner removes a staff member, who loses access at once', async ({ devices }) => {
    const { staff, guest } = devices;
    const name = `Removable ${crypto.randomUUID().slice(0, 8)}`;
    const { email } = await createMember(name);

    // The staff member works in their own browser.
    await guest.goto('/auth/sign-in');
    await guest.getByLabel('Email').fill(email);
    await guest.getByLabel('Password').fill(DEMO_PASSWORD);
    await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(guest).toHaveURL(/\/staff$/);

    await staff.goto('/admin/team');
    await expect(staff.getByRole('heading', { name: 'Team' })).toBeVisible();
    const row = staff.getByTestId('member').filter({ hasText: name });
    await expect(row).toContainText('Front desk');
    await expectNoSeriousA11yViolations(staff);

    await row.getByRole('button', { name: `Remove ${name}` }).click();
    const dialog = staff.getByRole('dialog', { name: `Remove ${name}?` });
    const confirm = dialog.getByRole('button', { name: 'Remove from team' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Reason').fill('left the company');
    await confirm.click();
    await expect(row).toHaveCount(0);

    // Access ended at once: their still-valid token no longer opens /staff (they have no team now).
    await guest.goto('/staff');
    await expect(guest).toHaveURL(/\/(onboarding|auth\/sign-in)/);
  });

  test('AC2: the owner changes a role, and the invite dialog reports what the function says', async ({
    devices,
  }) => {
    const { staff } = devices;
    const name = `Promoted ${crypto.randomUUID().slice(0, 8)}`;
    await createMember(name);

    await staff.goto('/admin/team');
    const row = staff.getByTestId('member').filter({ hasText: name });
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = staff.getByRole('dialog', { name: `Edit ${name}` });
    await edit.getByRole('radio', { name: /^Manager/ }).check();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(row).toContainText('Manager');

    // CI has no edge runtime, so the function's answer is stubbed. The real handler runs in invite-accept.spec.ts.
    await staff.route('**/functions/v1/invite-staff', async (route) => {
      const body = route.request().postDataJSON() as { email: string };
      await route.fulfill({
        status: body.email.startsWith('refused') ? 403 : 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(
          body.email.startsWith('refused') ? { error: 'forbidden_role' } : { sent: true },
        ),
      });
    });
    await staff.getByRole('button', { name: 'Invite someone' }).click();
    const invite = staff.getByRole('dialog', { name: 'Invite to the team' });
    await invite.getByLabel('Email address').fill('refused@example.test');
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(invite.getByRole('alert')).toContainText("can't grant or change that role");
    await invite.getByLabel('Email address').fill('fine@example.test');
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(staff.getByText('Invitation sent to fine@example.test.')).toBeVisible();
  });

  test('you cannot edit or remove yourself from the page', async ({ devices }) => {
    const { staff } = devices;
    await staff.goto('/admin/team');
    // The owner's own row has no edit or remove buttons.
    const own = staff.getByTestId('member').filter({ hasText: 'You' });
    await expect(own).toBeVisible();
    await expect(own.getByRole('button')).toHaveCount(0);
  });
});

test('staff can see the team but not change it', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/team');
  await expect(staff.getByText('Only admins and owners can invite people')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Invite someone' })).toHaveCount(0);
  await expect(staff.getByRole('button', { name: /^(Edit|Remove)/ })).toHaveCount(0);
});
