-- 2B-G3 (#249): guest-staff chat.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;
select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_a'), null, n, null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['ann', 'bob']) n;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);
create function tests.vid(p_name text) returns uuid language sql as $$ select visit_id from tests.tokens where name = p_name $$;
create function tests.say(p_name text, p_body text, p_key uuid default gen_random_uuid()) returns api.chat_message
language sql as $$ select api.guest_send_message((select token from tests.tokens where name = p_name), p_body, p_key) $$;
create function tests.inbox(p_name text, p_after bigint default 0) returns setof api.chat_message
language sql as $$ select * from api.guest_list_messages((select token from tests.tokens where name = p_name), p_after) $$;
grant execute on all functions in schema tests to anon, authenticated;

-- AC3: chat is off by default.
select tests.as_anon();
select is((api.get_visit_status((select token from tests.tokens where name = 'ann'))).chat_version, null::bigint,
  'chat_version is null while the queue has chat off');
select throws_ok($$ select tests.say('ann', 'hi') $$, 'P0001', 'chat_disabled', 'AC3: chat disabled on the queue raises chat_disabled');
select tests.as_postgres();
update app.queues set chat_enabled = true where id = tests.id('queue_a');
create table tests.v0 as select version from app.queues where id = tests.id('queue_a');
grant select on tests.v0 to anon;

select tests.as_anon();
select is((api.get_visit_status((select token from tests.tokens where name = 'ann'))).chat_version, 0::bigint,
  'chat_version is 0 once chat is on and nobody wrote');
-- AC1
select tests.as_anon();
select lives_ok($$ select tests.say('ann', 'Running 5 min late', '00000000-0000-0000-0000-000000000001') $$, 'a guest sends a message');
select is((select (tests.say('ann', 'Running 5 min late', '00000000-0000-0000-0000-000000000001')).body), 'Running 5 min late',
  'a repeated key returns the first message');
select tests.as_postgres();
select is((select count(*)::int from app.visit_messages where visit_id = tests.vid('ann')), 1, 'one row stored');
select ok((select version from app.queues where id = tests.id('queue_a')) > (select version from tests.v0),
  'AC1: the queue version moved, which is all the pulse announces');
select tests.act_as('staff');
select is((select count(*)::int from app.visit_messages where visit_id = tests.vid('ann')), 1, 'AC1: staff of the location list the message');
select is((select (api.staff_send_message(tests.vid('ann'), 'No problem', gen_random_uuid())).sender), 'staff', 'staff reply');

-- the guest sees both, and the status counts the unread staff message
select tests.as_anon();
select is((select (api.get_visit_status((select token from tests.tokens where name = 'ann'))).unread_staff_messages), 1,
  'the status counts the unread staff message');
select is((select count(*)::int from tests.inbox('ann')), 2, 'AC5: the token lists its own two messages');
select is((select (api.get_visit_status((select token from tests.tokens where name = 'ann'))).unread_staff_messages), 0,
  'fetching marks staff messages read');
select is((select count(*)::int from tests.inbox('bob')), 0, 'AC5: another visit''s token sees none of them');

-- staff mark read
select tests.act_as('staff');
select lives_ok($$ select api.staff_mark_read(tests.vid('ann'), 1000000) $$, 'staff mark guest messages read');

-- AC2
select tests.as_anon();
select lives_ok($$ select tests.say('bob', 'm' || g) from generate_series(1, 10) g $$, 'ten messages in a minute are accepted');
select throws_ok($$ select tests.say('bob', 'eleven') $$, 'P0001', 'rate_limited', 'AC2: the 11th raises rate_limited');
select throws_ok($$ select tests.say('bob', '   ') $$, 'P0001', 'invalid_input', 'a blank message is invalid');

-- AC4
select tests.as_user(tests.id('other_owner'));
select throws_ok(format($$ select api.staff_send_message(%L, 'x', gen_random_uuid()) $$, tests.vid('ann')), 'P0001', 'not_found',
  'AC4: staff of org B get not_found');
select is((select count(*)::int from app.visit_messages), 0, 'AC4: and see no messages');

-- retention
select tests.as_postgres();
update app.visit_messages set created_at = now() - interval '91 days' where visit_id = tests.vid('ann');
select is(ops.chat_retention_tick(), 2, 'messages older than 90 days are deleted');

select * from finish();
rollback;
