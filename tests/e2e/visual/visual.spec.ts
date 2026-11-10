import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { demo } from '../../fixtures/demo.ts';
import { signIn } from '../support/auth.ts';
import { bookAsGuest, bookableLocation, firstSlot } from '../support/booking.ts';
import { guestJoins } from '../support/console.ts';
import { supabaseEnv } from '../support/env.ts';
import { newCode, servePairDevice } from '../support/pairing.ts';
import { testUsers } from '../support/users.ts';

// DS-5 (#1009): one screenshot per theme and viewport for the component catalogue, then the four
// screens people see most (join, status, console, display) against the seeded demo org. A token
// change that moves a pixel shows up here as a diff. Update with `pnpm test:visual:update`.

const THEMES = ['light', 'dark', 'high-contrast'] as const;
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;

type Theme = (typeof THEMES)[number];

/** Pins the theme the way the app's own switch does and waits until fonts and layout are settled. */
async function settle(page: Page, theme: Theme) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.evaluate(async () => {
    await document.fonts.load('16px Geist');
    await document.fonts.load('600 16px "Geist Mono"');
    await document.fonts.ready;
  });
  await page.waitForLoadState('networkidle');
}

for (const theme of THEMES) {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`catalogue, ${theme}, ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/dev/ui');
      await expect(page.getByRole('heading', { name: 'UI catalogue' })).toBeVisible();
      await settle(page, theme);
      await expect(page).toHaveScreenshot(`catalogue-${theme}-${name}.png`, { fullPage: true });
    });
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`join page, ${theme}, phone`, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.phone);
    await page.goto(`/q/${demo.locationSlug}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await settle(page, theme);
    await expect(page).toHaveScreenshot(`join-${theme}-phone.png`, { fullPage: true });
  });
}

// DS-23 (#1027): the token pages share the join and status pieces. The unsubscribe page needs no
// data; the appointment page names a business and a time that differ per run, so its text is masked
// and the shot checks layout, spacing and the status pill.
for (const theme of ['light', 'dark'] as const) {
  test(`unsubscribe page, ${theme}, phone`, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.phone);
    await page.goto('/u?n=visual&t=visual');
    await expect(page.getByRole('heading', { name: 'Stop these emails' })).toBeVisible();
    await settle(page, theme);
    await expect(page).toHaveScreenshot(`unsubscribe-${theme}-phone.png`, { fullPage: true });
  });
}

test('appointment page, light, phone', async ({ page }) => {
  const tz = 'Europe/Berlin';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
    new Date(Date.now() + 2 * 86_400_000),
  );
  const { slug, serviceId } = await bookableLocation(tz);
  const slot = await firstSlot(slug, serviceId, day, day);
  const { token } = await bookAsGuest(slug, serviceId, slot, 'Dana');
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto(`/a/${token}`);
  await expect(page.getByText('Booked', { exact: true })).toBeVisible();
  await settle(page, 'light');
  await expect(page).toHaveScreenshot('appointment-light-phone.png', {
    fullPage: true,
    mask: [
      page.getByTestId('appointment').locator('p'),
      page.locator('footer, [data-testid="branded"]'),
    ],
  });
});

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

async function staffApi() {
  const staff = createClient(env.url, env.anonKey, noSession);
  const { error } = await staff.auth.signInWithPassword(testUsers.staff);
  if (error) throw error;
  return staff.schema('api');
}

/** The demo queue gets the same three guests every run, one of them called. */
async function seedQueue() {
  const guests: { token: string }[] = [];
  for (const name of ['Amara Okafor', 'Sam Reyes', 'Priya Nair']) {
    guests.push(await guestJoins(name, demo.queues.kids));
  }
  const api = await staffApi();
  const { error } = await api.rpc('call_next', {
    p_queue_id: demo.queues.kids,
    p_counter_id: demo.counters.chair1,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return guests;
}

test.describe.serial('screens with a live queue', () => {
  let guests: { token: string }[] = [];
  test.beforeAll(async () => {
    guests = await seedQueue();
  });

  for (const [index, label] of [
    [0, 'called'],
    [2, 'waiting'],
  ] as const) {
    test(`status page, ${label}, phone`, async ({ page }) => {
      await page.setViewportSize(VIEWPORTS.phone);
      await page.goto(`/v/${guests[index]!.token}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await settle(page, 'light');
      await expect(page).toHaveScreenshot(`status-${label}-phone.png`, {
        fullPage: true,
        mask: [page.getByText(/Please arrive by/), page.getByText(/as of/i)],
      });
    });
  }

  test('staff console, tablet', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.tablet);
    await signIn(page, 'staff');
    await page.goto(`/staff?queue=${demo.queues.kids}`);
    await expect(page.getByTestId('section-waiting')).toBeVisible();
    await settle(page, 'light');
    await expect(page).toHaveScreenshot('console-light-tablet.png', { fullPage: true });
  });

  for (const [name, size] of [
    ['720p', { width: 1280, height: 720 }],
    ['tv', { width: 1920, height: 1080 }],
  ] as const) {
    test(`waiting-room display, ${name}`, async ({ page }) => {
      await page.setViewportSize(size);
      await servePairDevice(page);
      await page.goto('/display');
      await page.getByLabel('Pairing code').fill(await newCode('display'));
      await page.getByRole('button', { name: 'Pair' }).click();
      await expect(page.getByRole('heading', { name: 'Now serving' })).toBeVisible();
      await settle(page, 'light');
      await expect(page).toHaveScreenshot(`display-light-${name}.png`, {
        mask: [page.getByText(/^Updated /)],
      });
    });
  }
});
