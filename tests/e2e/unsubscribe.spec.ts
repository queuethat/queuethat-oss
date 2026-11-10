import type { Page, Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { mailpitEmailChannel } from '../../packages/providers/src/email.ts';
import { createRegistry } from '../../packages/providers/src/channel.ts';
import {
  dispatch,
  type OutboxJob,
} from '../../supabase/functions/dispatch-notifications/handler.ts';
import { supabaseDeps } from '../../supabase/functions/unsubscribe/deps.ts';
import { createUnsubscribeHandler } from '../../supabase/functions/unsubscribe/handler.ts';
import { demo } from '../fixtures/demo.ts';
import { eventually, expect, expectNoSeriousA11yViolations, test } from './fixtures.ts';
import { supabaseEnv } from './support/env.ts';
import { MAILPIT_URL, uniqueEmail } from './support/mail.ts';
import { freshQueue } from './support/queues.ts';
import { testUsers } from './support/users.ts';

// #479 follow-up: the real dispatcher and unsubscribe handlers run here in Node (no edge runtime in CI).

const env = supabaseEnv();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(env.url, env.serviceRoleKey, noSession);
const anon = createClient(env.url, env.anonKey, noSession).schema('api');
const SECRET = `e2e-unsubscribe-${randomUUID()}`;
const unsubscribe = createUnsubscribeHandler({
  ...supabaseDeps(createClient, env),
  secret: SECRET,
});

async function serveUnsubscribe(page: Page) {
  await page.route('**/functions/v1/unsubscribe*', async (route: Route) => {
    const request = route.request();
    const response = await unsubscribe(
      new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        body: request.method() === 'POST' ? request.postData() : undefined,
      }),
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}

/** Joins online with `email`, has staff call the guest, and returns the visit. */
async function joinAndCall(email: string) {
  const queue = await freshQueue();
  const { error: joinError } = await anon.rpc('join_queue', {
    p_queue_id: queue.id,
    p_service_id: null,
    p_name: 'Lee',
    p_phone_e164: null,
    p_email: email,
    p_party_size: 1,
    p_locale: 'en',
    p_idempotency_key: randomUUID(),
  });
  if (joinError) throw joinError;
  const staff = createClient(env.url, env.anonKey, noSession);
  const { error: signInError } = await staff.auth.signInWithPassword(testUsers.staff);
  if (signInError) throw signInError;
  const { data, error } = await staff.schema('api').rpc('call_next', {
    p_queue_id: queue.id,
    p_counter_id: demo.counters.chair1,
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
  return { staff: staff.schema('api'), visit: data as { id: string; version: number } };
}

/** Runs the real dispatcher over this visit's outbox rows and returns the outcomes it reported. */
async function dispatchFor(visitId: string, site: string) {
  const reports: Record<string, string> = {};
  await dispatch({
    reserve: () => Promise.resolve('allowed'),
    async claim(limit, leaseSeconds) {
      const { data, error } = await service
        .schema('api')
        .rpc('claim_outbox', { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) throw error;
      // Other specs' rows stay leased and are claimed again when it runs out, as after a crash.
      return (data as OutboxJob[]).filter((job) => job.visit_id === visitId);
    },
    stillRelevant: () => Promise.resolve(true),
    async report(outboxId, result) {
      reports[outboxId] = result.error_code
        ? `${result.status}:${result.error_code}`
        : result.status;
      const { error } = await service
        .schema('api')
        .rpc('report_outbox_result', { p_outbox_id: outboxId, p_result: result });
      if (error) throw error;
    },
    registry: createRegistry([
      mailpitEmailChannel({ baseUrl: MAILPIT_URL, from: { email: 'queue@localhost' } }),
    ]),
    secret: 'unused-by-dispatch-0123456789abcdef',
    log: () => {},
    unsubscribe: {
      secret: SECRET,
      page: new URL('/u', site).toString(),
      endpoint: `${env.url}/functions/v1/unsubscribe`,
    },
  });
  return Object.values(reports);
}

async function mailTo(to: string) {
  let found: { ID: string } | undefined;
  await eventually(async () => {
    const query = encodeURIComponent(`to:"${to}"`);
    const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`);
    found = ((await response.json()) as { messages: { ID: string }[] }).messages[0];
    return found?.ID;
  }).toBeTruthy();
  const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found!.ID}`)).json()) as {
    Text: string;
  };
  const headers = (await (
    await fetch(`${MAILPIT_URL}/api/v1/message/${found!.ID}/headers`)
  ).json()) as Record<string, string[]>;
  return { text: message.Text, headers };
}

test('a guest stops a venue’s emails from the link in one', async ({ page, baseURL }) => {
  const email = uniqueEmail('unsub');
  const first = await joinAndCall(email);
  expect(await dispatchFor(first.visit.id, baseURL!)).toEqual(['sent']);

  const mail = await mailTo(email);
  const link = /Stop these emails: (\S+)/.exec(mail.text)?.[1];
  expect(link, 'the email has a stop link').toBeDefined();
  expect(mail.headers['List-Unsubscribe']?.[0]).toMatch(/^<.*\/functions\/v1\/unsubscribe\?n=/);
  expect(mail.headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click']);

  await serveUnsubscribe(page);
  await page.goto(link!);
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Stop emails' }).click();
  await expect(page.getByText("You won't get these emails any more")).toBeVisible();

  // The first visit ends, the guest comes back with the same address: no more email from here.
  const { error } = await first.staff.rpc('transition_visit', {
    p_visit_id: first.visit.id,
    p_action: 'no_show',
    p_expected_version: first.visit.version,
    p_idempotency_key: randomUUID(),
  });
  expect(error).toBeNull();
  const again = await joinAndCall(email);
  expect(await dispatchFor(again.visit.id, baseURL!)).toEqual(['suppressed:suppressed']);
});
