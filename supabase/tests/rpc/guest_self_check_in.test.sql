-- Guest self check-in: api.visit_status offers check_in in guest_actions exactly when api.guest_act would accept it.
begin;
\ir ../helpers/_setup.psql
select plan(8);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Self', 'S');
select tests.new_visit('walk', 'queue_s', 'Walk');
select tests.make_expected_visit('soon', 'queue_s', now() + interval '20 minutes', 'Sue');
select tests.make_expected_visit('edge', 'queue_s', now() + interval '31 minutes', 'Edie');
select tests.make_expected_visit('far', 'queue_s', now() + interval '3 hours', 'Fay');
select tests.make_expected_visit('late', 'queue_s', now() - interval '50 minutes', 'Lena');

create function tests.offers(p_name text) returns boolean language sql as $$
  select 'check_in' = any ((api.get_visit_status(p_name || '-token')).guest_actions)
$$;
grant execute on function tests.offers(text) to anon;

select tests.as_anon();
select ok(tests.offers('soon'), 'offered 20 minutes before the start');
select ok(tests.offers('late'), 'and after the start (a late check-in is still a check-in)');
select ok(not tests.offers('edge'), 'not offered 31 minutes before');
select ok(not tests.offers('far'), 'not offered 3 hours before');
select throws_ok($$ select api.guest_act('edge-token', 'check_in', gen_random_uuid()) $$, 'P0001', 'check_in_not_allowed',
  'and guest_act refuses at the same point');
select tests.as_postgres();
select ok(not private.check_in_open((select v from app.visits v where v.id = tests.id('walk'))), 'a walk-in is never offered it');
select tests.as_anon();

select is((select (api.guest_act('soon-token', 'check_in', gen_random_uuid())).status::text), 'waiting', 'checking in puts the guest in the line');
select ok(not tests.offers('soon'), 'and the action is no longer offered');

select * from finish();
rollback;
