-- 2A-TM4 (#98): PIN-based operator switch. AC1-AC5, lockout, validation and session lifecycle.
-- Ana is the admin signed in on the tablet; Ben is the staff member who works on it.
begin;
\ir ../helpers/_setup.psql
select plan(34);
select tests.create_world();

create temp table tok (name text primary key, token text);
grant all on tok to authenticated;
create function pg_temp.header(p_name text) returns void language sql as
  $$ select set_config('request.headers', json_build_object('x-operator-token', (select token from tok where name = p_name))::text, true) $$;
create function pg_temp.no_header() returns void language sql as $$ select set_config('request.headers', '{}', true) $$;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'succeeded'; exception when others then return sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.header(text), pg_temp.no_header(), pg_temp.try(text) to authenticated;
select tests.new_visit('v1', 'queue_a');

-- set_my_pin validation.
select tests.act_as('staff');
select throws_ok($$ select api.set_my_pin(tests.id('org_a'), '123') $$, 'P0001', 'invalid_input', 'a 3-digit PIN is invalid_input');
select throws_ok($$ select api.set_my_pin(tests.id('org_a'), '1234') $$, 'P0001', 'invalid_input', 'a run like 1234 is invalid_input');
select throws_ok($$ select api.set_my_pin(tests.id('org_a'), '8765') $$, 'P0001', 'invalid_input', 'so is a descending run');
select throws_ok($$ select api.set_my_pin(tests.id('org_a'), '0000') $$, 'P0001', 'invalid_input', 'and one repeated digit');
select throws_ok($$ select api.set_my_pin(tests.id('org_a'), '12a4') $$, 'P0001', 'invalid_input', 'and non-digits');
select throws_ok($$ select api.set_my_pin(tests.id('org_b'), '7391') $$, 'P0001', 'not_a_member', 'a PIN for an org you are not in is not_a_member');
select lives_ok($$ select api.set_my_pin(tests.id('org_a'), '7391') $$, 'staff sets a valid PIN');
select tests.as_postgres();
select ok((select pin_hash like '$2%' and pin_hash not like '%7391%' from app.memberships where user_id = tests.id('staff')), 'the PIN is stored as a bcrypt hash');

-- Ana's tablet switches to Ben.
select tests.act_as('admin');
insert into tok select 'ben', (api.switch_operator(tests.id('loc_a'), tests.id('staff'), '7391')).operator_token;
select isnt((select token from tok where name = 'ben'), null, 'the right PIN returns a token');
select is((select count(*)::int from api.switch_operator(tests.id('loc_a'), tests.id('staff'), '0000') where operator_token is not null), 0, 'a wrong PIN returns no token');
select is((select count(*)::int from api.switch_operator(tests.id('loc_a'), gen_random_uuid(), '7391') where operator_token is not null), 0, 'and so does an unknown member, with the same all-null answer');
select is(api.switch_operator(tests.id('loc_a'), gen_random_uuid(), '7391')::text, api.switch_operator(tests.id('loc_a'), tests.id('staff'), '1111')::text, 'unknown member and wrong PIN look identical');
select tests.as_postgres();
select is((select token_hash from app.operator_sessions where operator_user_id = tests.id('staff') and device_user_id = tests.id('admin') and ended_at is null),
  extensions.digest((select token from tok where name = 'ben'), 'sha256'), 'only the token hash is stored');

-- AC1: the call is attributed to Ben.
select tests.act_as('admin');
select pg_temp.header('ben');
select lives_ok($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$, 'Ana''s tablet calls the next guest with Ben''s token');
select tests.as_postgres();
select results_eq($$ select actor_id, payload ->> 'device_user_id' from app.visit_events where type = 'call' order by id desc limit 1 $$,
  $$ select tests.id('staff'), tests.id('admin')::text $$, 'AC1: the call event names Ben, with the tablet account in the payload');

-- AC2: Ben is staff, so admin-only RPCs are denied even though the tablet is an admin.
select tests.act_as('admin');
select pg_temp.header('ben');
select is(pg_temp.try($$ select api.create_pairing_code(tests.id('loc_a'), 'display', 'x') $$), 'P0001:not_found', 'AC2: an admin-only RPC is denied under Ben''s token');
select is(pg_temp.try($$ select api.create_invitation(tests.id('org_a'), 'x@y.test', 'staff', null, null, gen_random_uuid()) $$), '42501:permission_denied', 'and team management needs the person''s own login');
select pg_temp.no_header();
select is(pg_temp.try($$ select api.create_pairing_code(tests.id('loc_a'), 'display', 'x') $$), 'succeeded', 'without a token the same call works for Ana');

-- AC3: five wrong PINs lock Ben at this location for five minutes.
select tests.as_postgres();
delete from private.pin_attempts;
select tests.act_as('admin');
select api.switch_operator(tests.id('loc_a'), tests.id('staff'), '0000') from generate_series(1, 5);
select is((select count(*)::int from api.switch_operator(tests.id('loc_a'), tests.id('staff'), '7391') where operator_token is not null), 0, 'AC3: the right PIN is rejected while locked');
select tests.as_postgres();
update private.pin_attempts set locked_until = now() - interval '1 second';
select tests.act_as('admin');
select is((select count(*)::int from api.switch_operator(tests.id('loc_a'), tests.id('staff'), '7391') where operator_token is not null), 1, 'after the lock expires the right PIN works again');

-- AC4: an expired token raises and nothing changes.
select tests.as_postgres();
select tests.new_visit('v2', 'queue_a');
insert into tok select 'old', 'expired-token';
insert into app.operator_sessions (org_id, location_id, device_user_id, operator_user_id, token_hash, expires_at)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('manager'), tests.id('staff'), extensions.digest('expired-token', 'sha256'), now() - interval '1 minute');
select tests.act_as('manager');
select pg_temp.header('old');
select is(pg_temp.try($$ select api.call_next(tests.id('queue_a'), null, gen_random_uuid()) $$), 'P0001:operator_session_invalid', 'AC4: an expired token raises operator_session_invalid');
select pg_temp.no_header();
select tests.as_postgres();
select is((select status::text from app.visits where id = tests.id('v2')), 'waiting', 'AC4: and the visit did not change');

