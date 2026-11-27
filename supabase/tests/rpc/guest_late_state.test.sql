-- Appointment vs walk-in follow-up: api.visit_status.late_state tells a late appointment guest that checking in
-- puts them at the end of the line (late), or that it did (moved_back). The database decides; clients render it.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_l'), tests.id('org_a'), tests.id('loc_a'), 'Late state', 'L');
select tests.new_visit('walk', 'queue_l', 'Walk');
select tests.make_expected_visit('soon', 'queue_l', now() + interval '5 minutes', 'Sue');
select tests.make_expected_visit('edge', 'queue_l', now() - interval '5 minutes', 'Ed');
select tests.make_expected_visit('late', 'queue_l', now() - interval '50 minutes', 'Lena');
select tests.make_expected_visit('late2', 'queue_l', now() - interval '50 minutes', 'Leo');

create function tests.late_state(p_name text) returns text language sql as $$
  select (api.get_visit_status(p_name || '-token')).late_state
$$;
grant execute on function tests.late_state(text) to anon;

select tests.as_anon();
select is(tests.late_state('soon'), null, 'an appointment still ahead has no late state');
select is(tests.late_state('edge'), null, '5 minutes past the start is inside the 10-minute tolerance');
select is(tests.late_state('late'), 'late', '50 minutes past the start, not checked in: late');

select is((select (api.guest_act('late-token', 'check_in', gen_random_uuid())).late_state), 'moved_back',
  'checking in late: moved_back, in the same response');
select is(tests.late_state('late'), 'moved_back', 'and it stays moved_back while they wait');
select is((select (api.guest_act('edge-token', 'check_in', gen_random_uuid())).late_state), null,
  'checking in inside the tolerance is not moved back');

select tests.as_postgres();
update app.queues set late_tolerance_minutes = 60 where id = tests.id('queue_l');
select tests.as_anon();
select is(tests.late_state('late2'), null, 'the queue''s own late tolerance decides: 50 minutes late is fine with 60');

select tests.as_postgres();
select is((select count(*)::int from app.visit_events where visit_id = tests.id('walk') and type = 'check_in'), 0, 'a walk-in has no check-in event');
select is((select count(*)::int from app.visits where id = tests.id('walk') and scheduled_at is null), 1, 'and no schedule, so no late state');

select * from finish();
rollback;
