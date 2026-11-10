import type { Locator, Page } from '@playwright/test';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { openKiosk, shop } from './support/kiosk.ts';

// 2B-D4 (#261): the kiosk's accessibility mode, and a join with the keyboard alone.

test.use({ staffUser: null });

/** Tab until `target` has focus, as a person with a keyboard or switch device would. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('never reached by Tab');
}

test('AC1: the mode is on every screen, doubles text, passes axe, and resets after the guest', async ({
  devices,
}) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  const toggle = kiosk.getByTestId('a11y-toggle');
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  const size = () =>
    kiosk.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const normal = await size();

  await toggle.click();
  await expect(kiosk.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  expect(await size()).toBe(normal * 2);
  await expectNoSeriousA11yViolations(kiosk);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(toggle).toBeVisible();
  await expectNoSeriousA11yViolations(kiosk);
  // No content is cut off sideways at 200%.
  expect(
    await kiosk.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  // The idle reset ends the mode with the guest's session.
  await kiosk.clock.runFor(66_000);
  await expect(kiosk.locator('html')).not.toHaveAttribute('data-theme', 'high-contrast');
  expect(await size()).toBe(normal);
});

test('AC2: a guest completes a join with the keyboard alone', async ({ devices }) => {
  const { staff: kiosk } = devices;
  await openKiosk(kiosk, (await shop()).code);
  await tabTo(kiosk, kiosk.getByTestId('a11y-toggle'));
  await kiosk.keyboard.press('Space');
  await expect(kiosk.locator('html')).toHaveAttribute('data-theme', 'high-contrast');

  const start = kiosk.getByRole('button', { name: 'Check in' });
  await tabTo(kiosk, start);
  await kiosk.keyboard.press('Enter');

  const name = kiosk.getByLabel('First name');
  await tabTo(kiosk, name);
  await kiosk.keyboard.type('Robin');
  const submit = kiosk.getByRole('button', { name: 'Get my ticket' });
  await tabTo(kiosk, submit);
  await kiosk.keyboard.press('Enter');
  await expect(kiosk.getByTestId('kiosk-ticket')).toBeVisible();
  await expectNoSeriousA11yViolations(kiosk);
});
