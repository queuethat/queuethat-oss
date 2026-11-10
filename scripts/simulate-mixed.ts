// 2P-APT0 (#156): the mixed walk-in and appointment day behind docs/architecture/adr/0010-unified-list-fairness.md.
// `pnpm simulate:day --scenario mixed [--seed 1] [--servers 3] [--visits 120]`
//
// Pure model, no database: the policies do not exist in SQL yet (that is 2P-APT13), so this chooses
// the rule the SQL will implement. One-minute steps over a 10-hour day. It compares three policies
// and prints the table the ADR quotes. Self-checks: every visit ends served or no_show, and a
// server never holds two visits.
export interface Knobs {
  servers: number;
  visits: number;
  seed: number;
  meanMinutes: number;
  /** A checked-in appointment sorts as if it joined this many minutes before its start (policy a). */
  earlyWindow: number;
  /** After this many minutes late an appointment is treated as a walk-in at its check-in time. */
  lateGrace: number;
  /** A no-show appointment is released this many minutes after its start without check-in. */
  noShowAfter: number;
  /** Policy c: walk-ins called per appointment. */
  ratio: number;
  /** A walk-in waiting longer than its quote plus this many minutes outranks appointments. */
  maxWalkinDelay: number;
}

export type Policy = 'virtual-arrival' | 'strict-time' | 'ratio';
export const POLICIES: Policy[] = ['virtual-arrival', 'strict-time', 'ratio'];

interface Visit {
  id: number;
  kind: 'walkin' | 'appt';
  /** Appointments: scheduled start. Walk-ins: arrival. */
  at: number;
  /** When the guest checks in (arrives). null: never shows. */
  arrives: number | null;
  late: boolean;
  quote: number | null;
  sortKey: number;
  called: number | null;
  done: number | null;
  state: 'expected' | 'waiting' | 'served' | 'no_show';
  minutes: number;
}

const HOURLY = [0.6, 0.8, 1.0, 1.7, 1.4, 0.8, 0.7, 1.2, 1.6, 1.0];
const DAY = 600;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function makeDay(k: Knobs): Visit[] {
  const random = rng(k.seed);
  const between = (lo: number, hi: number) => lo + random() * (hi - lo);
  const service = () => {
    const sigma = Math.sqrt(Math.log(1 + 0.35 ** 2));
    const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    return k.meanMinutes * Math.exp(sigma * normal - sigma ** 2 / 2);
  };
  const total = HOURLY.reduce((a, b) => a + b, 0);
  const pickMinute = () => {
    let r = random() * total;
    for (const [hour, weight] of HOURLY.entries()) {
      if ((r -= weight) <= 0) return hour * 60 + random() * 60;
    }
    return DAY - 1;
  };
  const visits: Visit[] = [];
  for (let i = 0; i < k.visits; i++) {
    const appt = random() < 0.4;
    if (appt) {
      const at = Math.round(pickMinute() / 15) * 15; // 15-minute slots
      const r = random();
      const arrives =
        r < 0.05
          ? null
          : r < 0.15
            ? at + between(5, 30)
            : random() < 0.25
              ? at - between(1, 15)
              : at - between(0, 3);
      visits.push({
        id: i,
        kind: 'appt',
        at,
        arrives,
        late: r >= 0.05 && r < 0.15,
        quote: null,
        sortKey: 0,
        called: null,
        done: null,
        state: 'expected',
        minutes: service(),
      });
    } else {
      const at = pickMinute();
      visits.push({
        id: i,
        kind: 'walkin',
        at,
        arrives: at,
        late: false,
        quote: null,
        sortKey: 0,
        called: null,
        done: null,
        state: 'expected',
        minutes: service(),
      });
    }
  }
  return visits;
}

/** What the guest is told on joining: the people already waiting, plus (with reserved work) the
 *  appointments due before they would be reached that have not arrived yet. */
function quote(
  waiting: Visit[],
  expected: Visit[],
  now: number,
  k: Knobs,
  reserved: boolean,
): number {
  const base = (waiting.length * k.meanMinutes) / k.servers;
  if (!reserved) return base;
  const due = expected.filter((v) => v.at <= now + base && (v.arrives ?? Infinity) > now).length;
  return ((waiting.length + due) * k.meanMinutes) / k.servers;
}

export interface Result {
  policy: Policy;
  walkinP50: number;
  walkinP90: number;
  apptP50: number;
  apptP90: number;
  lateP50: number;
  quoteErrNaiveP50: number;
  quoteErrReservedP50: number;
  served: number;
  noShows: number;
}

