-- PLT9 (#415): platform announcements. Signed-in users read only active rows and never who wrote
-- them; guests read nothing; only an aal2 operator writes, through the RPC, and every write is
-- audited.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

insert into app.platform_announcements (severity, message, starts_at, ends_at) values
  ('info', 'ended yesterday', now() - interval '2 days', now() - interval '1 day'),
  ('warning', 'starts tomorrow', now() + interval '1 day', now() + interval '2 days');
create function tests.as_aal1_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal1"}') $$;
grant execute on function tests.as_aal1_operator() to authenticated;

-- AC1 and AC2: staff see the active maintenance notice and nothing that ended or hasn't started.
select tests.act_as('staff');
select results_eq(
  $$ select severity::text, message from app.platform_announcements $$,
  $$ values ('maintenance', 'fixture announcement') $$,
  'AC1/AC2: staff read only the active announcement');
select tests.act_as('other_owner');
select is((select count(*) from app.platform_announcements), 1::bigint,
  'a member of another org sees the same platform-wide announcement');
select tests.act_as('display');
select is((select count(*) from app.platform_announcements), 1::bigint, 'paired devices can read it');
select tests.act_as('staff');
select throws_ok($$ select created_by from app.platform_announcements $$, '42501', null,
  'who wrote an announcement is not readable');

-- AC3: guests have no access at all.
select tests.act_as('anon');
select throws_ok($$ select count(*) from app.platform_announcements $$, '42501', null,
  'AC3: anon cannot read announcements');

-- Only an aal2 operator writes, and only through the RPC.
select tests.act_as('owner');
select throws_ok($$ insert into app.platform_announcements (severity, message, ends_at) values ('info', 'x', now() + interval '1 hour') $$,
  '42501', null, 'an org owner cannot insert directly');
select throws_ok($$ select api.platform_upsert_announcement('info', 'x', now() + interval '1 hour') $$,
  '42501', null, 'an org owner cannot call platform_upsert_announcement');
select tests.as_aal1_operator();
select throws_ok($$ select api.platform_upsert_announcement('info', 'x', now() + interval '1 hour') $$,
  '42501', null, 'an operator without MFA cannot call it');
select tests.act_as('platform');
select throws_ok($$ update app.platform_announcements set message = 'x' $$, '42501', null,
  'an operator cannot update directly either');

create temp table made (id uuid);
grant all on made to authenticated;
insert into made select api.platform_upsert_announcement('info', '  Card readers are down  ', now() + interval '1 hour');
select tests.act_as('staff');
select is((select message from app.platform_announcements where severity = 'info'), 'Card readers are down',
  'a new announcement is live for staff at once, trimmed');

select tests.act_as('platform');
select is(api.platform_upsert_announcement('warning', 'Card readers are down', now() + interval '1 hour', null, (select id from made)),
  (select id from made), 'upsert with an id replaces that announcement');
select api.platform_upsert_announcement('warning', 'Card readers are down', now(), now() - interval '1 minute', (select id from made));
select tests.act_as('staff');
select is((select count(*) from app.platform_announcements where id = (select id from made)), 0::bigint,
  'AC2: ending it early (ends_at = now) hides it');

select tests.act_as('platform');
select throws_ok($$ select api.platform_upsert_announcement('info', '   ', now() + interval '1 hour') $$,
  'P0001', 'invalid_input', 'a blank message is rejected');
select throws_ok($$ select api.platform_upsert_announcement('info', repeat('x', 501), now() + interval '1 hour') $$,
  'P0001', 'invalid_input', 'a message over 500 characters is rejected');
select throws_ok($$ select api.platform_upsert_announcement('info', 'x', now() - interval '1 hour') $$,
  'P0001', 'invalid_input', 'ends_at must be after starts_at');
select throws_ok($$ select api.platform_upsert_announcement('info', 'x', now() + interval '1 hour', null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'an unknown id is not_found');

-- Every write is audited, including service-role writes.
select tests.as_service();
insert into app.platform_announcements (severity, message, ends_at) values ('info', 'from ops', now() + interval '1 hour');
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action = 'announcement.create'
             and target ->> 'id' = (select id from made)::text and actor_id = tests.id('platform')), 1::bigint,
  'the operator''s create is audited with the operator as actor');
select is((select count(*) from app.platform_audit where action = 'announcement.update'
             and target ->> 'id' = (select id from made)::text), 2::bigint, 'each update is audited');
select is((select target ->> 'via' from app.platform_audit where action = 'announcement.create'
             and target ->> 'message' = 'from ops'), 'service_role', 'a service-role insert is audited too');

select * from finish();
rollback;