-- AC5: org A's token with another session is invalid.
select tests.act_as('other_owner');
select pg_temp.header('ben');
select is(pg_temp.try($$ select count(*) from app.queues $$), 'P0001:operator_session_invalid', 'AC5: a token from org A with an org B session is operator_session_invalid');
select pg_temp.no_header();

-- Ending a session.
select tests.act_as('admin');
select lives_ok($$ select api.end_operator_session((select token from tok where name = 'ben')) $$, 'the tablet ends Ben''s session');
select lives_ok($$ select api.end_operator_session((select token from tok where name = 'ben')) $$, 'ending it again changes nothing');
select pg_temp.header('ben');
select is(pg_temp.try($$ select count(*) from app.queues $$), 'P0001:operator_session_invalid', 'an ended token is invalid');
select pg_temp.no_header();

-- Offboarding ends the operator's sessions.
select tests.act_as('admin');
insert into tok select 'ben2', (api.switch_operator(tests.id('loc_a'), tests.id('staff'), '7391')).operator_token;
select tests.act_as('owner');
select lives_ok($$ select api.remove_member((select id from app.memberships where user_id = tests.id('staff')), 'left', gen_random_uuid()) $$, 'an owner removes Ben');
select tests.as_postgres();
select is((select count(*)::int from app.operator_sessions where operator_user_id = tests.id('staff') and ended_at is null), 0, 'removing Ben ends his operator sessions');

-- Review fixes: the hash is unreachable, PIN changes need the own login, operators are capped.
select tests.act_as('admin');
select pg_temp.no_header();
select is(pg_temp.try($$ select pin_hash from app.memberships $$), '42501:permission denied for table memberships', 'an admin cannot select pin_hash');
select tests.act_as('owner');
select is(pg_temp.try($$ update app.memberships set pin_hash = 'x' $$), '42501:permission denied for table memberships', 'an owner cannot write pin_hash');
select lives_ok($$ select api.set_my_pin(tests.id('org_a'), '2580') $$, 'the owner sets a PIN');
select tests.act_as('admin');
insert into tok select 'boss', (api.switch_operator(tests.id('loc_a'), tests.id('owner'), '2580')).operator_token;
select pg_temp.header('boss');
select is(pg_temp.try($$ select api.create_pairing_code(tests.id('loc_a'), 'display', 'x') $$), 'P0001:not_found', 'an owner operator is capped at manager');
select is(pg_temp.try($$ select api.set_my_pin(tests.id('org_a'), '2580') $$), '42501:permission_denied', 'set_my_pin is refused under an operator token');
select is(pg_temp.try($$ select api.set_require_mfa(tests.id('org_a'), false) $$), '42501:permission_denied', 'so is changing the org MFA requirement');
select pg_temp.no_header();

select * from finish();
rollback;
