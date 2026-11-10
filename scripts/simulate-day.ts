// O9 (#80): drives a busy day through the real api.* RPCs against LOCAL Supabase and checks the
// result: `pnpm simulate:day [--visits 150] [--speed 60] [--servers 4] [--seed 1]`
// `[--no-shows 0.06] [--leaves 0.05]` (shares of guests).
//
// Guests arrive over a 10-hour day with a lunch and an after-work peak, by phone (join_queue,
// one device key each) or at the desk (staff_add_visit). Some leave while waiting, some never
// show when called. Four staff call, start and complete at their own counters. Time runs
// `speed` times faster than real time (60: one simulated minute per second).
//
// Afterwards it asserts every visit ended in a terminal state with an unbroken event chain,
// and reports quoted-vs-actual waits and how fast the staff realtime signal arrived.
//
// Local only: it raises the per-network join cap for the run (every guest here shares one IP)
// and puts it back, pauses the duration-learning cron job for the run, and leaves a "Sim" queue
// and counters behind until `pnpm db:reset`.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEMO_PASSWORD, demo, demoUsers } from '../tests/fixtures/demo.ts';

const TERMINAL = ['served', 'no_show', 'cancelled', 'removed', 'expired'];
// Relative arrival rate for each hour of the day: quiet morning, lunch peak, after-work peak.
const HOURLY = [0.6, 0.8, 1.0, 1.7, 1.4, 0.8, 0.7, 1.2, 1.6, 1.0];
const SERVICES = [
  { name: 'Sim haircut', minutes: 20, weight: 0.6 },
  { name: 'Sim beard trim', minutes: 10, weight: 0.4 },
];

const { values: args } = parseArgs({
  options: {
    visits: { type: 'string', default: '150' },
    speed: { type: 'string', default: '60' },
    servers: { type: 'string', default: '4' },
    'no-shows': { type: 'string', default: '0.06' },
    leaves: { type: 'string', default: '0.05' },
    seed: { type: 'string', default: '1' },
    scenario: { type: 'string', default: 'day' },
    // Fail when fewer than this share (percent) of waits land inside the quote, artifact removed.
    'min-within': { type: 'string', default: '0' },
  },
});

// The mixed walk-in and appointment comparison is a pure model: no database, no Supabase needed.
if (args.scenario === 'mixed') {
  const { runMixed } = await import('./simulate-mixed.ts');
  runMixed({
    seed: Number(args.seed),
    servers: Number(args.servers),
    ...(args.visits === '150' ? {} : { visits: Number(args.visits) }),
  });
  process.exit(0);
}
const VISITS = Number(args.visits);
const SPEED = Number(args.speed);
const SERVERS = Number(args.servers);

// mulberry32: the same seed gives the same day.
let state = Number(args.seed) >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + random() * (hi - lo);
/** Service time around `mean` minutes: lognormal with a 35% coefficient of variation. */
function serviceMinutes(mean: number) {
  const sigma = Math.sqrt(Math.log(1 + 0.35 ** 2));
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return mean * Math.exp(sigma * normal - sigma ** 2 / 2);
}

const start = Date.now();
const simNow = () => ((Date.now() - start) * SPEED) / 60_000;
const sleep = (simMinutes: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, (simMinutes * 60_000) / SPEED)));

function localStack() {
  const env = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const read = (name: string) => env.match(new RegExp(`^${name}="(.*)"$`, 'm'))?.[1];
  const url = read('API_URL');
  const anonKey = read('ANON_KEY');
  const serviceKey = read('SERVICE_ROLE_KEY');
  const dbUrl = read('DB_URL');
  if (!url || !anonKey || !serviceKey || !dbUrl) {
    console.error('Local Supabase is not running. Start it with `pnpm db:start`.');
    process.exit(1);
  }
  return { url, anonKey, serviceKey, dbUrl };
}

const stack = localStack();
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const sql = postgres(stack.dbUrl, { max: 2, onnotice: () => {} });
const service = createClient(stack.url, stack.serviceKey, noSession);
const guestRealtime = createClient(stack.url, stack.anonKey, noSession);
const guestApi = guestRealtime.schema('api');

/** Awaits a supabase-js call: its data, or its error thrown. */
async function must<R extends { data: unknown; error: unknown }>(
  call: PromiseLike<R>,
): Promise<NonNullable<R['data']>> {
  const { data, error } = await call;
  if (error) throw error;
  if (data == null) throw new Error('No data returned');
  return data as NonNullable<R['data']>;
}

