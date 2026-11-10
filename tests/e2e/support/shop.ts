import type { Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { demo } from '../../fixtures/demo.ts';
import { supabaseEnv } from './env.ts';
import { pair } from './pair-ui.ts';
import { testUsers } from './users.ts';

// What the day-in-the-shop journey needs from the shop it runs in. Locally that is the demo
// seed, with the service role and the database at hand. Against the pilot (`pnpm
// test:e2e:pilot`) there is neither: the shop is reached with two test accounts' passwords and
// the public anon key, and everything the journey creates is cleaned up at the end. Modules
// that need the local stack are imported only on the local path.

/** True when `playwright.pilot.config.ts` started this run. */
export const pilot = process.env.E2E_PILOT === '1';

export interface Counter {
  id: string;
  label: string;
}

export interface Shop {
  slug: string;
  locationName: string;
  /** The two chairs the tablets serve from, in the order the console lists them. */
  counters: [Counter, Counter];
  /** A queue of its own, so nothing else in the shop is called. */
  newQueue(): Promise<{ id: string; name: string }>;
  /** Pairs `page` as the waiting-area TV. */
  pairTv(page: Page, name: string): Promise<void>;
  /** Checks the called guest's email was queued; undefined where the outbox can't be read. */
  expectEmailQueued?(queueId: string, guestName: string): Promise<void>;
  /**
   * Ends the day for whatever is left in the queue and returns how the guests' pages now read.
   * Locally the service day rolls over, as the 5-minute tick does after midnight. The pilot
   * can't time-travel, so staff remove the leftovers and the rollover job's heartbeat is read
   * from the public health check instead.
   */
  endDay(queueId: string): Promise<{ status: string; message: string }>;
  /** Removes what the run created in a shop that is not thrown away afterwards. */
  cleanup(): Promise<void>;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const PASS_ALWAYS_SITE_KEY = '1x00000000000000000000AA';

export async function openShop(): Promise<Shop> {
  return pilot ? openPilotShop() : openLocalShop();
}

async function openLocalShop(): Promise<Shop> {
  const env = supabaseEnv();
  const { freshQueue } = await import('./queues.ts');
  const { newCode, servePairDevice } = await import('./pairing.ts');
  const { eventually } = await import('./poll.ts');
  const { default: postgres } = await import('postgres');
  const service = createClient(env.url, env.serviceRoleKey, noSession);
  const locationName = 'Demo Barber Main Street';
  const databaseUrl =
    process.env.E2E_ADMIN_DATABASE_URL ??
    'postgresql://supabase_admin:postgres@127.0.0.1:55322/postgres';
  return {
    slug: demo.locationSlug,
    locationName,
    counters: [
      { id: demo.counters.chair1, label: 'Chair 1' },
      { id: demo.counters.chair2, label: 'Chair 2' },
    ],
    newQueue: freshQueue,
    async pairTv(page, name) {
      await servePairDevice(page);
      await page.goto('/display');
      await pair(page, await newCode('display', name));
    },
    async expectEmailQueued(queueId, guestName) {
      await eventually(async () => {
        const { data } = await service
          .schema('app')
          .from('notifications')
          .select('channel, template_key, visits!inner(guest_name, queue_id)')
          .eq('visits.queue_id', queueId)
          .eq('visits.guest_name', guestName);
        return data?.map((n) => [n.channel, n.template_key]);
      }).toContainEqual(['email', 'called']);
    },
    async endDay(queueId) {
      // Time travel for this queue only: its open visits move to yesterday (triggers off, as in
      // undo.test.sql), and the location rolls over as the tick would. Other specs' visits stay
      // on today.
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      try {
        await sql.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx`update app.visits set service_day = service_day - 1
                   where queue_id = ${queueId} and status in ('waiting', 'called', 'serving')`;
        });
        // The sweep skips a location row that a concurrent join holds (SKIP LOCKED) and leaves it
        // to the next tick, so with other specs joining at the demo shop, ask again.
        for (let attempt = 0; attempt < 20; attempt++) {
          await sql.begin(async (tx) => {
            await tx`update app.locations set last_rollover_day = private.service_day(id) - 1
                     where id = ${demo.locationId}`;
            await tx`select private.rollover(now())`;
          });
          const [open] = await sql<{ n: number }[]>`
            select count(*)::int as n from app.visits
            where queue_id = ${queueId} and status in ('waiting', 'called', 'serving')`;
          if (open!.n === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        await sql.end();
      }
      return {
        status: 'expired',
        message: `This visit ended when ${locationName} closed for the day.`,
      };
    },
    async cleanup() {},
  };
}

async function openPilotShop(): Promise<Shop> {
  const env = supabaseEnv();
  const slug = process.env.PILOT_LOCATION_SLUG;
  if (!slug) throw new Error('Set PILOT_LOCATION_SLUG (the pilot shop to check).');

  const anon = createClient(env.url, env.anonKey, noSession);
  const { data: location, error: locationError } = await anon
    .schema('api')
    .rpc('get_location_public', { p_location_slug: slug });
  if (locationError || !location) throw new Error(`No pilot shop at /q/${slug}.`);
  const {
    id: locationId,
    name: locationName,
    captcha_site_key: captchaSiteKey,
  } = location as {
    id: string;
    name: string;
    captcha_site_key: string | null;
  };
  if (captchaSiteKey && captchaSiteKey !== PASS_ALWAYS_SITE_KEY) {
    throw new Error(
      'Turnstile is on with a real site key, so a headless phone cannot join from the poster ' +
        "page. Run this check before turning it on, or with Cloudflare's always-pass test key " +
        '(docs/ops/turnstile.md, Testing).',
    );
  }

  const owner = createClient(env.url, env.anonKey, noSession);
  const { error: signInError } = await owner.auth.signInWithPassword(testUsers.owner);
  if (signInError) throw signInError;
  const app = (client: SupabaseClient) => client.schema('app');
  const { data: orgRow, error: orgError } = await app(owner)
    .from('locations')
    .select('org_id')
    .eq('id', locationId)
    .single();
  if (orgError) throw orgError;
  const orgId = (orgRow as { org_id: string }).org_id;

  const { data: chairs, error: chairsError } = await app(owner)
    .from('counters')
    .select('id, label')
    .eq('location_id', locationId)
    .is('archived_at', null)
    .order('sort_order')
    .order('created_at')
    .order('label')
    .limit(2);
  if (chairsError) throw chairsError;
  if (chairs.length < 2) {
    throw new Error('The journey needs two counters (Admin → Counters) for its two tablets.');
  }

  const queueIds: string[] = [];
  const tvNames: string[] = [];
  return {
    slug,
    locationName,
    counters: [chairs[0]!, chairs[1]!],
    async newQueue() {
      const name = `E2E pilot check ${randomUUID().slice(0, 8)}`;
      const prefix = Array.from({ length: 3 }, () =>
        String.fromCharCode(65 + Math.floor(Math.random() * 26)),
      ).join('');
      const { data: queue, error } = await app(owner)
        .from('queues')
        .insert({
          org_id: orgId,
          location_id: locationId,
          name,
          ticket_prefix: prefix,
          // After the shop's own queues, so the console selects theirs first.
          sort_order: 1000,
        })
        .select('id')
        .single();
      if (error) throw error;
      queueIds.push(queue.id);
      const { error: serviceError } = await app(owner).from('services').insert({
        org_id: orgId,
        location_id: locationId,
        queue_id: queue.id,
        name: 'Check',
        expected_minutes: 15,
      });
      if (serviceError) throw serviceError;
      return { id: queue.id as string, name };
    },
    async pairTv(page, name) {
      // The real pair-device function answers; nothing is stood in for it.
      tvNames.push(name);
      const { data, error } = await owner.schema('api').rpc('create_pairing_code', {
        p_location_id: locationId,
        p_kind: 'display',
        p_name: name,
      });
      if (error) throw error;
      await page.goto('/display');
      await pair(page, (data as { code: string }).code);
    },
    async endDay(queueId) {
      const api = owner.schema('api');
      const { data: open, error } = await app(owner)
        .from('staff_visits')
        .select('id, version')
        .eq('queue_id', queueId)
        .in('status', ['waiting', 'called', 'serving']);
      if (error) throw error;
      for (const visit of open) {
        const { error: removeError } = await api.rpc('transition_visit', {
          p_visit_id: visit.id,
          p_action: 'remove',
          p_expected_version: visit.version,
          p_idempotency_key: randomUUID(),
          p_reason: 'E2E pilot check',
        });
        if (removeError) throw removeError;
      }
      // The rollover job is what ends a real day; its heartbeat is on the public health check.
      const health = await fetch(`${env.url}/functions/v1/health`);
      if (health.status !== 200) {
        throw new Error(`Health check says ${health.status}: ${await health.text()}`);
      }
      return {
        status: 'removed',
        message: 'Staff removed you from the line. Ask them if this is a mistake.',
      };
    },
    async cleanup() {
      for (const name of tvNames) {
        const { data } = await app(owner).from('devices').select('id').eq('name', name);
        for (const device of data ?? []) {
          await owner.schema('api').rpc('revoke_device', { p_device_id: device.id });
        }
      }
      for (const id of queueIds) {
        await app(owner)
          .from('queues')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', id);
      }
    },
  };
}
