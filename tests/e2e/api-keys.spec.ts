import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// 2B-I2 (#307): owners create API keys, copy them once, and revoke them.

test('AC2: staff cannot open the page', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/developers/api-keys');
  await expect(staff.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(staff.getByText('Only admins and owners can manage API keys.')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Create key' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: the plaintext is shown once; the list keeps only the prefix; revoke asks first', async ({
    devices,
  }) => {
    const { staff } = devices;
    const name = `E2E key ${crypto.randomUUID().slice(0, 8)}`;
    await staff.goto('/admin/developers/api-keys');
    await staff.getByRole('button', { name: 'Create key' }).click();
    const form = staff.getByRole('dialog', { name: 'Create an API key' });
    await form.getByRole('textbox', { name: 'Name' }).fill(name);
    await form.getByLabel('Read visits').check();
    await expectNoSeriousA11yViolations(staff);
    await form.getByRole('button', { name: 'Create key' }).click();

    const shown = staff.getByTestId('shown-key');
    const plaintext = await shown.getByLabel('Your new key').inputValue();
    expect(plaintext).toMatch(/^qk_live_[0-9a-f]{8}_[0-9a-f]{32}$/);
    // The dialog cannot be closed until the key is confirmed as stored.
    const done = staff.getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();
    await staff.getByLabel('I have stored this key').check();
    await done.click();

    const row = staff.getByTestId('api-key').filter({ hasText: name });
    await expect(row).toContainText(`qk_live_${plaintext.split('_')[2]}_…`);
    await expect(row).toContainText('Read queues, Read visits');
    await expect(staff.locator('body')).not.toContainText(plaintext);

    await row.getByRole('button', { name: `Revoke ${name}` }).click();
    const dialog = staff.getByRole('dialog', { name: `Revoke ${name}?` });
    await dialog.getByRole('button', { name: 'Revoke key' }).click();
    await expect(row).toContainText('Revoked');
    await expect(row.getByRole('button', { name: `Revoke ${name}` })).toHaveCount(0);
  });
});