async function setUp() {
  const tag = randomUUID().slice(0, 6);
  const app = service.schema('app');
  const queue = await must(
    app
      .from('queues')
      .insert({
        org_id: demo.orgId,
        location_id: demo.locationId,
        name: `Sim ${tag}`,
        ticket_prefix: 'S',
        sort_order: 5000,
        servers_on_duty: SERVERS,
        online_joins_per_hour: 1000,
      })
      .select('id')
      .single(),
  );
  const services = await must(
    app
      .from('services')
      .insert(
        SERVICES.map((s) => ({
          org_id: demo.orgId,
          location_id: demo.locationId,
          queue_id: queue.id,
          name: s.name,
          expected_minutes: s.minutes,
        })),
      )
      .select('id, expected_minutes'),
  );
  const counters = await must(
    app
      .from('counters')
      .insert(
        Array.from({ length: SERVERS }, (_, i) => ({
          org_id: demo.orgId,
          location_id: demo.locationId,
          label: `Sim ${tag} chair ${i + 1}`,
        })),
      )
      .select('id'),
  );
  return { queueId: queue.id as string, services, counters: counters.map((c) => c.id as string) };
}

async function staffClient(): Promise<SupabaseClient> {
  const client = createClient(stack.url, stack.anonKey, noSession);
  await must(
    client.auth.signInWithPassword({ email: demoUsers.staff.email, password: DEMO_PASSWORD }),
  );
  return client;
}

/** Arrival minutes for the day, drawn from HOURLY by inverse CDF, in order. */
function arrivals(): number[] {
  const total = HOURLY.reduce((a, b) => a + b, 0);
  return Array.from({ length: VISITS }, () => {
    let u = random() * total;
    let hour = 0;
    while (u > HOURLY[hour]! && hour < HOURLY.length - 1) u -= HOURLY[hour++]!;
    return (hour + u / HOURLY[hour]!) * 60;
  }).sort((a, b) => a - b);
}

interface Guest {
  visitId?: string;
  token?: string;
  minutes: number;
  noShow: boolean;
}

interface Call {
  visitId: string;
  ticket: string;
  /** Just before call_next was sent, and when its response came back (epoch ms). */
  at: number;
  returned: number;
}

interface Followed {
  topic: string;
  event: string;
  /** When each key's messages arrived (epoch ms), in order. */
  arrivals: Map<string, number[]>;
  /** Every message received: its queue version and when it arrived (epoch ms). */
  got: Map<number, number>;
  /** Channel status changes after the first join, with their time. */
  statuses: { status: string; at: number }[];
}

/** Joins a private topic and records when each message arrived, by version and by key. */
async function follow(
  client: SupabaseClient,
  topic: string,
  event: string,
  keyOf: (payload: Record<string, string>) => string,
): Promise<Followed> {
  const f: Followed = {
    topic,
    event,
    arrivals: new Map(),
    got: new Map(),
    statuses: [],
  };
  await new Promise<void>((resolve, reject) => {
    client
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event }, ({ payload }) => {
        f.got.set(Number(payload.version), Date.now());
        const key = keyOf(payload);
        f.arrivals.set(key, [...(f.arrivals.get(key) ?? []), Date.now()]);
      })
      .subscribe((status, error) => {
        f.statuses.push({ status, at: Date.now() });
        if (status === 'SUBSCRIBED') resolve();
        else if (status !== 'CLOSED') reject(error ?? new Error(status));
      });
  });
  f.statuses = [];
  return f;
}

async function main() {
  const [{ per_network_joins: savedCap }] = await sql`
    select per_network_joins from private.deployment_settings`;
  await sql`update private.deployment_settings set per_network_joins = 100000`;
  // The ETA learns service durations from served visits (refresh-duration-stats, every 15 min).
  // Here the day runs SPEED times faster than the database clock, so those durations are SPEED
  // times too short and a refresh mid-run would make every later quote far too short. Pause it.
  const [learning] = await sql`
    select jobid, active from cron.job where jobname = 'refresh-duration-stats'`;
  if (learning) await sql`select cron.alter_job(${learning.jobid}, active := false)`;
  try {
    await run();
  } finally {
    await sql`update private.deployment_settings set per_network_joins = ${savedCap}`;
    if (learning) await sql`select cron.alter_job(${learning.jobid}, active := ${learning.active})`;
    await sql.end();
  }
}

