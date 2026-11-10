import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../fixtures/demo.ts';
import {
  expect,
  expectNoSeriousA11yViolations,
  LIVE_TIMEOUT_MS,
  signIn,
  test,
} from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { freshQueue } from './support/queues.ts';

// C1 (#58): the staff console shell on the tablets staff actually use (iPad, Galaxy Tab).

test('AC1: every control is at least 48px and nothing overflows the tablet', async ({
  devices,
}, testInfo) => {
  const { staff } = devices;
  await staff.goto('/staff');
  await expect(staff.getByRole('tab', { name: 'Walk-ins' })).toBeVisible();
  await expect(staff.getByRole('tab', { name: 'Kids' })).toBeVisible();
  // The private location channel authorized with the staff session.
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  const controls = staff.locator('main').locator('button, select, [role="tab"]');
  expect(await controls.count()).toBeGreaterThan(2);
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(
      box?.height,
      await control.evaluate((el) => el.outerHTML.slice(0, 80)),
    ).toBeGreaterThanOrEqual(48);
  }
  const overflow = await staff.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await testInfo.attach(`console-${testInfo.project.name}.png`, {
    body: await staff.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await expectNoSeriousA11yViolations(staff);
});

test('my counter is remembered by this tablet', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  const counter = staff.getByLabel('My counter');
  await expect(
    staff.getByText('Pick where you serve from. This tablet remembers it.'),
  ).toBeVisible();
  await counter.selectOption(demo.counters.chair2);
  await staff.reload();
  await expect(staff.getByLabel('My counter')).toHaveValue(demo.counters.chair2);
  await expect(staff.getByText('Pick where you serve from.')).toHaveCount(0);
});

test('the chosen queue tab survives a reload', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  await staff.getByRole('tab', { name: 'Kids' }).click();
  await expect(staff).toHaveURL(new RegExp(`queue=${demo.queues.kids}`));
  await staff.reload();
  await expect(staff.getByRole('tab', { name: 'Kids' })).toHaveAttribute('aria-selected', 'true');
  await expect(staff.getByRole('tabpanel', { name: /^Kids/ })).toBeVisible();
});

