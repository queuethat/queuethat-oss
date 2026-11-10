import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { LIVE_TIMEOUT_MS } from '../fixtures.ts';
import { demo } from '../../fixtures/demo.ts';
import { supabaseEnv } from './env.ts';

/** The local database as its superuser, for fixtures the product cannot make. */
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';

/** A guest joins `queueId` the way the join page does (anon `join_queue`, its own device key). */
export async function guestJoins(name: string, queueId: string): Promise<{ token: string }> {
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
      p_device_key: randomUUID().replaceAll('-', ''),
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return (await response.json()) as { token: string };
}

/** A staff tablet showing `queueId`, subscribed so changes can arrive live. */
export async function openQueue(page: Page, queueId: string) {
  // WebKit aborts a goto that lands while the app's own post-sign-in navigation to /staff is still
  // settling ("interrupted by another navigation"); let that one finish and go again.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`/staff?queue=${queueId}`);
      break;
    } catch (error) {
      if (attempt === 3 || !/interrupted/.test((error as Error).message)) throw error;
      await page.waitForLoadState('load');
    }
  }
  await expect(page.getByTestId('section-waiting')).toBeVisible();
  await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
}

/**
 * Moves a visit's timestamps back by `hours`, as if the day had happened earlier. Goes around the
 * visit triggers (replica role) because nothing in the product can write the past.
 */
export async function backdateVisit(queueId: string, hours: number): Promise<void> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update app.visits set joined_at = joined_at - make_interval(hours => ${hours}),
                 called_at = called_at - make_interval(hours => ${hours}),
                 serving_at = serving_at - make_interval(hours => ${hours}),
                 finished_at = finished_at - make_interval(hours => ${hours})
               where queue_id = ${queueId}`;
    });
  } finally {
    await sql.end();
  }
}

/** Makes a queue's serving visits look `minutes` older, as if service began earlier. */
export async function backdateServing(queueId: string, minutes: number): Promise<void> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update app.visits set serving_at = now() - make_interval(mins => ${minutes})
               where queue_id = ${queueId} and status = 'serving'`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * An expected visit for an appointment due `minutes` from now (negative = already due). The time is
 * kept inside the location's current calendar day, because the timeline only shows today: an hour
 * ahead at 23:30 local would otherwise land after midnight and drop off it.
 */
export async function expectedVisit(queueId: string, name: string, minutes: number) {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select private.set_actor('system', null)`;
      const [q] = await tx<{ ticket_prefix: string }[]>`
        select ticket_prefix from app.queues where id = ${queueId}`;
      const [loc] = await tx<
        { tz: string }[]
      >`select tz from app.locations where id = ${demo.locationId}`;
      const tz = loc!.tz;
      const id = randomUUID();
      const [n] = await tx<{ next: number }[]>`
        select private.next_ticket(${queueId}, ${q!.ticket_prefix}, private.service_day(${demo.locationId})) as next`;
      await tx`insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                                       display_ticket, status, sort_key, guest_name, guest_token_hash, source,
                                       idempotency_key, scheduled_at)
               values (${id}, ${demo.orgId}, ${demo.locationId}, ${queueId},
                       private.service_day(${demo.locationId}), ${q!.ticket_prefix}, ${n!.next},
                       ${q!.ticket_prefix + String(n!.next).padStart(3, '0')}, 'expected', ${n!.next * 1024},
                       ${name}, private.token_hash(${id}), 'appointment', ${randomUUID()},
                       least(
                         greatest(
                           now() + ${minutes} * interval '1 minute',
                           date_trunc('day', now() at time zone ${tz}) at time zone ${tz}
                         ),
                         (date_trunc('day', now() at time zone ${tz}) + interval '1 day' - interval '1 second') at time zone ${tz}
                       ))`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Brings the due time of a queue's join-later visits forward and runs the activation tick, as if
 * the clock had reached it (the pg_cron job runs the same function every minute).
 */
export async function activateLaterVisits(queueId: string): Promise<void> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update app.visits set arrive_after = now() - interval '1 minute'
               where queue_id = ${queueId} and status = 'expected' and arrive_after is not null`;
    });
    await sql`select ops.activate_later_tick()`;
  } finally {
    await sql.end();
  }
}