async function run() {
  const { queueId, services, counters } = await setUp();
  const staff = await staffClient();
  const api = staff.schema('api');
  const guests = new Map<string, Guest>();
  const errors: string[] = [];

  // Realtime: the staff loc: signal (keyed by visit id) and the guest qpulse: pulse (keyed by
  // now_serving, which a call sets to its own ticket). A call's message often arrives before
  // call_next's HTTP response, so calls are matched to arrivals afterwards, in the report.
  const { data: session } = await staff.auth.getSession();
  await staff.realtime.setAuth(session.session!.access_token);
  const [{ pulse_id: pulseId }] = await sql`select pulse_id from app.queues where id = ${queueId}`;
  const signals = await follow(staff, `loc:${demo.locationId}`, 'signal', (p) => p.visit_id);
  const pulses = await follow(guestRealtime, `qpulse:${pulseId}`, 'pulse', (p) => p.now_serving);
  const calls: Call[] = [];

  let arriving = true;
  const leaving: Promise<void>[] = [];
  const arrive = async () => {
    for (const at of arrivals()) {
      await sleep(at - simNow());
      const svc = random() < SERVICES[0]!.weight ? services[0]! : services[1]!;
      const guest: Guest = {
        minutes: svc.expected_minutes,
        noShow: random() < Number(args['no-shows']),
      };
      try {
        if (random() < 0.75) {
          const joined = await must(
            guestApi.rpc('join_queue', {
              p_queue_id: queueId,
              p_service_id: svc.id,
              p_name: `Sim guest ${guests.size + 1}`,
              p_phone_e164: null as unknown as string,
              p_email: null as unknown as string,
              p_party_size: 1,
              p_locale: 'en',
              p_idempotency_key: randomUUID(),
              p_device_key: randomUUID(),
            }),
          );
          guest.token = joined.token!;
          guests.set(joined.display_ticket!, guest);
          if (random() < Number(args.leaves)) leaving.push(leaveLater(guest, between(5, 25)));
        } else {
          const row = await must(
            api.rpc('staff_add_visit', {
              p_queue_id: queueId,
              p_service_id: svc.id,
              p_name: `Sim walk-in ${guests.size + 1}`,
              p_phone_e164: null as unknown as string,
              p_party_size: 1,
              p_idempotency_key: randomUUID(),
            }),
          );
          guests.set(row.display_ticket!, guest);
        }
      } catch (error) {
        errors.push(`join: ${(error as Error).message}`);
      }
    }
    arriving = false;
  };

  const leaveLater = async (guest: Guest, after: number) => {
    await sleep(after);
    const { error } = await guestApi.rpc('guest_act', {
      p_token: guest.token!,
      p_action: 'leave',
      p_idempotency_key: randomUUID(),
    });
    // Already called and finished: too late to leave, which is fine.
    if (error && !/illegal_transition/.test(error.message)) errors.push(`leave: ${error.message}`);
  };

  const transition = (
    visit: { id: string; version: number },
    action: 'start' | 'complete' | 'no_show',
  ) =>
    must(
      api.rpc('transition_visit', {
        p_visit_id: visit.id,
        p_action: action,
        p_expected_version: visit.version,
        p_idempotency_key: randomUUID(),
      }),
    );

  const serve = async (counterId: string) => {
    for (;;) {
      const sentAt = Date.now();
      const { data: called, error } = await api.rpc('call_next', {
        p_queue_id: queueId,
        p_counter_id: counterId,
        p_idempotency_key: randomUUID(),
      });
      if (error) {
        errors.push(`call_next: ${error.message}`);
        await sleep(1);
        continue;
      }
      if (!called?.id) {
        if (!arriving) return;
        await sleep(1);
        continue;
      }
      calls.push({
        visitId: called.id,
        ticket: called.display_ticket!,
        at: sentAt,
        returned: Date.now(),
      });
      const guest = guests.get(called.display_ticket!);
      try {
        if (guest?.noShow) {
          await sleep(3);
          await transition(called as { id: string; version: number }, 'no_show');
          continue;
        }
        await sleep(between(0.5, 2));
        const started = await transition(called as { id: string; version: number }, 'start');
        await sleep(serviceMinutes(guest?.minutes ?? 15));
        await transition(started as { id: string; version: number }, 'complete');
      } catch (error) {
        // The guest left after being called: stale_visit on start. Anything else is a bug.
        if (!/stale_visit|illegal_transition/.test((error as Error).message))
          errors.push(`serve: ${(error as Error).message}`);
      }
    }
  };

  await Promise.all([arrive(), ...counters.map((c) => serve(c))]);
  await Promise.all(leaving);
  await sleep(2); // let the last signals land
  await staff.removeAllChannels();
  await guestRealtime.removeAllChannels();
  await report(queueId, calls, signals, pulses, errors);
}