/** A guest joins a queue (the kids queue by default) from their phone, by the public RPC as /q does. */
async function guestJoins(name: string, queueId: string = demo.queues.kids) {
  const { url, anonKey } = supabaseEnv();
  const response = await fetch(`${url}/rest/v1/rpc/join_queue`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      'content-profile': 'api',
    },
    body: JSON.stringify({
      p_queue_id: queueId,
      p_service_id: null,
      p_name: name,
      p_phone_e164: null,
      p_email: null,
      p_party_size: 1,
      p_locale: 'en',
      p_idempotency_key: randomUUID(),
      // Its own phone: every e2e request shares one IP, so the per-phone join cap (#441) would trip.
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

test('C2 AC1: a guest who joins shows on two staff tablets within 3 s', async ({
  devices,
  browser,
}) => {
  const first = devices.staff;
  const context = await browser.newContext({ viewport: first.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');

  for (const page of [first, second]) {
    await page.goto(`/staff?queue=${demo.queues.kids}`);
    await expect(page.getByTestId('section-waiting')).toBeVisible();
    // Subscribed before the join, so the row can only arrive by the live signal.
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  }

  const name = `Guest ${randomUUID().slice(0, 6)}`;
  await guestJoins(name);
  for (const page of [first, second]) {
    await expect(page.getByTestId('section-waiting').getByText(name)).toBeVisible({
      timeout: 3_000,
    });
  }
  await expectNoSeriousA11yViolations(first);
  await context.close();
});

test('C8 AC1: the sound banner stays until tapped, then sound shows as on', async ({ devices }) => {
  const { staff } = devices;
  await staff.goto('/staff');
  const banner = staff.getByRole('region', { name: 'Sound alerts' });
  await expect(banner).toContainText('Sound is off');
  await staff.getByRole('tab', { name: 'Kids' }).click();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Turn on sound' }).click();
  await expect(banner).toHaveCount(0);
  await expect(staff.getByRole('status').filter({ hasText: 'Sound on' })).toBeVisible();
  await expect(staff.getByRole('button', { name: 'Test sound' })).toBeVisible();
  await expectNoSeriousA11yViolations(staff);
});

/** A staff tablet showing `queueId`, subscribed so changes can arrive live. */
async function openQueue(page: Page, queueId: string) {
  await page.goto(`/staff?queue=${queueId}`);
  await expect(page.getByTestId('section-waiting')).toBeVisible();
  await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
}

test('C3 AC1: two tablets that tap Call next together call two different guests', async ({
  devices,
  browser,
}) => {
  const queue = await freshQueue();
  await guestJoins('First guest', queue.id);
  await guestJoins('Second guest', queue.id);
  const first = devices.staff;
  const context = await browser.newContext({ viewport: first.viewportSize() });
  const second = await context.newPage();
  await signIn(second, 'staff');
  for (const page of [first, second]) {
    await openQueue(page, queue.id);
    await expect(page.getByTestId('section-waiting').getByTestId('visit')).toHaveCount(2);
  }

  await Promise.all(
    [first, second].map((page) => page.getByRole('button', { name: 'Call next' }).click()),
  );

  const called: string[] = [];
  for (const page of [first, second]) {
    const toast = page.getByRole('region', { name: 'Notifications' }).getByText(/^Called /);
    await expect(toast).toBeVisible();
    called.push((await toast.textContent()) ?? '');
    // Both tablets see both calls, and nobody left waiting.
    await expect(page.getByTestId('section-called').getByTestId('visit')).toHaveCount(2, {
      timeout: 3_000,
    });
    await expect(page.getByRole('button', { name: 'Call next' })).toBeDisabled();
  }
  expect(new Set(called).size).toBe(2);
  await context.close();
});

test('C3: calling a specific guest sends them to my counter', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Pick me', queue.id);
  await openQueue(staff, queue.id);
  await staff.getByLabel('My counter').selectOption(demo.counters.chair2);
  const row = staff
    .getByTestId('section-waiting')
    .getByTestId('visit')
    .filter({ hasText: 'Pick me' });
  const ticket = (await row.locator('span').first().textContent()) ?? '';
  await row.getByRole('button', { name: `Call ${ticket}` }).click();

  await expect(
    staff.getByRole('region', { name: 'Notifications' }).getByText(`Called ${ticket} to Chair 2.`),
  ).toBeVisible();
  await expect(
    staff.getByTestId('section-called').getByTestId('visit').filter({ hasText: 'Chair 2' }),
  ).toContainText('Pick me');
  await expectNoSeriousA11yViolations(staff);
});

/** A visit's status and the reason on its latest event, read with the service role. */
async function visitState(queueId: string, name: string) {
  const { url, serviceRoleKey } = supabaseEnv();
  const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { data: visit } = await service
    .schema('app')
    .from('visits')
    .select('id, status')
    .eq('queue_id', queueId)
    .eq('guest_name', name)
    .single();
  const { data: event } = await service
    .schema('app')
    .from('visit_events')
    .select('reason')
    .eq('visit_id', visit!.id)
    .order('id', { ascending: false })
    .limit(1)
    .single();
  return { status: visit!.status, reason: event?.reason ?? null };
}

test('C4 AC1: a single tap on Remove does nothing until a reason and confirm', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Remove me', queue.id);
  await openQueue(staff, queue.id);
  const row = staff.getByTestId('visit').filter({ hasText: 'Remove me' });
  const ticket = (await row.locator('span').first().textContent()) ?? '';

  await row.getByRole('button', { name: `Remove ${ticket}` }).click();
  const dialog = staff.getByRole('dialog', { name: `Remove ${ticket} from the line?` });
  const confirm = dialog.getByRole('button', { name: 'Remove', exact: true });
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true });
  expect(await visitState(queue.id, 'Remove me')).toEqual({ status: 'waiting', reason: null });

  await dialog.getByLabel('Reason').fill('Duplicate ticket');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.getByTestId('visit').filter({ hasText: 'Remove me' })).toHaveCount(0);
  expect(await visitState(queue.id, 'Remove me')).toEqual({
    status: 'removed',
    reason: 'Duplicate ticket',
  });
});

test('C4: a guest moves from called to serving to done, and a no-show can be reinstated', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Full visit', queue.id);
  await guestJoins('Late one', queue.id);
  await openQueue(staff, queue.id);
  const section = (state: string) => staff.getByTestId(`section-${state}`);
  const ticketOf = async (name: string) =>
    (await staff
      .getByTestId('visit')
      .filter({ hasText: name })
      .locator('span')
      .first()
      .textContent()) ?? '';
  const full = await ticketOf('Full visit');
  const late = await ticketOf('Late one');

  await staff.getByRole('button', { name: `Call ${full}` }).click();
  await staff.getByRole('button', { name: `Start ${full}` }).click();
  await expect(section('serving')).toContainText('Full visit');
  await staff.getByRole('button', { name: `Done with ${full}` }).click();
  await expect(staff.getByTestId('visit').filter({ hasText: 'Full visit' })).toHaveCount(0);

  await staff.getByRole('button', { name: `No-show ${late}` }).click();
  await staff
    .getByRole('dialog', { name: `Mark ${late} as a no-show?` })
    .getByRole('button', { name: 'Mark no-show' })
    .click();
  await expect(section('no_show')).toContainText('Late one');
  await staff.getByRole('button', { name: `Reinstate ${late}` }).click();
  await expect(section('waiting')).toContainText('Late one');
  await expectNoSeriousA11yViolations(staff);
});

