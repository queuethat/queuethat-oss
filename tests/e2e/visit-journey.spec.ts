import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { AUTH_STORAGE_KEY } from '../../apps/web/src/lib/auth-storage.ts';
import { mailpitEmailChannel } from '../../packages/providers/src/email.ts';
import { demo } from '../fixtures/demo.ts';
import { eventually, expect, LIVE_TIMEOUT_MS, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { MAILPIT_URL } from './support/mail.ts';
import { newCode, pair, servePairDevice } from './support/pairing.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// One guest's visit across the features merged so far: the public join page (G2), the visit
// engine (V1 join, V2 call next, V3 undo, V5 ETA), guest status (V6), the paired TV's snapshot
// (D1/D3, V10), notification enqueueing (N2) and the accepting predicate (set_queue_state).
// The staff console, status page and TV board are still placeholders, so staff act through
// the RPCs those screens will call, and the guest and TV read theirs through the same API.

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);
/** G4's promise: the guest's page follows a staff action within 3 s over realtime. */
const LIVE_MS = 3_000;
const anon = createClient(env.url, env.anonKey, noSession).schema('api');

async function asStaff() {
  const client = createClient(env.url, env.anonKey, noSession);
  const { error } = await client.auth.signInWithPassword(testUsers.staff);
  if (error) throw error;
  return client.schema('api');
}

interface VisitStatus {
  display_ticket: string;
  status: string;
  position: number | null;
  eta_state: string;
  eta_low: number | null;
  counter_label: string | null;
  guest_actions: string[];
  version: number;
}

async function status(token: string) {
  const { data, error } = await anon.rpc('get_visit_status', { p_token: token });
  if (error) throw error;
  return data as VisitStatus;
}

interface DisplayTicket {
  display_ticket: string;
  counter_label: string | null;
}
interface Snapshot {
  queues: { id: string; now_serving: DisplayTicket[]; next_up: DisplayTicket[] }[];
}

