-- 2A-API1 (#87): phase 2a guest, kiosk and display contracts. Stubs raise not_implemented; join_queue
-- and guest_act are extended, not duplicated; the anon surface grows by exactly two functions.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

-- Hours would make joins depend on the clock.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'America/New_York');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a2'), 'Elsewhere', 'E');
create table tests.joined (name text primary key, r api.join_result);
grant all on tests.joined to anon, authenticated;
select tests.new_id(k) from unnest(array['k_old', 'k_new', 'k_kiosk', 'k_kiosk2', 'k_act']) k;

-- Surface
select is((select count(*)::int from pg_proc where pronamespace = 'api'::regnamespace and proname = 'join_queue'),
  1, 'join_queue is extended in place: one overload, no join_* variants');
select is((select count(*)::int from pg_proc where pronamespace = 'api'::regnamespace and proname like 'join\_%'),
  1, 'and no other join_* function exists');
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p
  where p.pronamespace = 'api'::regnamespace
    and p.proname in ('get_visit_info', 'get_location_wait', 'display_onsite_code')
    and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
$$, 'every new definer pins search_path = ''''');
select ok(has_function_privilege('anon', 'api.get_visit_info(text)', 'EXECUTE')
          and has_function_privilege('anon', 'api.get_location_wait(text)', 'EXECUTE'),
  'anon may execute get_visit_info and get_location_wait');
select ok(not has_function_privilege('anon', 'api.display_onsite_code(uuid)', 'EXECUTE')
          and has_function_privilege('authenticated', 'api.display_onsite_code(uuid)', 'EXECUTE'),
  'display_onsite_code is authenticated only');
select is(enum_range(null::api.guest_action)::text[], array['leave', 'on_my_way', 'need_more_time', 'check_in', 'undo_leave'],
  'guest_action gained on_my_way, need_more_time, check_in and undo_leave');

-- Stubs
select tests.as_anon();
select throws_ok($$ select api.get_visit_info('token') $$, 'P0001', 'not_found',
  'get_visit_info is implemented (visit_info.test.sql): an unknown token is not_found');
select lives_ok($$ select * from api.get_location_wait('test-location-a') $$,
  'get_location_wait is implemented (location_wait.test.sql)');
select throws_ok($$ select api.display_onsite_code(gen_random_uuid()) $$, '42501', null,
  'AC4: anon cannot call display_onsite_code');
select tests.act_as('display');
select throws_ok($$ select api.display_onsite_code(gen_random_uuid()) $$, 'P0001', 'not_found',
  'a display device gets not_found for a location that is not its own (implemented by 2A-JN5)');

-- AC1/AC2: phase-1 clients keep working with their original named arguments.
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.30"}', true);
insert into tests.joined
select 'old', api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Olga',
  p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
  p_idempotency_key => tests.id('k_old'));
select is((select (r).status::text from tests.joined where name = 'old'), 'waiting', 'AC2: a phase-1 call still joins');
select isnt((select (r).token from tests.joined where name = 'old'), null, 'and returns the token once');
insert into tests.joined
select 'new', api.join_queue(p_queue_id => tests.id('queue_a'), p_service_id => null, p_name => 'Nia',
  p_phone_e164 => null, p_email => null, p_party_size => 1, p_locale => null,
  p_idempotency_key => tests.id('k_new'), p_answers => '{}'::jsonb,
  p_group_key => gen_random_uuid(), p_onsite_code => '1234');
select is((select (r).status::text from tests.joined where name = 'new'), 'waiting',
  'empty answers and a group key are accepted; the code is ignored where not required');
select matches((select (r).display_ticket from tests.joined where name = 'new'), '^A[0-9]{3}$',
  'and the ticket format is unchanged');
select tests.as_postgres();
select is((select guest_name || ':' || source from app.visits where idempotency_key = tests.id('k_new')),
  'Nia:online', 'the extended join writes the same visit as before');

-- Guest actions: reserved values exist, raise not_implemented, and leave still works.
select tests.as_anon();
select lives_ok(format($$ select api.guest_act(%L, 'check_in', gen_random_uuid()) $$, (select (r).token from tests.joined where name = 'old')),
  'guest_act check_in on a visit already in the line is a no-op (the real cases: check_in.test.sql)');
select is((api.guest_act((select (r).token from tests.joined where name = 'old'), 'leave', gen_random_uuid())).status::text,
  'cancelled', 'leave is unchanged');

-- AC3: a kiosk joins its own location only.
select tests.act_as('kiosk');
select throws_ok($$ select api.join_queue(tests.id('queue_a2'), null, 'Kim', null, null, 1, null, tests.id('k_kiosk')) $$,
  'P0001', 'not_found', 'AC3: a kiosk of location A cannot join a queue of location A2');
select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_a2')), 0, 'and no visit was created');

select * from finish();
rollback;