const pct = (xs: number[], p: number) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!
    : NaN;
const round = (n: number) => Math.round(n * 10) / 10;

async function report(
  queueId: string,
  calls: Call[],
  signals: Followed,
  pulses: Followed,
  errors: string[],
) {
  // private.eta_at counts what is left of each busy server's expected time from now() minus
  // serving_at (or called_at). Here the database clock runs in real time while the day runs
  // SPEED times faster, so at each join that term is too large. `compression` is how much
  // the quote at join was lengthened by it: the term with real-clock elapsed time minus the term
  // with simulated elapsed time, per server. Subtracting it gives the quote a real day would
  // have produced, which separates the formula's own bias from the simulator's.
  const visits = await sql`
    select v.id, v.status, v.eta_quoted_low as low, v.eta_quoted_high as high,
           extract(epoch from v.serving_at - v.joined_at) as wait_s,
           coalesce((
             select sum(greatest(0.2 * s.expected_minutes, s.expected_minutes - b.real_min)
                        - greatest(0.2 * s.expected_minutes, s.expected_minutes - b.real_min * ${SPEED}))
             from (
               select o.service_id,
                      extract(epoch from v.joined_at - case when st.to_status = 'serving'
                                                            then o.serving_at else o.called_at end) / 60
                        as real_min
               from app.visits o
               cross join lateral (
                 select e.to_status from app.visit_events e
                 where e.visit_id = o.id and e.occurred_at <= v.joined_at
                 order by e.id desc limit 1) st
               where o.queue_id = v.queue_id and o.id <> v.id
                 and st.to_status in ('called', 'serving')
             ) b
             join app.services s on s.id = b.service_id
           ), 0) / ${SERVERS} as compression
    from app.visits v where v.queue_id = ${queueId}`;
  const breaks = await sql`
    with e as (
      select visit_id, from_status, to_status, undone_by_event_id,
             lag(to_status) over (partition by visit_id order by id) as prev
      from app.visit_events where visit_id in (select id from app.visits where queue_id = ${queueId}))
    select count(*)::int as n from e
    where undone_by_event_id is null and prev is not null and from_status is distinct from prev`;
  const lastEvents = await sql`
    select v.id from app.visits v
    where v.queue_id = ${queueId} and v.status is distinct from (
      select e.to_status from app.visit_events e where e.visit_id = v.id order by e.id desc limit 1)`;

  const byStatus: Record<string, number> = {};
  for (const v of visits) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
  const open = visits.filter((v) => !TERMINAL.includes(v.status));

  // Simulated minutes from join to service start, against the range quoted at join.
  const quoted = visits.filter((v) => v.status === 'served' && v.low !== null && v.wait_s !== null);
  const score = (shift: (v: (typeof quoted)[number]) => number) => {
    const rows = quoted.map((v) => {
      const actual = (Number(v.wait_s) * SPEED) / 60;
      const [low, high] = [v.low - shift(v), v.high - shift(v)];
      const error = actual < low ? actual - low : actual > high ? actual - high : 0;
      return { error, mid: actual - (low + high) / 2 };
    });
    const absErr = rows.map((r) => Math.abs(r.error));
    return {
      n: rows.length,
      within: round((100 * rows.filter((r) => r.error === 0).length) / rows.length),
      p50: round(pct(absErr, 0.5)),
      p90: round(pct(absErr, 0.9)),
      max: round(Math.max(...absErr)),
      bias: round(rows.reduce((a, r) => a + r.mid, 0) / rows.length),
    };
  };
  const printEta = (label: string, r: ReturnType<typeof score>) => {
    console.log(`\n${label}`);
    console.log(`  actual wait inside the quoted range: ${r.within}%`);
    console.log(`  outside the range by: p50 ${r.p50}, p90 ${r.p90}, max ${r.max}`);
    console.log(`  actual minus range midpoint: mean ${r.bias} (negative = quotes too long)`);
  };

  console.log(
    `\nSimulated ${visits.length} visits, speed ${SPEED}x, ${SERVERS} servers, seed ${args.seed}`,
  );
  console.log('Outcomes:', byStatus);
  const asQuoted = score(() => 0);
  printEta(`ETA (minutes, served visits with a quote: ${asQuoted.n}), as quoted`, asQuoted);
  printEta(
    `ETA without the time-compression artifact (mean ${round(
      quoted.reduce((a, v) => a + Number(v.compression), 0) / quoted.length,
    )} min removed per quote)`,
    score((v) => Number(v.compression)),
  );
  // Delivery: every message the database sent on each topic for this queue (realtime.messages
  // keeps them), matched by queue version to what arrived. Lost = never arrived at all.
  for (const [label, f] of [
    ['Staff loc: signal', signals],
    ['Guest qpulse: pulse', pulses],
  ] as const) {
    const sent = await sql`
      select (payload ->> 'version')::int as version,
             extract(epoch from inserted_at) * 1000 as at
      from realtime.messages
      where topic = ${f.topic} and event = ${f.event}
        and (event <> 'signal' or payload ->> 'queue_id' = ${queueId})
        and inserted_at >= to_timestamp(${start / 1000})`;
    const lost = sent.filter((m) => !f.got.has(m.version));
    const lag = sent
      .filter((m) => f.got.has(m.version))
      .map((m) => Math.round(f.got.get(m.version)! - Number(m.at)));
    console.log(`\n${label} delivery: ${sent.length} sent, ${lost.length} never arrived`);
    console.log(
      `  insert to arrival (ms): p50 ${pct(lag, 0.5)}, p99 ${pct(lag, 0.99)}, max ${Math.max(...lag)}`,
    );
    if (lost.length)
      console.log(
        `  lost versions: ${lost.map((m) => `${m.version}@${new Date(Number(m.at)).toISOString().slice(11, 23)}`).join(', ')}`,
      );
    if (f.statuses.length)
      console.log(
        `  channel status changes: ${f.statuses.map((x) => `${x.status}@${new Date(x.at).toISOString().slice(11, 23)}`).join(', ')}`,
      );
  }
  // End to end: from just before call_next was sent to the first message for that call.
  for (const [label, f, keyOf] of [
    ['Staff loc: signal', signals, (c: Call) => c.visitId],
    ['Guest qpulse: pulse', pulses, (c: Call) => c.ticket],
  ] as const) {
    let early = 0;
    const ms = calls.flatMap((c) => {
      const t = f.arrivals.get(keyOf(c))?.find((at) => at >= c.at);
      if (t !== undefined && t < c.returned) early++;
      return t === undefined ? [] : [t - c.at];
    });
    console.log(`\n${label} after call_next (ms, ${calls.length} calls)`);
    console.log(`  p50 ${pct(ms, 0.5)}, p95 ${pct(ms, 0.95)}, max ${Math.max(...ms)}`);
    console.log(`  calls with no message after them: ${calls.length - ms.length}`);
    console.log(`  messages that arrived before call_next's response: ${early}`);
  }

  // Learned durations must not have fed the quotes: at speed they are SPEED times too short.
  const [{ n: learned }] = await sql`
    select count(*)::int as n from private.service_duration_stats
    where service_id in (select id from app.services where queue_id = ${queueId})`;
  const corrected = score((v) => Number(v.compression));
  const failures = [
    ...(learned
      ? [`${learned} learned-duration rows exist for the Sim services (time-compressed)`]
      : []),
    ...(corrected.within < Number(args['min-within'])
      ? [`${corrected.within}% of waits inside the quote, below --min-within ${args['min-within']}`]
      : []),
    ...(open.length ? [`${open.length} visits not terminal`] : []),
    ...(breaks[0]!.n ? [`${breaks[0]!.n} events whose from_status breaks the chain`] : []),
    ...(lastEvents.length
      ? [`${lastEvents.length} visits whose last event disagrees with status`]
      : []),
    ...(visits.length !== VISITS ? [`${visits.length} visits created, expected ${VISITS}`] : []),
    ...errors,
  ];
  if (failures.length) {
    console.error('\nFAILED:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log('\nPASSED: every visit is terminal and every event chain is consistent.');
  }
}

await main();
process.exit();
