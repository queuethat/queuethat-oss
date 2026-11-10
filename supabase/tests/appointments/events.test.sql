-- 2B-A3 (#278): event seat bookings, capacity, cancellation, and tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();

select tests.as_postgres();
update app.events set capacity = 10 where id = tests.id('event_a');
-- the fixture starts empty; seed 9 booked seats the way bookings would (event RPC context)
select private.set_actor('system', null);
update app.events set booked = 9 where id = tests.id('event_a');

select tests.as_anon();
select throws_ok(format($$ select api.book_event_seats(%L, 'Pat', '+15550100001', null, 2, gen_random_uuid()) $$, tests.id('event_a')),
  'P0001', 'event_full', 'AC1: capacity 10, 9 booked: a party of 2 gets event_full');
select is((select (api.book_event_seats(tests.id('event_a'), 'Pat', '+15550100001', 'pat@example.test', 1, '00000000-0000-0000-0000-0000000000a1')).status), 'booked', 'AC1: a party of 1 succeeds');
select tests.as_postgres();
select is((select booked from app.events where id = tests.id('event_a')), 10, 'the event now shows 10 seats taken');
select tests.as_anon();
select is((select count(*)::int from api.book_event_seats(tests.id('event_a'), 'Pat', '+15550100001', 'pat@example.test', 1, '00000000-0000-0000-0000-0000000000a1')), 1, 'a repeated key returns the first booking');
select tests.as_postgres();
select is((select booked from app.events where id = tests.id('event_a')), 10, 'and takes no seat');
select tests.as_anon();
select throws_ok(format($$ select api.book_event_seats(%L, 'Sam', '+15550100002', null, 1, gen_random_uuid()) $$, tests.id('event_a')),
  'P0001', 'event_full', 'a full event refuses the next guest');
select throws_ok(format($$ select api.book_event_seats(%L, 'Sam', null, null, 1, gen_random_uuid()) $$, tests.id('event_a')),
  'P0001', 'invalid_input', 'a contact is required');
select throws_ok(format($$ select api.book_event_seats(%L, 'Sam', '+15550100002', null, 1, gen_random_uuid()) $$, gen_random_uuid()),
  'P0001', 'not_found', 'unknown event');

select tests.act_as('other_owner');
select throws_ok(format($$ select api.cancel_event(%L, 'x', gen_random_uuid()) $$, tests.id('event_a')),
  'P0001', 'not_found', 'AC4: org B cannot cancel an org A event');
select is((select count(*)::int from app.events), 0, 'AC4: org B reads zero events');

select tests.act_as('staff');
select throws_ok(format($$ select api.cancel_event(%L, 'x', gen_random_uuid()) $$, tests.id('event_a')),
  'P0001', 'not_found', 'plain staff cannot cancel (manager and above)');

select tests.act_as('manager');
select set_config('app.actor_kind', '', true); -- the test shares one transaction; a real request starts clean
select throws_ok(format($$ update app.events set booked = 0 where id = %L $$, tests.id('event_a')), '42501', null, 'no client edits the seat count');
select throws_ok(format($$ update app.events set during = tstzrange('2030-01-13 10:00Z', '2030-01-13 11:00Z') where id = %L $$, tests.id('event_a')),
  'P0001', 'event_has_bookings', 'an event with bookings cannot move');
select is((select status from api.cancel_event(tests.id('event_a'), 'Instructor ill', gen_random_uuid())), 'cancelled', 'AC3: the manager cancels the event');

select tests.as_postgres();
select is((select count(*)::int from app.appointments where event_id = tests.id('event_a') and status = 'cancelled'), 1,
  'AC3: its booking is cancelled (with an appointment event)');
select is((select count(*)::int from app.appointment_events e join app.appointments a on a.id = e.appointment_id
           where a.event_id = tests.id('event_a') and e.to_status = 'cancelled'), 1, 'and the change is recorded');
select is((select count(*)::int from app.notifications n join app.appointments a on a.id = n.appointment_id
           where a.event_id = tests.id('event_a') and n.template_key = 'event_cancelled' and n.channel = 'email'), 1,
  'AC3: a cancellation email is queued for the typed address');
select is((select count(*)::int from app.notifications n join app.appointments a on a.id = n.appointment_id
           where a.event_id = tests.id('event_a') and n.channel = 'sms'), 0, 'a typed phone number is never texted');

select * from finish();
rollback;