test('C6: staff add a walk-in in a few taps', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  // Party size is off by default (#104): the queue stores 1 unless it is switched on.
  const { url, serviceRoleKey } = supabaseEnv();
  const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ party_size_enabled: true, party_size_max: 10 })
    .eq('id', queue.id);
  expect(error).toBeNull();
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Walk-in Wes');
  await dialog.getByLabel('Party size').fill('2');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(
    staff
      .getByRole('region', { name: 'Notifications' })
      .getByText(/^Added [A-Z]{3}\d{3} to the line\.$/),
  ).toBeVisible();
  await expect(staff.getByTestId('section-waiting')).toContainText('Walk-in Wes · party of 2');
});

test('C6 AC1: adding a guest to a closed queue explains that it is closed', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  const { url, serviceRoleKey } = supabaseEnv();
  const service = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { error } = await service
    .schema('app')
    .from('queues')
    .update({ manual_state: 'closed' })
    .eq('id', queue.id);
  expect(error).toBeNull();

  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Too late');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'This queue is closed. Open it before adding guests.',
  );
  await expectNoSeriousA11yViolations(staff);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(staff.getByTestId('visit').filter({ hasText: 'Too late' })).toHaveCount(0);
});

test('C5 AC1: a guest marked no-show by mistake gets their place back with Undo', async ({
  devices,
}) => {
  const { staff } = devices;
  const queue = await freshQueue();
  for (const name of ['Ann first', 'Ben second', 'Cat third']) await guestJoins(name, queue.id);
  await openQueue(staff, queue.id);
  const waiting = staff.getByTestId('section-waiting').getByTestId('visit');
  await expect(waiting).toHaveCount(3);
  const ben = (await waiting.nth(1).locator('span').first().textContent()) ?? '';

  await staff.getByRole('button', { name: `No-show ${ben}` }).click();
  await staff.getByRole('button', { name: 'Mark no-show' }).click();
  const toasts = staff.getByRole('region', { name: 'Notifications' });
  await expect(toasts.getByText(`Marked ${ben} as a no-show.`)).toBeVisible();
  await expect(waiting).toHaveCount(2);

  await toasts.getByRole('button', { name: 'Undo' }).click();
  await expect(toasts.getByText(`Undone: ${ben} is back where they were.`)).toBeVisible();
  await expect(waiting).toHaveText([/Ann first/, /Ben second/, /Cat third/]);
});

test('C5: a called guest can be called again, and a call can be undone', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await guestJoins('Dee', queue.id);
  await openQueue(staff, queue.id);
  const ticket =
    (await staff
      .getByTestId('visit')
      .filter({ hasText: 'Dee' })
      .locator('span')
      .first()
      .textContent()) ?? '';
  const toasts = staff.getByRole('region', { name: 'Notifications' });

  await staff.getByRole('button', { name: `Call ${ticket}` }).click();
  await expect(staff.getByTestId('section-called')).toContainText('Dee');
  await staff.getByRole('button', { name: `Call again ${ticket}` }).click();
  await expect(toasts.getByText(`Called ${ticket} again.`)).toBeVisible();

  // Undo reverses the latest action only: the recall, so Dee stays called.
  await toasts.getByRole('button', { name: 'Undo' }).last().click();
  await expect(toasts.getByText(`Undone: ${ticket} is back where they were.`)).toBeVisible();
  await expect(staff.getByTestId('section-called')).toContainText('Dee');
  await expectNoSeriousA11yViolations(staff);
});

test('#549: Add guest refuses a phone number that is not a full number', async ({ devices }) => {
  const { staff } = devices;
  const queue = await freshQueue();
  await openQueue(staff, queue.id);
  await staff.getByRole('button', { name: 'Add guest' }).click();
  const dialog = staff.getByRole('dialog', { name: `Add a guest to ${queue.name}` });
  await dialog.getByLabel('Name (optional)').fill('Walky');
  const phone = dialog.getByLabel('Mobile number (optional)');
  await phone.fill('123');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();

  await expect(
    dialog.getByText("That isn't a full mobile number.", { exact: false }),
  ).toBeVisible();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await expect(staff.getByTestId('visit').filter({ hasText: 'Walky' })).toHaveCount(0);

  await phone.fill('');
  await dialog.getByRole('button', { name: 'Add to the line' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.getByTestId('section-waiting')).toContainText('Walky');
});
