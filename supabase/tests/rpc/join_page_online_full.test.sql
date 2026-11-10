-- #498 follow-up (20261025120416_join_page_online_full.sql): the join page learns a queue reached
-- its hourly online ceiling from get_location_public, by the rule join_queue enforces.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min, online_joins_per_hour, sort_order) values
  (tests.new_id('queue_cap'), tests.id('org_a'), tests.id('loc_a'), 'Capped', 'C', 100, 2, 99);
grant select on tests.ids to anon, authenticated;

/** The capped queue as the public join page sees it: (accepting, not_accepting_reason). */
create function tests.public_cap() returns text
language sql as $$
  select row(q.accepting, q.not_accepting_reason)::text
  from unnest((api.get_location_public('test-location-a')).queues) q
  where q.id = tests.id('queue_cap')
$$;
grant execute on function tests.public_cap() to anon;

select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.7"}', true);
select is(tests.public_cap(), '(t,)', 'under the ceiling the queue accepts');
select api.join_queue(tests.id('queue_cap'), null, 'G1', null, null, 1, null, gen_random_uuid(), 'online-full-device-0001');
select is(tests.public_cap(), '(t,)', 'one join below the ceiling it still accepts');
select api.join_queue(tests.id('queue_cap'), null, 'G2', null, null, 1, null, gen_random_uuid(), 'online-full-device-0002');
select is(tests.public_cap(), '(f,online_full)', 'at the ceiling it is not accepting, reason online_full');
select throws_ok($$ select api.join_queue(tests.id('queue_cap'), null, 'G3', null, null, 1, null, gen_random_uuid(), 'online-full-device-0003') $$,
  'P0001', 'rate_limited', 'which is what join_queue answers then');
select is((select q.accepting from unnest((api.get_location_public('test-location-a')).queues) q
           where q.id = tests.id('queue_a')), true, 'other queues at the location are unaffected');
select tests.as_postgres();

-- A stronger reason wins: a paused queue at its ceiling says paused.
update app.queues set manual_state = 'paused' where id = tests.id('queue_cap');
select tests.as_anon();
select is(tests.public_cap(), '(f,paused)', 'the accepting predicate''s own reason comes first');
select tests.as_postgres();

-- An admin raising the ceiling reopens the page at once.
update app.queues set manual_state = 'open' where id = tests.id('queue_cap');
select tests.act_as('admin');
update app.queues set online_joins_per_hour = 3 where id = tests.id('queue_cap');
select tests.as_anon();
select is(tests.public_cap(), '(t,)', 'raising the ceiling reopens the join page');

select * from finish();
rollback;
