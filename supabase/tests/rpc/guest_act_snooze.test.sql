-- 2A-GST1 (#122): api.guest_act on_my_way and need_more_time.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Snooze', 'S'),
  (tests.new_id('queue_c'), tests.id('org_a'), tests.id('loc_a'), 'Called', 'C');
update app.queues set grace_minutes = 5 where id = tests.id('queue_c');

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;
select set_config('request.headers', '{"x-real-ip": "198.51.100.88"}', true);

select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_s'), null, initcap(n), null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['first', 'ann', 'b', 'c', 'd', 'e']) n;
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_c'), null, initcap(n), null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['gil', 'hal']) n;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.status(p_name text) returns api.visit_status
language sql as $$ select api.get_visit_status((select token from tests.tokens where name = p_name)) $$;
create function tests.act(p_name text, p_action api.guest_action, p_key uuid default gen_random_uuid())
returns api.visit_status
language sql as $$ select api.guest_act((select token from tests.tokens where name = p_name), p_action, p_key) $$;
create function tests.vid(p_name text) returns uuid
language sql as $$ select visit_id from tests.tokens where name = p_name $$;
create function tests.events(p_name text, p_type text) returns int
language sql security definer set search_path = '' as $$ select count(*)::int from app.visit_events where visit_id = tests.vid(p_name) and type = p_type $$;
grant execute on all functions in schema tests to anon;

-- AC1: position 2 with 4 behind, snooze_places 2 (default) -> position 4, one event
select tests.as_anon();
select is((tests.status('ann')).position, 2, 'setup: Ann is second with four behind');
select is((tests.act('ann', 'need_more_time')).position, 4, 'AC1: need_more_time moves Ann behind the next two');
select is(tests.events('ann', 'snoozed'), 1, 'AC1: one snoozed event');
select is((tests.status('first')).position, 1, 'the others keep their order');
select is((tests.status('b')).position, 2, 'Bob moved up one');

-- A repeated key is the same tap
select tests.as_postgres();
create table tests.k as select gen_random_uuid() as k;
grant select on tests.k to anon;
select tests.as_anon();
select is((tests.act('ann', 'need_more_time', (select k from tests.k))).position, 6,
  'a second snooze files her behind the next two again, last in line');
select is((tests.act('ann', 'need_more_time', (select k from tests.k))).position, 6,
  'the same key again changes nothing');
select is(tests.events('ann', 'snoozed'), 2, 'and writes no third event');

-- AC2: max_snoozes (2) reached
select throws_ok($$ select tests.act('ann', 'need_more_time') $$, 'P0001', 'snooze_limit_reached',
  'AC2: the third snooze is refused');
select is((tests.status('ann')).position, 6, 'AC2: nothing changed');
select tests.as_postgres();
select is((select snooze_count from app.visits where id = tests.vid('ann')), 2, 'the count stayed at two');
select tests.as_anon();

select throws_ok($$ select api.guest_act('x', 'need_more_time', null) $$, 'P0001', 'not_found',
  'AC4: an unknown token is not_found');
select throws_ok($$ select tests.act('b', 'on_my_way', null) $$, 'P0001', 'invalid_input',
  'a key is required');

-- AC3: a called guest taps on_my_way
select tests.act_as('staff');
select (api.call_next(tests.id('queue_c'), tests.id('counter_a'), gen_random_uuid())).id;
select tests.as_postgres();
-- Nobody behind: nothing to give up and nothing used
select tests.as_anon();
select is((tests.act('hal', 'need_more_time')).position, 1, 'a guest with nobody behind stays put');
select tests.as_postgres();
select is((select snooze_count from app.visits where id = tests.vid('hal')), 0, 'and uses no snooze');
create table tests.g0 as select grace_until from app.visits where id = tests.vid('gil');
grant select on tests.g0 to anon;
select tests.as_anon();
select lives_ok($$ select tests.act('gil', 'on_my_way') $$, 'a called guest says they are on the way');
select tests.as_postgres();
select is((select v.grace_until - g.grace_until from app.visits v, tests.g0 g where v.id = tests.vid('gil')),
  interval '5 minutes', 'AC3: grace_until moved out by grace_minutes');
select tests.as_anon();
select tests.act('gil', 'on_my_way');
select tests.as_postgres();
select is((select v.grace_until - g.grace_until from app.visits v, tests.g0 g where v.id = tests.vid('gil')),
  interval '5 minutes', 'AC3: and only once');
select is(tests.events('gil', 'on_my_way'), 1, 'one on_my_way event');

-- A called guest who needs more time goes back to waiting behind the next waiting guests
select tests.as_anon();
select is((tests.act('gil', 'need_more_time')).status::text, 'waiting', 'a called guest who needs time is waiting again');
select * from finish();
rollback;
