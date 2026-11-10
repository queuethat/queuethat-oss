-- PLT5 (#411): an operator ends every session in a tenant. Operator + aal2 only, org B untouched,
-- members signed out without losing their membership, devices revoked, every call audited.
begin;
\ir ../helpers/_setup.psql
select plan(22);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
-- The operator is also a member of org A: their own session must survive the sign-out.
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('platform'), 'staff');
-- An org B display, to show revoke_devices stays in its org.
select tests.create_user('display_b');
insert into app.devices (id, org_id, location_id, kind, name, auth_user_id)
values (tests.new_id('display_b_device'), tests.id('org_b'), tests.id('loc_b'), 'display', 'B TV', tests.id('display_b'));

create table tests.sessions (name text, id uuid);
insert into tests.sessions
select n, gen_random_uuid() from unnest(array['owner', 'owner', 'staff', 'other_owner', 'platform',
                                               'display', 'kiosk', 'display_b']) n;
insert into auth.sessions (id, user_id, created_at) select id, tests.id(name), now() from tests.sessions;
insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
select '00000000-0000-0000-0000-000000000000', 'rt-owner', tests.id('owner')::text, false, now(), now(),
       (select id from tests.sessions where name = 'owner' limit 1);

create function tests.sessions_of(p_name text) returns bigint
language sql as $$ select count(*) from auth.sessions where user_id = tests.id(p_name) $$;

-- AC1: nobody but an aal2 operator gets in, and nothing changes when they are refused.
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select throws_ok($$ select api.platform_sign_out_members(tests.id('org_a'), 'x') $$,
  '42501', 'permission_denied', 'AC1: an org owner cannot sign out members');
select throws_ok($$ select api.platform_revoke_devices(tests.id('org_a'), 'x') $$,
  '42501', 'permission_denied', 'AC1: an org owner cannot revoke all devices');
select tests.as_user(tests.id('support'), '{"aal":"aal2"}');
select throws_ok($$ select api.platform_sign_out_members(tests.id('org_a'), 'x') $$,
  '42501', 'permission_denied', 'platform support cannot sign out members');
select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select throws_ok($$ select api.platform_revoke_devices(tests.id('org_a'), 'x') $$,
  '42501', 'permission_denied', 'an operator without an MFA session is refused');
select tests.as_postgres();
select is((select count(*) from auth.sessions where id in (select id from tests.sessions)), 8::bigint,
  'refused calls end no session');

select tests.as_user(tests.id('platform'), '{"aal":"aal2"}');
select throws_ok($$ select api.platform_sign_out_members(tests.id('org_a'), '  ') $$,
  'P0001', 'invalid_input', 'a reason is required');
select throws_ok($$ select api.platform_revoke_devices(gen_random_uuid(), 'x') $$,
  'P0001', 'not_found', 'an unknown org is not_found');

-- AC2: sign out org A's members.
select is(api.platform_sign_out_members(tests.id('org_a'), ' Account takeover '),
  '{"users": 2, "sessions": 3}'::jsonb, 'AC2: returns the members and sessions it ended');
select tests.as_postgres();
select is(tests.sessions_of('owner') + tests.sessions_of('staff'), 0::bigint,
  'AC2: org A members have no session left');
select is((select count(*) from auth.refresh_tokens where token = 'rt-owner'), 0::bigint,
  'AC2: their refresh tokens are gone, so refresh fails');
select is(tests.sessions_of('other_owner'), 1::bigint, 'AC2: org B''s owner is still signed in');
select is(tests.sessions_of('platform'), 1::bigint, 'the calling operator keeps their own session');
select is(tests.sessions_of('display') + tests.sessions_of('kiosk'), 2::bigint,
  'devices are left to revoke_devices');
select ok((select banned_until is null from auth.users where id = tests.id('owner'))
          and exists (select 1 from app.memberships where user_id = tests.id('owner')),
  'members are not banned and keep their membership');
select results_eq(
  $$ select actor_id, org_id, target, reason from app.platform_audit where action = 'org.sign_out_members' $$,
  $$ values (tests.id('platform'), tests.id('org_a'), '{"users": 2, "sessions": 3}'::jsonb, 'Account takeover') $$,
  'the sign-out is audited with its counts and reason');

-- AC3: revoke every org A device.
select tests.as_user(tests.id('platform'), '{"aal":"aal2"}');
select is(api.platform_revoke_devices(tests.id('org_a'), 'Stolen tablet'),
  '{"devices": 2, "sessions": 2}'::jsonb, 'AC3: returns the devices revoked and sessions ended');
select tests.as_postgres();
select ok((select bool_and(d.revoked_at is not null and u.banned_until > now() + interval '99 years')
           from app.devices d join auth.users u on u.id = d.auth_user_id
           where d.org_id = tests.id('org_a')),
  'AC3: every org A display and kiosk is revoked and banned');
select is(tests.sessions_of('display') + tests.sessions_of('kiosk'), 0::bigint,
  'AC3: and has no session left to refresh');
select tests.act_as('display');
select ok(not private.is_device(tests.id('org_a'), tests.id('loc_a')),
  'AC3: a revoked display loses data access on its next request');
select tests.as_postgres();
select ok((select revoked_at is null from app.devices where id = tests.id('display_b_device'))
          and tests.sessions_of('display_b') = 1,
  'org B''s display is untouched');

-- Repeats are no-ops that are still audited.
select tests.as_user(tests.id('platform'), '{"aal":"aal2"}');
select is(api.platform_revoke_devices(tests.id('org_a'), 'Again') ||
          api.platform_sign_out_members(tests.id('org_a'), 'Again'),
  '{"users": 0, "devices": 0, "sessions": 0}'::jsonb, 'repeating either action ends nothing more');
select tests.as_postgres();
select is((select count(*) from app.platform_audit where action in ('org.sign_out_members', 'org.revoke_devices')),
  4::bigint, 'every call writes a platform_audit row');

select * from finish();
rollback;
