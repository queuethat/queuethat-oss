-- 2B-W1 (#289): booked appointments take server time in the walk-in ETA. The scenarios live in
-- tests/fixtures/eta.json, which packages/domain/src/eta.test.ts renders too. The formula itself
-- (private.eta_at, reserve step) shipped with the unified list (2P-APT13); this pins its behaviour.
begin;
\ir ../helpers/_setup.psql
-- The literal below must equal tests/fixtures/eta.json; packages/domain/src/eta.test.ts fails when it drifts.
create temp table fx as select $fixture${
  "comment": "Walk-in ETA scenarios shared by supabase/tests/eta/appointments.test.sql (the database computes the numbers) and packages/domain/src/eta.test.ts (the label the guest sees). A guest joining now sits behind `walkins` waiting visits of `walkinMinutes` each. An appointment is an expected guest due `inMinutes` from now (negative = already due) booked for `minutes`. All queues have early check-in 10 min and no-show after 15 min.",
  "scenarios": [
    {
      "name": "one server, appointment due inside the wait is added",
      "servers": 1,
      "walkins": 2,
      "walkinMinutes": 10,
      "reserve": true,
      "appointments": [{ "inMinutes": 15, "minutes": 30 }],
      "expect": { "state": "ok", "low": 40, "high": 60, "label": "About 40–60 min" }
    },
    {
      "name": "queue does not reserve for appointments: same line, appointment ignored",
      "servers": 1,
      "walkins": 2,
      "walkinMinutes": 10,
      "reserve": false,
      "appointments": [{ "inMinutes": 15, "minutes": 30 }],
      "expect": { "state": "ok", "low": 10, "high": 30, "label": "About 10–30 min" }
    },
    {
      "name": "appointment due long after the walk-in would start is ignored",
      "servers": 1,
      "walkins": 2,
      "walkinMinutes": 10,
      "reserve": true,
      "appointments": [{ "inMinutes": 120, "minutes": 30 }],
      "expect": { "state": "ok", "low": 10, "high": 30, "label": "About 10–30 min" }
    },
    {
      "name": "appointment past its no-show grace is ignored",
      "servers": 1,
      "walkins": 2,
      "walkinMinutes": 10,
      "reserve": true,
      "appointments": [{ "inMinutes": -60, "minutes": 30 }],
      "expect": { "state": "ok", "low": 10, "high": 30, "label": "About 10–30 min" }
    },
    {
      "name": "two servers, one appointment: its minutes are shared across both",
      "servers": 2,
      "walkins": 2,
      "walkinMinutes": 10,
      "reserve": true,
      "appointments": [{ "inMinutes": 5, "minutes": 30 }],
      "expect": { "state": "ok", "low": 20, "high": 30, "label": "About 20–30 min" }
    }
  ]
}$fixture$::jsonb as j;
select plan(jsonb_array_length((select j from fx) -> 'scenarios') * 2 + 2);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
grant select on fx to public;

-- One queue per scenario. Walk-ins share one service, so the spread is half of that service.
-- Appointment services are inactive so they do not change the queue's default minutes.
create function tests.run_scenario(p_idx int) returns text
language plpgsql as $$
declare
  s jsonb := (select j -> 'scenarios' -> p_idx from fx);
  qname text := 'scn' || p_idx;
  a jsonb;
  i int;
  n int := 0;
  svc uuid;
  vid uuid;
begin
  insert into app.queues (id, org_id, location_id, name, ticket_prefix, servers_on_duty, show_eta, eta_reserves_appointments)
  values (tests.new_id(qname), tests.id('org_a'), tests.id('loc_a'), qname, chr(65 + p_idx),
          (s ->> 'servers')::int, true, (s ->> 'reserve')::boolean);
  insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
  values (tests.new_id(qname || '_walkin'), tests.id('org_a'), tests.id('loc_a'), tests.id(qname), 'Walk-in',
          (s ->> 'walkinMinutes')::int);
  for i in 1..(s ->> 'walkins')::int loop
    vid := tests.new_visit(qname || '_w' || i, qname);
    perform private.set_actor('system', null);
    update app.visits set service_id = tests.id(qname || '_walkin') where id = vid;
  end loop;
  for a in select * from jsonb_array_elements(s -> 'appointments') loop
    n := n + 1;
    svc := tests.new_id(qname || '_svc' || n);
    insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes, active)
    values (svc, tests.id('org_a'), tests.id('loc_a'), tests.id(qname), 'Booked ' || n, (a ->> 'minutes')::int, false);
    vid := tests.make_expected_visit(qname || '_a' || n, qname,
                                     now() + (a ->> 'inMinutes')::int * interval '1 minute');
    perform private.set_actor('system', null);
    update app.visits set service_id = svc where id = vid;
  end loop;
  return concat_ws(' ', (private.queue_eta(tests.id(qname))).eta_state,
                   (private.queue_eta(tests.id(qname))).eta_low, (private.queue_eta(tests.id(qname))).eta_high);
end $$;

-- AC1 and AC3 (SQL side): every fixture scenario produces the stated state and range.
select is(tests.run_scenario(i),
  concat_ws(' ', (j -> 'scenarios' -> i -> 'expect' ->> 'state'), (j -> 'scenarios' -> i -> 'expect' ->> 'low'),
            (j -> 'scenarios' -> i -> 'expect' ->> 'high')),
  (j -> 'scenarios' -> i ->> 'name'))
from fx, generate_series(0, jsonb_array_length(j -> 'scenarios') - 1) i;

-- Every scenario's label is what formatEta renders for its range (the TS test checks the text).
select is((j -> 'scenarios' -> i -> 'expect' ->> 'label') like 'About % min', true,
          'label of "' || (j -> 'scenarios' -> i ->> 'name') || '" is a range label')
from fx, generate_series(0, jsonb_array_length(j -> 'scenarios') - 1) i;

-- AC2: cancelling the appointment drops the estimate to the plain line (scenario 0 is 40-60).
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled' where id = tests.id('scn0_a1');
select is((select concat_ws(' ', e.eta_state, e.eta_low, e.eta_high) from private.queue_eta(tests.id('scn0')) e),
  'ok 10 30', 'AC2: once the appointment is cancelled the estimate drops back to 10-30');

-- W-4 keeps working: a walk-in joining behind the same line has the range quoted on its visit row.
select tests.new_visit('late_walk', 'scn1', 'Late');
select is((select concat_ws(' ', eta_quoted_low, eta_quoted_high) from app.visits where id = tests.id('late_walk')),
  '10 30', 'the quoted range is stored at join');

select * from finish();
rollback;
