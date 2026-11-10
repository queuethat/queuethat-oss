# ADR 0011: Multi-step journeys are transfers on one visit

Status: accepted (default chosen by the W3 epic; listed on the #398 decision list)
Ticket: #232 (Q-12). Implemented in #233, UI in #234.

## Context

Clinics and offices run registration, then triage, then a doctor. Finishing a step today means
`complete`, which is terminal. technical-design.md 4.1 says transfers are events, not states.

## Options

**(a) One visit, `advance` writes a `transferred` event (chosen).** The visit moves to the next
step's queue and goes from `serving` back to `waiting`.

**(b) One visit per step, linked by a journey id.** Each step is a new visit with its own ticket.

| | (a) one visit | (b) linked visits |
|---|---|---|
| Guest token and status page | One token, one page, queue name changes | New token per step, or a lookup layer to follow the chain |
| Undo | Existing undo for `transferred` events | A new inverse: cancel the new visit and reopen the old one |
| ETA per step | Existing ETA of the waiting visit in the new queue | Same, but the join path has to be re-entered |
| Analytics per step | `transferred` events carry `{journey_id, from_step, to_step}`; waits per step come from the event log | Easier per-step rows, but "one guest's whole visit" needs a join |
| Display and tickets | Same ticket stays on the display | Ticket per step |
| Retention | One row | N rows to purge together |

(a) wins: one guest, one token, and every existing mechanism (undo, ETA, events, display) keeps working.

## Decision

- Tables `app.journeys(id, org_id, location_id, name, active)` and
  `app.journey_steps(id, journey_id, org_id, step_no, queue_id, service_id null)`, unique on
  `(journey_id, step_no)` and `(journey_id, queue_id)`. Linear only. RLS: staff read, managers write.
- `app.services.journey_id` assigns a journey to a service; `app.visits.journey_id` is set at the
  first advance, so `join_core` is untouched.
- The current step is derived from the visit's queue within its journey, not stored. Undo goes back
  to the previous queue and the step is right again with nothing to restore. (The ticket proposed a
  `journey_step` column; it would be wrong after an undo without redefining `undo_event`.)
- `api.advance_journey(visit, expected_version, key)`: only from `serving`. Moves the visit to the
  next step's queue and service as `waiting`, filed behind everyone waiting there, keeps ticket and
  token, writes one `transferred` event `{journey_id, from_step, to_step, ...}`. On the last step it
  completes the visit. Not offered in `allowed_actions` (see below).
- State machine: `visit_action` and `visit_transitions` are unchanged. A new enum value cannot be
  used in the migration that adds it, and `allowed_actions` is built from the status alone. The
  guard accepts `serving -> waiting` only for a `transferred` event that moves a journey visit
  between queues. The console learns the next step from `app.staff_visits.journey_next_queue_id`,
  computed by the database.
- Undo: the existing `transferred` undo returns the visit to `serving` in the previous queue within
  10 minutes. The counter is cleared on advance and not restored.
- ETA: the visit is an ordinary waiting visit in the new queue. Analytics: per-step waits come from
  the `transferred` events.

## Not done (follow-ups)

- A `step_changed` notification trigger: the trigger list lives in several constraints and alert
  preferences, and is edited by other epics. The guest already gets queue-position messages.
- Guest "Step 2 of 3" on `visit_status`: that return type is fixed in Phase 0. The guest page shows
  the new queue name; a step indicator needs an interface change and a security review.
