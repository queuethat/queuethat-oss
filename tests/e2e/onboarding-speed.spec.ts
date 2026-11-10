import { expect, test } from './fixtures.ts';
import { NEW_ACCOUNT_PASSWORD } from './support/accounts.ts';
import { authLinkFor, uniqueEmail } from './support/mail.ts';

// clock-ok: only measures elapsed milliseconds; no date arithmetic around "now".
// G2 report recommendation 2 (#1175): time to a first live line is the product's pitch, so a
// regression tripwire guards it. The budget is not a promise to customers: the product claim is
// five minutes by a human, this catches a slow or lengthened flow long before that.
test.use({ staffUser: null });

/** Form screens a new owner may meet between "Create account" and the shared QR. */
const MAX_FORM_SCREENS = 6;
/** Sign-up screen plus the three wizard steps (business, location, first queue). */
const EXPECTED_FORM_SCREENS = 4;
/** Whole run on the test stack, mail round trip included. */
const BUDGET_MS = 60_000;

test('a new owner goes from sign-up to a printable QR poster in under a minute, with no dead ends', async ({
  devices,
}) => {
  const { staff } = devices;
  const email = uniqueEmail('speed');
  const started = Date.now();
  let screens = 0;

  /** A Next that is disabled must say why; a silent dead end fails the run. */
  async function expectNextNotSilentlyDisabled(name: string) {
    const next = staff.getByRole('button', { name, exact: true });
    await expect(next).toBeVisible();
    if (await next.isDisabled()) {
      const description = await next.getAttribute('aria-describedby');
      expect(description, `"${name}" is disabled with no explanation`).toBeTruthy();
    }
    return next;
  }

  // Screen 1: sign up, then open the emailed link in the same browser.
  const since = new Date();
  await staff.goto('/auth/sign-up');
  await staff.getByLabel('Email').fill(email);
  await staff.getByLabel('Password').fill(NEW_ACCOUNT_PASSWORD);
  await (await expectNextNotSilentlyDisabled('Create account')).click();
  screens += 1;
  await expect(staff.getByRole('status')).toContainText(`Check ${email}`);
  await staff.goto(await authLinkFor(email, since));
  await expect(staff).toHaveURL(/\/onboarding$/);

  // The wizard announces its length; adding a step changes this number.
  const steps = staff.getByRole('list', { name: 'Setup progress' }).getByRole('listitem');
  await expect(steps).toHaveCount(3);
  const wizardSteps = await steps.count();

  // Business step.
  await staff.getByLabel('Business name').fill(`Speed Cafe ${Date.now()}`);
  await (await expectNextNotSilentlyDisabled('Next')).click();
  screens += 1;

  // Location step: only the name is typed; time zone and the rest keep their defaults.
  await staff.getByLabel('Location name').fill('Main Street');
  await (await expectNextNotSilentlyDisabled('Next')).click();
  screens += 1;

  // First queue step: the defaults are accepted as they come.
  await expect(staff.getByLabel('Queue name')).toHaveValue('Walk-ins');
  await (await expectNextNotSilentlyDisabled('Create my business')).click();
  screens += 1;

  // The line is live with a join link and QR.
  await expect(staff.getByText('Your line is live')).toBeVisible();
  const joinUrl = (await staff.getByTestId('join-url').textContent())!.trim();
  expect(joinUrl).toContain('/q/');
  await expect(staff.getByRole('img', { name: `QR code for ${joinUrl}` })).toBeVisible();

  // One click to the printable poster, which carries the same link.
  await staff.getByRole('link', { name: 'Print poster' }).click();
  await expect(staff).toHaveURL(/\/admin\/poster$/);
  const poster = staff.getByTestId('poster');
  await expect(poster).toContainText(joinUrl);
  await expect(poster.locator('svg')).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Print poster' })).toBeEnabled();

  const elapsed = Date.now() - started;
  // Steps are counted from the live wizard, not just the clicks above, so an added step fails
  // here even if the test is updated to click through it.
  expect(wizardSteps + 1, 'form screens before the line is live').toBe(EXPECTED_FORM_SCREENS);
  expect(screens).toBe(EXPECTED_FORM_SCREENS);
  expect(screens).toBeLessThanOrEqual(MAX_FORM_SCREENS);
  expect(elapsed, `sign-up to poster took ${elapsed} ms`).toBeLessThan(BUDGET_MS);
});
