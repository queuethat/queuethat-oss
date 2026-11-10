import { expect, test } from './fixtures.ts';
import { createMember } from './support/members.ts';

// 2A-TM5 (#99): a shared tablet signed in as the shop's account switches to a colleague with a PIN.

const SESSION_KEY = 'qm-operator-session';

async function enterPin(page: import('@playwright/test').Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole('button', { name: `Digit ${digit}`, exact: true }).click();
  }
}

test('AC1: a colleague switches in with their PIN, then locks the tablet', async ({ devices }) => {
  const { staff } = devices;
  const name = `Switcher ${crypto.randomUUID().slice(0, 8)}`;
  await createMember(name, { pin: '2468' });

  await staff.goto('/staff');
  const chip = staff.getByTestId('operator-chip');
  await expect(chip).toContainText("This tablet's account");
  await chip.getByRole('button', { name: 'Switch operator' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Who is working?' });
  await dialog.getByLabel('Name').selectOption({ label: name });

  await enterPin(staff, '1357');
  await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText("That PIN didn't work");
  await expect(dialog.getByTestId('pin-dots')).toHaveText('');

  await enterPin(staff, '2468');
  await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(chip).toContainText(`Working as ${name}`);
  // The token is kept for this tab only.
  expect(await staff.evaluate((k) => window.sessionStorage.getItem(k), SESSION_KEY)).toContain(
    '"token"',
  );
  expect(await staff.evaluate((k) => window.localStorage.getItem(k), SESSION_KEY)).toBeNull();

  await chip.getByRole('button', { name: 'Lock' }).click();
  await expect(chip).toContainText("This tablet's account");
  expect(await staff.evaluate((k) => window.sessionStorage.getItem(k), SESSION_KEY)).toBeNull();
});

test('AC2: a dead token is dropped and the tablet falls back to its own account', async ({
  devices,
}) => {
  const { staff } = devices;
  await staff.addInitScript((key) => {
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        token: 'not-a-real-token',
        userId: '00000000-0000-4000-8000-000000000000',
        displayName: 'Ghost',
        role: 'staff',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  }, SESSION_KEY);
  await staff.goto('/staff');
  await expect(staff.getByTestId('operator-chip')).toContainText("This tablet's account");
});

test('AC3: the tablet locks after 10 idle minutes, with a warning first', async ({ devices }) => {
  const { staff } = devices;
  const name = `Idle ${crypto.randomUUID().slice(0, 8)}`;
  await createMember(name, { pin: '2468' });
  await staff.clock.install();
  await staff.goto('/staff');
  const chip = staff.getByTestId('operator-chip');
  await chip.getByRole('button', { name: 'Switch operator' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Who is working?' });
  await dialog.getByLabel('Name').selectOption({ label: name });
  await enterPin(staff, '2468');
  await dialog.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(chip).toContainText(`Working as ${name}`);

  await staff.clock.fastForward(9 * 60_000 + 45_000);
  const warning = staff.getByRole('dialog', { name: 'Still there?' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(warning).toBeHidden();

  await staff.clock.fastForward(10 * 60_000 + 1_000);
  await expect(chip).toContainText("This tablet's account");
});

test('AC4: Set my PIN rejects a weak PIN and saves a good one', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  await staff.getByRole('button', { name: 'Set my PIN' }).click();
  const dialog = staff.getByRole('dialog', { name: 'Set my PIN' });
  await enterPin(staff, '1234');
  await dialog.getByRole('button', { name: 'Save PIN' }).click();
  await expect(dialog.getByRole('alert')).toContainText('4 to 8 digits');
  await enterPin(staff, '7391');
  await dialog.getByRole('button', { name: 'Save PIN' }).click();
  await expect(staff.getByText('PIN saved.')).toBeVisible();
});
