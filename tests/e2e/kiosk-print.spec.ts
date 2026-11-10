import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openKiosk, shop } from './support/kiosk.ts';

// 2A-KSK2 (#120): the kiosk can print a ticket slip after a check-in, per the device's setting.
// window.print is replaced with a counter: a real dialog would block the page, and the slip's
// layout is checked with print media emulation instead.

test.use({ staffUser: null });

async function checkIn(kiosk: Page, setting: 'off' | 'ask' | 'always') {
  await kiosk.addInitScript((value) => {
    localStorage.setItem('qm:kiosk:print', value);
    (window as unknown as { prints: number }).prints = 0;
    window.print = () => void ((window as unknown as { prints: number }).prints += 1);
  }, setting);
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await kiosk.getByLabel('First name').fill('Robin');
  await kiosk.getByRole('button', { name: 'Get my ticket' }).click();
  await expect(kiosk.getByTestId('kiosk-ticket')).toBeVisible();
}

const prints = (kiosk: Page) =>
  kiosk.evaluate(() => (window as unknown as { prints: number }).prints);

test('AC1: with "always" a join prints once, and the slip carries ticket, queue and QR', async ({
  devices,
}, testInfo) => {
  const { staff: kiosk } = devices;
  await checkIn(kiosk, 'always');
  await expect.poll(() => prints(kiosk)).toBe(1);

  // The slip on screen is hidden; on paper it is the only thing left.
  const slip = kiosk.getByTestId('kiosk-slip');
  await expect(slip).toBeHidden();
  await kiosk.emulateMedia({ media: 'print' });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText('Front desk');
  await expect(slip).toContainText(/Joined at/);
  await expect(slip.getByTestId('kiosk-ticket')).toHaveCount(0);
  await expect(slip.locator('svg.kiosk-slip-qr')).toBeVisible();
  await expect(kiosk.getByRole('button', { name: 'Done' })).toBeHidden();
  const box = await slip.boundingBox();
  expect(box!.width).toBeLessThanOrEqual((80 / 25.4) * 96 + 1); // 80 mm at 96 dpi
  await testInfo.attach('slip', { body: await slip.screenshot(), contentType: 'image/png' });

  // The confirmation's own refreshes (its countdown re-renders it every second) do not print again.
  await kiosk.clock.runFor(3_000);
  expect(await prints(kiosk)).toBe(1);
});

test('AC2: with "off" there is no print dialog and no print button', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await checkIn(kiosk, 'off');
  await expect(kiosk.getByRole('button', { name: 'Print my ticket' })).toHaveCount(0);
  await expect(kiosk.getByTestId('kiosk-slip')).toHaveCount(0);
  await kiosk.clock.runFor(3_000);
  expect(await prints(kiosk)).toBe(0);
});

test('with "ask" the guest taps to print, once per tap', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await checkIn(kiosk, 'ask');
  expect(await prints(kiosk)).toBe(0);
  await kiosk.getByRole('button', { name: 'Print my ticket' }).click();
  expect(await prints(kiosk)).toBe(1);
});

test('the setting is changed on the device and survives a reload', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await kiosk.getByText('Device settings').click();
  await kiosk.getByLabel('Print ticket').selectOption('always');
  await kiosk.reload();
  await kiosk.getByText('Device settings').click();
  await expect(kiosk.getByLabel('Print ticket')).toHaveValue('always');
});
