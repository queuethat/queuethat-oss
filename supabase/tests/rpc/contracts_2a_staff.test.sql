-- 2A-API2 (#88): phase 2a staff and admin contracts. Every stub from that phase now has a body
-- (the last, api.set_wait_override, in #110), so only the shared pieces stay here: check-in is a
-- real transition, and private.record_visit_event writes one non-transition event and bumps the
-- realtime versions.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

-- Check-in is a real transition.
select tests.as_postgres();
select is((select to_status::text from app.visit_transitions where from_status = 'expected' and action = 'check_in'),
  'waiting', 'visit_transitions has expected -> waiting via check_in');

-- AC3: record_visit_event
create temp table before_state as
  select v.version as visit_version, q.version as queue_version,
         (select count(*) from app.visit_events e where e.visit_id = v.id) as events
  from app.visits v join app.queues q on q.id = v.queue_id where v.id = tests.id('visit_a');
select private.set_actor('staff', tests.id('staff'), null, 'moved desk', '{}');
select lives_ok($$ select private.record_visit_event(tests.id('visit_a'), 'note_updated', '{"field": "notes"}') $$,
  'record_visit_event accepts a non-transition type');
select is((select (v.version - b.visit_version)::int from app.visits v, before_state b where v.id = tests.id('visit_a')),
  1, 'AC3: the visit version rose by 1');
select is((select (q.version - b.queue_version)::int from app.queues q, before_state b where q.id = tests.id('queue_a')),
  1, 'and so did the queue version, so realtime signals fire');
select results_eq($$ select type, from_status::text, to_status::text, actor_kind::text, actor_id, reason, payload
                     from app.visit_events where visit_id = tests.id('visit_a') order by id desc limit 1 $$,
  $$ select 'note_updated', 'waiting', 'waiting', 'staff', tests.id('staff'), 'moved desk', '{"field": "notes"}'::jsonb $$,
  'exactly one new event carries the actor context, reason and payload');
select throws_ok($$ select private.record_visit_event(tests.id('visit_a'), 'cancel', '{}') $$, 'P0001', 'invalid_input',
  'a state-machine action cannot be recorded as a bare event');

select * from finish();
rollback;
