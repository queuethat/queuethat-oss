import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { ownerOfNewBusiness, readAs, signInTo } from './support/accounts.ts';

// 2P-NTF7 (#179): owners reword notification templates with a live preview and segment count.

test('AC3: staff see the templates but cannot change them', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/templates');
  await expect(staff.getByRole('heading', { name: 'Message templates' })).toBeVisible();
  await expect(
    staff.getByText('Only managers, admins and owners can change templates.'),
  ).toBeVisible();
  await staff.getByRole('button', { name: "View It's your turn, Push" }).click();
  await expect(staff.getByLabel('Message')).toBeDisabled();
  await expect(staff.getByRole('button', { name: 'Save template' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(staff);
});

test.describe('as an owner', () => {
  test.use({ staffUser: null });

  test('AC1, AC2: preview and segments follow each keystroke; revert removes the override', async ({
    devices,
  }) => {
    const { staff } = devices;
    const { email } = await ownerOfNewBusiness();
    await signInTo(staff, email, '/admin/templates');
    const rows = () =>
      readAs(email, [
        'notification_templates?select=trigger,channel,body,version&org_id=not.is.null',
      ]).then(([r]) => r as { trigger: string; channel: string; body: string; version: number }[]);

    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    const body = staff.getByLabel('Message');
    await body.fill('Hi {{guest_first_name}}, ');
    await expect(staff.getByTestId('preview')).toHaveText('Hi Sam,');
    await staff.getByRole('button', { name: 'Insert ticket' }).click();
    await expect(staff.getByTestId('preview')).toHaveText('Hi Sam, A012');
    await expect(staff.getByTestId('segments')).toContainText('1 text segment');
    await body.fill(`${'x'.repeat(161)}`);
    await expect(staff.getByTestId('segments')).toContainText('2 text segments');
    await body.fill('Hi {{guest_first_name}}, {{ticket}} is up!');
    await expectNoSeriousA11yViolations(staff);

    await body.fill('Hello {{nope}}');
    await staff.getByRole('button', { name: 'Save template' }).click();
    await expect(staff.getByRole('alert')).toHaveText(
      "nope isn't a variable this message can use.",
    );
    expect(await rows()).toEqual([]);

    await body.fill('Hi {{guest_first_name}}, {{ticket}} is up!');
    await staff.getByRole('button', { name: 'Save template' }).click();
    await expect(staff.getByText('Custom', { exact: true })).toBeVisible();
    expect(await rows()).toEqual([
      {
        trigger: 'called',
        channel: 'sms',
        body: 'Hi {{guest_first_name}}, {{ticket}} is up!',
        version: 1,
      },
    ]);

    await staff.getByRole('button', { name: "Edit It's your turn, SMS" }).click();
    await staff.getByRole('button', { name: 'Revert to default' }).click();
    await staff.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(staff.getByText('Custom', { exact: true })).toHaveCount(0);
    expect(await rows()).toEqual([]);
  });
});
