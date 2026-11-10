import type { Browser, Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { expect, LIVE_TIMEOUT_MS, signIn, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { openShop, type Shop } from './support/shop.ts';
import type { TestUserRole } from './support/users.ts';

// O8 (#79): one day in the shop, serially, on every screen at once. Two staff tablets (staff at
// Chair 1, the owner at Chair 2), the waiting-area TV and the guests' phones follow each step:
// joins from the poster page and the desk, two tablets calling next together, a guest served,
// a mistaken no-show undone, a guest leaving, the queue closing under an open join page and,
// last, the end of the day for the guests nobody finished: the service day rolls over.
//
// `pnpm test:e2e:pilot` runs the same journey against a deployed app. support/shop.ts holds the differences: no service role or database there, so the
// outbox check is skipped and the day ends with staff removing the leftovers plus a look at the
// health check's rollover heartbeat.

const env = supabaseEnv();
const anon = createClient(env.url, env.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).schema('api');
/** G4's promise: every screen follows a change within 3 s over realtime. */
const LIVE_MS = 3_000;

async function joinByApi(queueId: string, name: string, email: string | null = null) {
  const { data, error } = await anon.rpc('join_queue', {
    p_queue_id: queueId,
    p_service_id: null,
    p_name: name,
    p_phone_e164: null,
    p_email: email,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return data as { token: string; display_ticket: string };
}

async function visitStatus(token: string) {
  const { data, error } = await anon.rpc('get_visit_status', { p_token: token });
  if (error) throw error;
  return (data as { status: string }).status;
}

/** A staff tablet on the queue, serving from `counterId`, live. */
async function openTablet(page: Page, queueId: string, counterId: string) {
  await page.goto(`/staff?queue=${queueId}`);
  await page.getByLabel('My counter').selectOption(counterId);
  await expect(page.getByTestId('section-waiting')).toBeVisible();
  await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
}

async function secondTablet(browser: Browser, like: Page, role: TestUserRole) {
  const context = await browser.newContext({ viewport: like.viewportSize() });
  const page = await context.newPage();
  await signIn(page, role);
  return page;
}

let opened: Shop | undefined;
// The pilot is not thrown away after a run: archive the check's queue and revoke its TV.
test.afterEach(async () => {
  await opened?.cleanup();
});

test('a day in the shop on two tablets, the TV and the guests’ phones @core', async ({
  devices,
  browser,
}) => {
  test.setTimeout(180_000);
  const { guest, display } = devices;
  const shop = (opened = await openShop());
  const queue = await shop.newQueue();
  const chair1 = devices.staff;
  const chair2 = await secondTablet(browser, chair1, 'owner');
  const tablets = [chair1, chair2];
  const section = (page: Page, state: string) => page.getByTestId(`section-${state}`);
  const row = (page: Page, name: string) => page.getByTestId('visit').filter({ hasText: name });
  const board = display.getByRole('region', { name: queue.name });
  let ava = '';
  let ben: { token: string; display_ticket: string };
  let cam: { token: string; display_ticket: string };

  await test.step('the shop opens: both tablets and the TV are live', async () => {
    await openTablet(chair1, queue.id, shop.counters[0].id);
    await openTablet(chair2, queue.id, shop.counters[1].id);
    await shop.pairTv(display, `Day TV ${queue.name}`);
    await expect(board).toBeVisible();
  });

  await test.step('guests join from the poster page, by link and at the desk', async () => {
    await guest.goto(`/q/${shop.slug}`);
    await guest.getByLabel('Queue').selectOption(queue.id);
    await guest.getByLabel('First name').fill('Ava');
    await guest.getByRole('button', { name: 'Join the queue' }).click();
    await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
    ava = (await guest.getByTestId('ticket').textContent()) ?? '';
    ben = await joinByApi(queue.id, 'Ben', `ben-${randomUUID()}@example.test`);
    cam = await joinByApi(queue.id, 'Cam');

    await chair2.getByRole('button', { name: 'Add guest' }).click();
    const dialog = chair2.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
    await dialog.getByLabel('Name (optional)').fill('Walk-in Wes');
    await dialog.getByRole('button', { name: 'Add to the line' }).click();
    await expect(dialog).toHaveCount(0);

    for (const page of tablets) {
      await expect(section(page, 'waiting').getByTestId('visit')).toHaveCount(4, {
        timeout: LIVE_MS,
      });
    }
    await expect(guest.getByText("You're number 1 in line")).toBeVisible();
    await expect(board.getByTestId('next-up')).toContainText(ava, { timeout: LIVE_MS });
  });

  await test.step('both tablets tap Call next together and call Ava and Ben', async () => {
    await Promise.all(
      tablets.map((page) => page.getByRole('button', { name: 'Call next' }).click()),
    );
    for (const page of tablets) {
      await expect(section(page, 'called').getByTestId('visit')).toHaveCount(2, {
        timeout: LIVE_MS,
      });
      await expect(section(page, 'called')).toContainText('Ava');
      await expect(section(page, 'called')).toContainText('Ben');
    }
    await expect(guest.getByText(/^It's your turn\. Please go to .+\.$/)).toBeVisible({
      timeout: LIVE_MS,
    });
    await guest.getByRole('button', { name: 'Got it' }).click();
    for (const ticket of [ava, ben.display_ticket]) {
      await expect(board.getByTestId('now-serving')).toContainText(ticket, { timeout: LIVE_MS });
    }
    expect(await visitStatus(ben.token)).toBe('called');
    // Ben joined with an email: his call queues one (Mailpit delivery: visit-journey.spec.ts).
    await shop.expectEmailQueued?.(queue.id, 'Ben');
  });

  await test.step('Ava is served and leaves the TV', async () => {
    await chair1.getByRole('button', { name: `Start ${ava}` }).click();
    await expect(guest.getByText("You're being served.")).toBeVisible({ timeout: LIVE_MS });
    await expect(section(chair2, 'serving')).toContainText('Ava', { timeout: LIVE_MS });
    await chair1.getByRole('button', { name: `Done with ${ava}` }).click();
    await expect(guest.getByText(`Thanks for visiting ${shop.locationName}.`)).toBeVisible({
      timeout: LIVE_MS,
    });
    await expect(row(chair2, 'Ava')).toHaveCount(0, { timeout: LIVE_MS });
    await expect(board.getByTestId('now-serving')).not.toContainText(ava, { timeout: LIVE_MS });
  });

  await test.step('a mistaken no-show for Ben is undone from the toast', async () => {
    await chair2.getByRole('button', { name: `No-show ${ben.display_ticket}` }).click();
    await chair2.getByRole('button', { name: 'Mark no-show' }).click();
    await expect(section(chair1, 'called')).not.toContainText('Ben', { timeout: LIVE_MS });
    // The newest toast is the no-show's; the call's may still be up. Wait until it is there, or
    // a slow answer would leave only the call's Undo to click.
    const toasts = chair2.getByRole('region', { name: 'Notifications' });
    await expect(toasts.getByText(`Marked ${ben.display_ticket} as a no-show.`)).toBeVisible();
    await toasts.getByRole('button', { name: 'Undo' }).last().click();
    await expect(section(chair1, 'called')).toContainText('Ben', { timeout: LIVE_MS });
    expect(await visitStatus(ben.token)).toBe('called');
  });

  await test.step('Cam leaves from the phone', async () => {
    await guest.goto(`/v/${cam.token}`);
    await guest.getByRole('button', { name: 'Leave the line' }).click();
    await guest.getByRole('button', { name: 'Yes, leave' }).click();
    await expect(guest.getByText('You left the line.')).toBeVisible();
    for (const page of tablets) await expect(row(page, 'Cam')).toHaveCount(0, { timeout: LIVE_MS });
    await expect(board.getByTestId('next-up')).not.toContainText(cam.display_ticket, {
      timeout: LIVE_MS,
    });
  });

  await test.step('closing the queue stops joins on a join page that is already open', async () => {
    await guest.goto(`/q/${shop.slug}`);
    await guest.getByLabel('Queue').selectOption(queue.id);
    await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeEnabled();
    await chair1.getByTestId('queue-controls').getByRole('button', { name: 'Close queue' }).click();
    await chair1.getByRole('button', { name: 'Yes, close' }).click();
    await expect(guest.getByText('This queue is closed right now.')).toBeVisible({
      timeout: LIVE_MS,
    });
    await expect(guest.getByRole('button', { name: 'Join the queue' })).toBeDisabled();
    // Guests already in line keep their place.
    await expect(section(chair2, 'waiting')).toContainText('Walk-in Wes');
  });

  await test.step('the day ends for the guests nobody finished', async () => {
    const ended = await shop.endDay(queue.id);
    expect(await visitStatus(ben.token)).toBe(ended.status);
    for (const page of tablets) {
      await expect(page.getByTestId('visit')).toHaveCount(0, { timeout: LIVE_MS });
    }
    await expect(board.getByTestId('now-serving')).not.toContainText(ben.display_ticket, {
      timeout: LIVE_MS,
    });
    await guest.goto(`/v/${ben.token}`);
    await expect(guest.getByText(ended.message)).toBeVisible();
  });

  await chair2.context().close();
});