/** What the TV sees, fetched from inside the paired TV's browser with its own device session. */
async function tvSnapshot(display: Page, queueId: string) {
  const snapshot = await display.evaluate(
    async ({ url, anonKey, storageKey, locationId }) => {
      const session = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      const response = await fetch(`${url}/rest/v1/rpc/display_snapshot`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${session?.access_token}`,
          'content-profile': 'api',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_location_id: locationId }),
      });
      if (!response.ok) throw new Error(`display_snapshot ${response.status}`);
      return response.json();
    },
    {
      url: env.url,
      anonKey: env.anonKey,
      storageKey: AUTH_STORAGE_KEY,
      locationId: demo.locationId,
    },
  );
  const queue = (snapshot as Snapshot).queues.find((q) => q.id === queueId);
  return {
    nowServing: (queue?.now_serving ?? []).map((t) => t.display_ticket),
    nextUp: (queue?.next_up ?? []).map((t) => t.display_ticket),
  };
}

async function joinByApi(queueId: string, name: string, email: string) {
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

async function callNext(queueId: string, counterId: string) {
  const staff = await asStaff();
  const { data, error } = await staff.rpc('call_next', {
    p_queue_id: queueId,
    p_counter_id: counterId,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return data as {
    id: string;
    display_ticket: string;
    status: string;
    last_event_id: number;
    version: number;
  };
}

async function notificationsFor(eventId: number) {
  const { data, error } = await service
    .schema('app')
    .from('notifications')
    .select('channel, template_key')
    .eq('event_id', eventId);
  if (error) throw error;
  return data;
}

interface OutboxJob {
  id: string;
  org_id: string;
  visit_id: string;
  subject: string;
  body: string;
  recipient: { kind: 'address'; value: string };
  has_consent: boolean;
  is_suppressed: boolean;
}

/**
 * Claims the outbox as the dispatch-notifications function does (N3) and sends the visit's
 * consented, unsuppressed email to Mailpit. CI runs Supabase without the edge runtime.
 */
async function dispatchEmailFor(visitId: string) {
  const { data, error } = await service
    .schema('api')
    .rpc('claim_outbox', { p_limit: 50, p_lease_seconds: 60 });
  if (error) throw error;
  const job = (data as OutboxJob[]).find((j) => j.visit_id === visitId);
  expect(job, 'a claimed email for the visit').toBeDefined();
  expect(job).toMatchObject({ has_consent: true, is_suppressed: false });
  const email = mailpitEmailChannel({ baseUrl: MAILPIT_URL, from: { email: 'queue@localhost' } });
  const result = await email.send({
    outboxId: job!.id,
    orgId: job!.org_id,
    channel: 'email',
    category: 'transactional',
    trigger: 'called',
    to: job!.recipient,
    subject: job!.subject,
    text: job!.body,
    policy: { hasConsent: job!.has_consent, isSuppressed: job!.is_suppressed, locationTz: 'UTC' },
  });
  expect(result.status).toBe('sent');
}

async function mailCount(to: string) {
  const query = encodeURIComponent(`to:"${to}"`);
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
  return ((await response.json()) as { messages: unknown[] }).messages.length;
}

async function joinFromPhone(guest: Page, queueId: string, name: string, phone: string) {
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queueId);
  await guest.getByLabel('First name').fill(name);
  await expect(guest.getByLabel('Country code')).toBeVisible();
  await guest.getByLabel('Mobile number (optional)').fill(phone);
  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest).toHaveURL(/\/v\/[\w-]+$/);
  return decodeURIComponent(new URL(guest.url()).pathname.split('/').pop()!);
}

test('a guest joins on a phone, is called, undone and called again while the TV follows', async ({
  devices,
}) => {
  const { guest, display } = devices;
  const queue = await freshQueue();
  const staff = await asStaff();

  // An earlier guest who gave an email joins first, so they are the one called.
  const robin = await joinByApi(queue.id, 'Robin', `robin-${randomUUID()}@example.test`);

  const token = await joinFromPhone(guest, queue.id, 'Dana', '+1 415 555 0142');
  const dana = await status(token);
  const position = guest.getByTestId('position');
  await expect(guest.getByTestId('ticket')).toHaveText(dana.display_ticket);
  await expect(position).toContainText('2');
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  expect(dana).toMatchObject({ status: 'waiting', position: 2 });
  expect(dana.display_ticket).not.toBe(robin.display_ticket);
  expect(dana.guest_actions).toContain('leave');
  expect(['ok', 'over_hour', 'unknown']).toContain(dana.eta_state);

  await servePairDevice(display);
  await display.goto('/display');
  await pair(display, await newCode('display', `Journey TV ${queue.name}`));
  await expect(display.getByRole('heading', { name: 'Now serving' })).toBeVisible();
  expect(await tvSnapshot(display, queue.id)).toEqual({
    nowServing: [],
    nextUp: [robin.display_ticket, dana.display_ticket],
  });

  // Staff call next: Robin goes to chair 1, Dana moves up, the TV and Robin's email follow.
  const call = await callNext(queue.id, demo.counters.chair1);
  expect(call).toMatchObject({ display_ticket: robin.display_ticket, status: 'called' });

  const robinCalled = await status(robin.token);
  expect(robinCalled).toMatchObject({ status: 'called', counter_label: 'Chair 1' });
  expect(await status(token)).toMatchObject({ status: 'waiting', position: 1 });
  await expect(position).toContainText('1', { timeout: LIVE_MS });
  await eventually(() => tvSnapshot(display, queue.id)).toEqual({
    nowServing: [robin.display_ticket],
    nextUp: [dana.display_ticket],
  });

  expect(await notificationsFor(call.last_event_id)).toEqual([
    { channel: 'email', template_key: 'called' },
  ]);

  // A mistaken call is undone: Robin is first in line again and leaves the TV.
  const { error: undoError } = await staff.rpc('undo_event', {
    p_event_id: call.last_event_id,
    p_idempotency_key: randomUUID(),
  });
  expect(undoError).toBeNull();
  expect(await status(robin.token)).toMatchObject({ status: 'waiting', position: 1 });
  expect(await status(token)).toMatchObject({ status: 'waiting', position: 2 });
  await expect(position).toContainText('2', { timeout: LIVE_MS });
  await eventually(() => tvSnapshot(display, queue.id)).toEqual({
    nowServing: [],
    nextUp: [robin.display_ticket, dana.display_ticket],
  });

  // Robin leaves from their phone; the next call reaches Dana.
  const { error: leaveError } = await anon.rpc('guest_act', {
    p_token: robin.token,
    p_action: 'leave',
    p_idempotency_key: randomUUID(),
  });
  expect(leaveError).toBeNull();
  await callNext(queue.id, demo.counters.chair2);
  expect(await status(token)).toMatchObject({ status: 'called', counter_label: 'Chair 2' });
  await expect(guest.getByText("It's your turn. Please go to Chair 2.")).toBeVisible({
    timeout: LIVE_MS,
  });
  await eventually(() => tvSnapshot(display, queue.id)).toEqual({
    nowServing: [dana.display_ticket],
    nextUp: [],
  });
});

test('a paused queue tells the next guest so and refuses a stale join', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const staff = await asStaff();

  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Sam');

  // Staff pause while the guest is still filling in the form.
  const { error } = await staff.rpc('set_queue_state', { p_queue_id: queue.id, p_state: 'paused' });
  expect(error).toBeNull();
  // The join page follows the queue live (#570), so it can learn of the pause before the click:
  // the button is then disabled and the page says so. Otherwise the click is refused by the
  // database (I-8). Either way the guest is told the same thing (#603), once, and nobody joins.
  const join = guest.getByRole('button', { name: 'Join the queue' });
  if (await join.isEnabled()) await join.click({ timeout: 2000 }).catch(() => undefined);
  await expect(
    guest.getByText('This queue is paused. Please check back in a few minutes.'),
  ).toBeVisible();
  await expect(guest.getByText('This queue stopped taking new guests.')).toHaveCount(0);

  await guest.reload();
  await guest.getByLabel('Queue').selectOption(queue.id);
  await expect(
    guest.getByText('This queue is paused. Please check back in a few minutes.'),
  ).toBeVisible();
});

// #603: the race itself, made certain. The page is held on the answer from before the pause, so
// the click reaches the database, which refuses it. The guest hears "paused" (what the page says
// when it learns of a pause live), not that the queue stopped for good.
test('a join refused because the queue was just paused says it is paused', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  const staff = await asStaff();

  let before: string | undefined;
  await guest.route('**/rest/v1/rpc/get_location_public', async (route) => {
    const response = await route.fetch();
    before ??= await response.text();
    await route.fulfill({ response, body: before });
  });
  await guest.goto(`/q/${demo.locationSlug}`);
  await guest.getByLabel('Queue').selectOption(queue.id);
  await guest.getByLabel('First name').fill('Sam');
  const { error } = await staff.rpc('set_queue_state', { p_queue_id: queue.id, p_state: 'paused' });
  expect(error).toBeNull();

  await guest.getByRole('button', { name: 'Join the queue' }).click();
  await expect(guest.getByRole('alert')).toHaveText(
    'This queue is paused. Please check back in a few minutes.',
  );
  await expect(guest.getByText('This queue stopped taking new guests.')).toHaveCount(0);
  await expect(guest).toHaveURL(new RegExp(`/q/${demo.locationSlug}$`));
});

// #454: a returning guest's email is stored on the new visit too, so it is notified again. The
// first visit is over by then: while it is live, only it is mailed (#479).
test('a returning guest who gives the same email is notified again', async () => {
  const email = `regular-${randomUUID()}@example.test`;
  const monday = await freshQueue();
  await joinByApi(monday.id, 'Kim', email);
  const first = await callNext(monday.id, demo.counters.chair1);
  expect(await notificationsFor(first.last_event_id)).toHaveLength(1);
  const staff = await asStaff();
  const { error } = await staff.rpc('transition_visit', {
    p_visit_id: first.id,
    p_action: 'no_show',
    p_expected_version: first.version,
    p_idempotency_key: randomUUID(),
  });
  expect(error).toBeNull();

  const tuesday = await freshQueue();
  await joinByApi(tuesday.id, 'Kim', email);
  const second = await callNext(tuesday.id, demo.counters.chair1);
  expect(await notificationsFor(second.last_event_id)).toHaveLength(1);
});

// #458: an online join keeps the email on the visit (no guest_contacts row); it is consent for
// this visit's service mail, so the call reaches Mailpit.
test('a called guest who joined with an email gets the email', async () => {
  const email = `called-${randomUUID()}@example.test`;
  const queue = await freshQueue();
  await joinByApi(queue.id, 'Lee', email);
  const call = await callNext(queue.id, demo.counters.chair1);
  await dispatchEmailFor(call.id);
  await eventually(() => mailCount(email)).toBe(1);
});

// Found in browser-test run 4: the estimate under "Estimated wait" was the raw i18n key (#484).
test('the status page words the estimated wait', async ({ devices }) => {
  const { guest } = devices;
  const queue = await freshQueue();
  await joinFromPhone(guest, queue.id, 'Eta', '+1 415 555 0163');
  const eta = guest.getByTestId('eta');
  await expect(eta).toBeVisible();
  await expect(eta).not.toContainText(/\beta\.\w+/);
});

async function visitRow(visitId: string) {
  const { data, error } = await service
    .schema('app')
    .from('visits')
    .select('version')
    .eq('id', visitId)
    .single();
  if (error) throw error;
  return data as { version: number };
}

async function transition(visitId: string, action: string, version: number) {
  const staff = await asStaff();
  const { data, error } = await staff.rpc('transition_visit', {
    p_visit_id: visitId,
    p_action: action,
    p_expected_version: version,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return data as { id: string; version: number; last_event_id: number };
}

// Run 5: the staff console (C1/C2), the guest's status page (G4) and the live layer (L1) follow
// the same visit through call, recall, no-show and undo. Staff act through the RPCs the
// console's buttons will call.
test('the console and the guest follow a call, a recall, a no-show and its undo', async ({
  devices,
}) => {
  const { guest, staff } = devices;
  const queue = await freshQueue();
  await staff.goto(`/staff?queue=${queue.id}`);
  const waiting = staff.getByTestId('section-waiting');
  const called = staff.getByTestId('section-called');
  await expect(waiting).toBeVisible();
  await expect(staff.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  const token = await joinFromPhone(guest, queue.id, 'Noor', '+1 415 555 0188');
  await expect(waiting.getByText('Noor')).toBeVisible({ timeout: LIVE_MS });
  await expect(guest.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

  const call = await callNext(queue.id, demo.counters.chair1);
  expect(call.id).toBeDefined();
  const message = guest.getByText("It's your turn. Please go to Chair 1.");
  await expect(message).toBeVisible({ timeout: LIVE_MS });
  await expect(called.getByText('Noor')).toBeVisible({ timeout: LIVE_MS });
  await expect(waiting.getByText('Noor')).toHaveCount(0);

  const recalled = await transition(call.id, 'recall', (await visitRow(call.id)).version);
  expect((await status(token)).status).toBe('called');
  await expect(message).toBeVisible();

  const missed = await transition(call.id, 'no_show', recalled.version);
  await expect(
    guest.getByText("We called you but couldn't find you. Ask staff if you're still here."),
  ).toBeVisible({ timeout: LIVE_MS });
  await expect(called.getByText('Noor')).toHaveCount(0, { timeout: LIVE_MS });

  const { error } = await (
    await asStaff()
  ).rpc('undo_event', {
    p_event_id: missed.last_event_id,
    p_idempotency_key: randomUUID(),
  });
  expect(error).toBeNull();
  await expect(message).toBeVisible({ timeout: LIVE_MS });
  await expect(called.getByText('Noor')).toBeVisible({ timeout: LIVE_MS });
});
