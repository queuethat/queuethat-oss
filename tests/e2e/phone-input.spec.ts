import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';

// G1 (#51) AC1 in real engines: Chromium (Android) and WebKit (iPhone) handle caret and
// input events differently from jsdom.
test('PhoneInput keeps the caret and the rest of the number on a one-digit fix', async ({
  page,
}) => {
  await page.goto('/dev/ui');
  const input = page.getByLabel('Mobile number');
  await input.fill('');
  await input.pressSequentially('+1 415 555 0123');
  await expect(input).toHaveValue('+1 415 555 0123');
  await expect(page.getByTestId('phone-e164')).toHaveText('+14155550123');

  // Caret after the second 5 of "555": delete it and type 7.
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(9, 9));
  await page.keyboard.press('Backspace');
  await page.keyboard.type('7');

  await expect(input).toHaveValue('+1 415 575 0123');
  expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(9);
  await expect(page.getByTestId('phone-e164')).toHaveText('+14155750123');
  await expect(input).toHaveAttribute('autocomplete', 'tel');

  await expectNoSeriousA11yViolations(page);
});

test("country names follow the page's language, not the browser's", async ({ browser }) => {
  // Italian is not a guest language, so the page stays English while the browser says it-IT.
  const context = await browser.newContext({ locale: 'it-IT' });
  const page = await context.newPage();
  await page.goto(`/q/${demo.locationSlug}`);
  const country = page.getByLabel('Country code');
  await expect(country.locator('option[value="DE"]')).toHaveText('+49 Germany');
  await context.close();
});

test('a German browser gets German guest pages and German country names', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage();
  await page.goto(`/q/${demo.locationSlug}`);
  await expect(page.getByRole('heading', { name: 'Der Warteschlange beitreten' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByLabel('Landesvorwahl').locator('option[value="DE"]')).toHaveText(
    '+49 Deutschland',
  );
  await context.close();
});