export function simulate(policy: Policy, k: Knobs): Result {
  const visits = makeDay(k);
  const free: (Visit | null)[] = Array.from({ length: k.servers }, () => null);
  const waiting: Visit[] = [];
  let sinceAppt = 0; // policy c: walk-ins called since the last appointment
  const naive = new Map<number, number>();
  const reserved = new Map<number, number>();
  let now = 0;
  for (
    ;
    now < DAY * 2 &&
    visits.some(
      (v) => v.state === 'expected' || v.state === 'waiting' || free.some((s) => s?.id === v.id),
    );
    now++
  ) {
    // finish
    for (const [i, s] of free.entries()) if (s && s.done !== null && s.done <= now) free[i] = null;
    // arrivals and no-shows
    for (const v of visits) {
      if (v.state !== 'expected') continue;
      if (v.kind === 'walkin' && v.arrives! <= now) {
        const ahead = waiting;
        naive.set(
          v.id,
          quote(
            ahead,
            visits.filter((x) => x.kind === 'appt' && x.state === 'expected'),
            now,
            k,
            false,
          ),
        );
        reserved.set(
          v.id,
          quote(
            ahead,
            visits.filter((x) => x.kind === 'appt' && x.state === 'expected'),
            now,
            k,
            true,
          ),
        );
        v.quote = reserved.get(v.id)!;
        v.state = 'waiting';
        v.sortKey = v.arrives!;
        waiting.push(v);
      } else if (v.kind === 'appt') {
        if (v.arrives === null) {
          if (now >= v.at + k.noShowAfter) v.state = 'no_show';
        } else if (v.arrives <= now) {
          v.state = 'waiting';
          const lateBy = v.arrives - v.at;
          // virtual arrival: as if it joined early; later than the grace: a walk-in from now on
          v.sortKey = lateBy > k.lateGrace ? v.arrives : v.at - k.earlyWindow;
          if (policy !== 'virtual-arrival') v.sortKey = lateBy > k.lateGrace ? v.arrives : v.at;
          waiting.push(v);
        }
      }
    }
    // call
    for (const [i, s] of free.entries()) {
      if (s || waiting.length === 0) continue;
      const lateWalkins = waiting.filter(
        (v) =>
          v.kind === 'walkin' && v.quote !== null && now - v.arrives! > v.quote + k.maxWalkinDelay,
      );
      const isAppt = (v: Visit) => v.kind === 'appt' && v.arrives! - v.at <= k.lateGrace;
      let pick: Visit | undefined;
      if (lateWalkins.length > 0) {
        pick = lateWalkins.sort((a, b) => a.sortKey - b.sortKey)[0]; // the guard
      } else if (policy === 'virtual-arrival') {
        pick = [...waiting].sort((a, b) => a.sortKey - b.sortKey)[0];
      } else if (policy === 'strict-time') {
        const due = waiting.filter((v) => isAppt(v) && v.at <= now).sort((a, b) => a.at - b.at);
        pick =
          due[0] ??
          waiting
            .filter((v) => !(isAppt(v) && v.at > now))
            .sort((a, b) => a.sortKey - b.sortKey)[0];
      } else {
        const appts = waiting.filter(isAppt).sort((a, b) => a.sortKey - b.sortKey);
        const walkins = waiting.filter((v) => !isAppt(v)).sort((a, b) => a.sortKey - b.sortKey);
        pick = (sinceAppt >= k.ratio && appts[0]) || walkins[0] || appts[0];
        sinceAppt = pick && isAppt(pick) ? 0 : sinceAppt + 1;
      }
      if (!pick) continue;
      waiting.splice(waiting.indexOf(pick), 1);
      pick.called = now;
      pick.done = now + pick.minutes;
      pick.state = 'served';
      free[i] = pick;
    }
  }
  const unfinished = visits.filter((v) => v.state === 'expected' || v.state === 'waiting');
  if (unfinished.length > 0)
    throw new Error(`${policy}: ${unfinished.length} visits never finished`);
  const walkins = visits.filter((v) => v.kind === 'walkin');
  const appts = visits.filter((v) => v.kind === 'appt' && v.state === 'served');
  const lates = appts.filter((v) => v.late);
  const wait = (v: Visit) => v.called! - v.arrives!;
  const lateness = (v: Visit) => Math.max(0, v.called! - v.at); // how long past the booked time service began
  const err = (m: Map<number, number>) => walkins.map((v) => Math.abs(m.get(v.id)! - wait(v)));
  return {
    policy,
    walkinP50: percentile(walkins.map(wait), 0.5),
    walkinP90: percentile(walkins.map(wait), 0.9),
    apptP50: percentile(appts.map(lateness), 0.5),
    apptP90: percentile(appts.map(lateness), 0.9),
    lateP50: percentile(lates.map(wait), 0.5),
    quoteErrNaiveP50: percentile(err(naive), 0.5),
    quoteErrReservedP50: percentile(err(reserved), 0.5),
    served: visits.filter((v) => v.state === 'served').length,
    noShows: visits.filter((v) => v.state === 'no_show').length,
  };
}

export const DEFAULTS: Knobs = {
  servers: 3,
  visits: 120,
  seed: 1,
  meanMinutes: 15,
  earlyWindow: 10,
  lateGrace: 10,
  noShowAfter: 15,
  ratio: 2,
  maxWalkinDelay: 15,
};

export function runMixed(overrides: Partial<Knobs> = {}): Result[] {
  const k = { ...DEFAULTS, ...overrides };
  const rows = POLICIES.map((p) => simulate(p, k));
  const fixed = (n: number) => n.toFixed(1).padStart(6);
  console.log(
    `mixed day: ${k.visits} visits (60% walk-in, 40% appointment, 10% of appointments late, 5% no-show), ${k.servers} servers, seed ${k.seed}`,
  );
  console.log(
    `knobs: early ${k.earlyWindow} min, grace ${k.lateGrace} min, no-show after ${k.noShowAfter} min, ratio ${k.ratio}, max walk-in delay ${k.maxWalkinDelay} min\n`,
  );
  console.log(
    'policy           | walk-in wait p50/p90 | appt past booked time p50/p90 | late appt wait p50 | quote error p50 naive/reserved',
  );
  for (const r of rows) {
    console.log(
      `${r.policy.padEnd(16)} | ${fixed(r.walkinP50)} / ${fixed(r.walkinP90)}     | ${fixed(r.apptP50)} / ${fixed(r.apptP90)}            | ${fixed(r.lateP50)}             | ${fixed(r.quoteErrNaiveP50)} / ${fixed(r.quoteErrReservedP50)}`,
    );
  }
  return rows;
}
