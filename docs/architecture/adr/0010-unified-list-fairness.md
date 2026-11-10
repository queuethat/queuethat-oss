# ADR 0010: Unified list fairness (walk-ins and appointments in one queue)

Status: accepted as the shipped default (needs-human #156; The maintainer confirms on the #398 decision list).
Owner module: Visit engine (`private.call_order`, `api.call_next`). Implemented by #168 and #169.

## Context

A queue now holds walk-ins (no time promise) and checked-in appointments (a promise: "be seen at
`visits.scheduled_at`"). `call_next` must pick one. Whatever rule we pick must be explainable to a
guest on `/v/:token`, to staff, and to the ETA module, and it must live in the database (rule 2: one
owner). `visits.scheduled_at` and `queues.late_tolerance_minutes` come from #149.

## Options compared

`pnpm simulate:day --scenario mixed` (120 visits, 60% walk-in, 40% appointments, 10% of appointments
late, 5% no-show, 4 servers, seed 1). Minutes; lower is better.

| Policy | Walk-in wait p50/p90 | Appt past booked time p50/p90 | Quote error p50 naive/reserved |
| --- | --- | --- | --- |
| **A. virtual-arrival** (default) | 0.9 / 21.2 | 0.0 / 16.0 | 1.0 / 2.7 |
| B. strict-time | 0.9 / 28.2 | 0.0 / 12.0 | 1.0 / 2.4 |
| C. ratio (2 walk-ins per appointment) | 0.9 / 9.2 | 0.0 / 30.0 | 0.9 / 1.0 |

- **A.** An on-time checked-in appointment sorts as if it had joined `early` minutes before its start;
  everything is then FIFO on that virtual arrival time. One ordering key, no special cases.
- **B.** Appointments always beat walk-ins once their time arrives. Best for appointments, worst for
  walk-ins, and a late-running day starves the walk-in line.
- **C.** Best for walk-ins but breaks the appointment promise (p90 30 min late). Rejected: a booked
  time that means nothing destroys the reason to book.

**Decision: A, with a guard.** It is the only policy that keeps both p90s bounded without a second
mechanism. A walk-in that has waited longer than its quote plus `max_walkin_delay` outranks
appointments (guard), which caps walk-in starvation.

## Knobs (per queue, defaults)

| Knob | Default | Meaning |
| --- | --- | --- |
| `early_window_minutes` | 10 | Virtual arrival = `scheduled_at - early_window` for on-time check-ins |
| `late_tolerance_minutes` (#149) | 10 | Late within grace keeps the virtual time; beyond it the visit is a walk-in at its check-in time |
| `no_show_after_minutes` | 15 | Unchecked-in appointment released this long after start |
| `max_walkin_delay_minutes` | 15 | Starvation guard above |

An appointment checked in earlier than `scheduled_at - early_window` keeps its real check-in time as
the sort key (never earlier than it arrived).

## Materialization

An appointment becomes a visit (and gets a position) only at check-in, never earlier (#168). Until then
it is an expected arrival, visible to ETA as reserved work, not as a waiting visit. A cron releases
no-shows (`no_show_after_minutes`) through `private.record_visit_event`, so I-1 holds.

## ETA

The simulator quotes each walk-in two ways: naive (waiting visits only) and reserved (also counting
expected appointments in the next hour). Under A and B the reserved quote is *worse* (p50 error 2.7 and 2.4 min against
1.0 naive), because most expected appointments do not arrive in time to delay the walk-in and 5% never
arrive. Only C benefits (1.0 vs 0.9, a wash). **Default: `private.visit_eta` ignores expected
appointments and counts only checked-in visits**, which keeps the rule simple; reserved work is revisited if
the browser tests show walk-ins quoted too low on busy appointment days. `formatEta` still only renders.

## Interaction with existing operations

- `call_next` picks the minimum sort key; the guard is evaluated first. Concurrent calls serialize on the
  queue row lock already used by the engine, so two counters never get the same visit.
- `undo_event` of a call restores the visit's previous sort key (derived, not stored), so an undone
  call returns to its exact place.
- Manual reorder/"move to front" overrides the sort key explicitly and writes a `visit_events` row; it
  does not alter policy for others.
- Snooze/step back re-sorts by check-in time, as for walk-ins today.

## Test scenarios for #168 and #169 (pgTAP)

1. On time: appointment checked in at `scheduled_at - 2` is called before a walk-in that joined at `scheduled_at - 5`.
2. Early: checked in 30 min before start sorts at its real check-in time, not 30 min early.
3. Late within grace: 7 min late keeps its virtual time and still precedes a walk-in that arrived after its start.
4. Late beyond grace: 12 min late sorts as a walk-in at check-in time.
5. No-show: unchecked-in after `no_show_after_minutes` is released with a `no_show` event and its slot frees.
6. Max walk-in delay guard: a walk-in past quote + `max_walkin_delay` is called ahead of an on-time appointment.
7. Concurrent `call_next` (2 counters, 1 eligible appointment + 1 walk-in): each visit called exactly once.

## Consequences

One sort key keeps `allowed_actions`, ETA and the status page consistent. The cost is that a very late
day hurts appointments by up to the guard (~15 min p90, see table). Changing the default later is a
knob change, not a schema change, so the decision is cheap to reverse.
