import type { Page } from '@playwright/test';
import { demo } from '../fixtures/demo.ts';
import { expect, expectNoSeriousA11yViolations, signIn, test } from './fixtures.ts';
import { confirmedAccount, signInTo } from './support/accounts.ts';

// One sweep over every screen (docs/architecture I-9, I-13): no serious axe finding, every control at
// least 48px, nothing wider than the screen, and no untranslated key showing. Runs at each
// project's size (phone, tablet, desktop) and with an English and a German browser, since
// formatting and defaults (phone country, dates) follow the browser's locale.

/** Controls staff and guests tap. Checkboxes and radios get their 48px from the label row. */
const TARGETS =
  'a, button, select, [role="tab"], input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])';

/** A t() key that rendered as itself, e.g. "join.phone" (an unloaded namespace or a typo). */
const RAW_KEY =
  /\b(?:common|guest|staff|admin|auth|display|kiosk|onboarding|eta|console|join|status|location|queues|counters|devices|poster|support|toast)\.[a-zA-Z_]+/;

async function expectCompliant(page: Page, { wide = false } = {}) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main')).toBeVisible();
  // Judge the screen people end up on, not its loading state.
  await expect(page.locator('[role="status"] .motion-safe\\:animate-spin')).toHaveCount(0, {
    timeout: 3_000,
  });
  await expectNoSeriousA11yViolations(page);

  const small = await page.locator(TARGETS).evaluateAll((elements) =>
    elements
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => ({ html: el.outerHTML.slice(0, 90), height: el.getBoundingClientRect().height }))
      .filter((target) => target.height < 48),
  );
  expect(small, `controls under 48px on ${page.url()}`).toEqual([]);

  if (!wide) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(0);
  }
  expect(await page.locator('body').innerText()).not.toMatch(RAW_KEY);
}

const guestPaths = [
  '/',
  `/q/${demo.locationSlug}`,
  '/v/not-a-real-token',
  '/u',
  '/auth/sign-in',
  '/auth/sign-up',
  '/kiosk',
  '/no-such-page',
];

const ownerPaths = [
  '/staff',
  '/admin',
  '/admin/queues',
  `/admin/queues/${demo.queues.walkIns}`,
  '/admin/counters',
  '/admin/devices',
  '/admin/location',
  '/admin/poster',
  '/admin/help',
];

// German is a guest language, so a de-DE browser gets German guest pages (labels differ).
const LOCALES = [
  { locale: 'en-US', join: { name: 'First name', submit: 'Join the queue' } },
  { locale: 'de-DE', join: { name: 'Vorname', submit: 'Der Warteschlange beitreten' } },
];

for (const { locale, join } of LOCALES) {
  test.describe(`${locale}`, () => {
    test.use({ locale });

    for (const path of guestPaths) {
      test(`${path} meets the screen rules`, async ({ page }) => {
        await page.goto(path);
        await expectCompliant(page);
      });
    }

    // The TV board is built for a 1080p screen; on a phone it may scroll sideways.
    test('/display meets the screen rules', async ({ page }) => {
      await page.goto('/display');
      await expectCompliant(page, { wide: true });
    });

    test('a guest status page meets the screen rules', async ({ page }) => {
      await page.goto(`/q/${demo.locationSlug}`);
      await page.getByLabel(join.name).fill('Sweep');
      await page.getByRole('button', { name: join.submit }).click();
      await expect(page).toHaveURL(/\/v\/[\w-]+$/);
      await expectCompliant(page);
    });

    for (const path of ownerPaths) {
      test(`${path} signed in meets the screen rules`, async ({ page }) => {
        await signIn(page, 'owner');
        await page.goto(path);
        await expectCompliant(page);
      });
    }

    test('/onboarding meets the screen rules', async ({ page }) => {
      await signInTo(page, await confirmedAccount(), '/onboarding');
      await expectCompliant(page);
    });
  });
}
