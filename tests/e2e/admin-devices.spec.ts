import { OFFLINE_AFTER_MS } from '../../apps/web/src/features/admin/devices/status.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { pair, servePairDevice } from './support/pairing.ts';

// D2 (#49): owners pair screens from /admin/devices, see when one went quiet, and revoke it.

test('staff cannot manage screens', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/admin/devices');
  await expect(staff.getByRole('heading', { name: 'Screens' })).toBeVisible();
  await expect(
    staff.getByText('Only admins and owners can pair and manage screens.'),
  ).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Create pairing code' })).toHaveCount(0);
});

test.describe('as an owner', () => {
  test.use({ staffUser: 'owner' });

  test('AC1: a paired TV shows online, then offline after 5 quiet minutes, then is revoked', async ({
    devices,
  }) => {
    const { staff, display } = devices;
    const name = `E2E admin TV ${crypto.randomUUID()}`;
    await staff.clock.install();
    await staff.goto('/admin/devices');
    await staff.getByLabel('Name').fill(name);
    await staff.getByRole('button', { name: 'Create pairing code' }).click();
    const code = staff.getByTestId('pairing-code');
    await expect(code).toContainText('Expires in 10:00');
    await expect(code).toContainText('/display');
    await expectNoSeriousA11yViolations(staff);

    await servePairDevice(display);
    await display.goto('/display');
    await pair(display, (await code.locator('.font-mono').innerText()).trim());
    await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();

    // The used code goes away and the screen shows up without a reload or the list's 30 s poll.
    await expect(code).toContainText('Paired. The screen is in the list below.');
    await expect(code).not.toContainText('Expires in');
    const row = staff.getByTestId('device').filter({ hasText: name });
    await expect(row).toContainText('Online', { timeout: 10_000 });
    await expect(row).toContainText('TV display');

    // The TV goes dark; nothing checks in while the admin page's clock moves on.
    await display.close();
    await staff.clock.fastForward(OFFLINE_AFTER_MS + 30_000);
    await expect(row).toContainText('Offline');
    await expect(row).toContainText(/Last seen [56] minutes ago/);

    await row.getByRole('button', { name: 'Revoke' }).click();
    const dialog = staff.getByRole('dialog', { name: `Revoke ${name}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke screen' }).click();
    await expect(row).toHaveCount(0);
  });
});
