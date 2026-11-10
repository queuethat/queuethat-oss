-- #1134: api.platform_team (operator + aal2, read-only) and api.platform_revoke_role (service role
-- only), and proof that no API path grants or changes a platform role.
begin;
\ir ../helpers/_setup.psql
select plan(35);
select tests.create_world();
-- The demo seed holds a role of its own; the list is tested against exactly these four.
delete from app.platform_roles where user_id <> tests.id('platform');
create table tests.platform_email as select email::text as email from auth.users where id = tests.id('platform');
grant select on tests.platform_email to authenticated;

select tests.create_user('support');
select tests.create_user('op2');
select tests.create_user('nobody');
select tests.create_user('unverified');
insert into app.platform_roles (user_id, role, granted_by, granted_at)
values (tests.id('support'), 'support', tests.id('platform'), '2026-10-01 12:00+00'),
       (tests.id('op2'), 'operator', null, '2026-09-01 12:00+00'),
       (tests.id('unverified'), 'support', tests.id('op2'), '2026-10-02 12:00+00');
update app.platform_roles set granted_at = '2026-08-01 12:00+00' where user_id = tests.id('platform');
update auth.users set last_sign_in_at = '2026-11-01 09:30+00' where id = tests.id('support');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), tests.id('platform'), 'a', 'totp', 'verified', now(), now(), 's'),
       (gen_random_uuid(), tests.id('support'), 'b', 'totp', 'verified', now(), now(), 's'),
       (gen_random_uuid(), tests.id('unverified'), 'c', 'totp', 'unverified', now(), now(), 's'),
       (gen_random_uuid(), tests.id('op2'), 'd', 'phone', 'verified', now(), now(), 's');
create function tests.as_aal(p_name text, p_aal text) returns void
language sql as $$ select tests.as_user(tests.id(p_name), jsonb_build_object('aal', p_aal)) $$;
grant execute on function tests.as_aal(text, text) to authenticated;

-- ---- the list: operator + aal2 only
select tests.as_aal('platform', 'aal2');
select is((select count(*) from api.platform_team()), 4::bigint, 'an operator sees all four role holders');
select results_eq(
  $$ select email is not null and role = 'operator' from api.platform_team() limit 2 $$,
  $$ values (true), (true) $$, 'operators come first');
select results_eq(
  $$ select user_id, role::text, mfa_enrolled, last_sign_in_at, granted_by, granted_by_email, granted_at, is_you
     from api.platform_team() where user_id = tests.id('support') $$,
  $$ values (tests.id('support'), 'support', true, '2026-11-01 09:30+00'::timestamptz,
             tests.id('platform'), (select email from tests.platform_email),
             '2026-10-01 12:00+00'::timestamptz, false) $$,
  'a row carries role, MFA, last sign-in and who granted it, when');
select results_eq(
  $$ select mfa_enrolled, last_sign_in_at, granted_by, granted_by_email, is_you
     from api.platform_team() where user_id = tests.id('platform') $$,
  $$ values (true, null::timestamptz, null::uuid, null::text, true) $$,
  'a CLI grant has no granter, a never-signed-in member has no last sign-in, and the caller is is_you');
select is((select mfa_enrolled from api.platform_team() where user_id = tests.id('unverified')), false,
  'an unverified factor is not enrolled');
select is((select mfa_enrolled from api.platform_team() where user_id = tests.id('op2')), false,
  'a non-TOTP factor is not enrolled');
select is((select count(*) from api.platform_team() where is_you), 1::bigint, 'exactly one row is the caller');
select is((select count(*) from api.platform_team() where user_id = tests.id('nobody')), 0::bigint,
  'users without a role are not listed');

select tests.as_aal('platform', 'aal1');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'an operator without MFA is refused');
select tests.as_aal('support', 'aal2');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'support cannot read the list');
select tests.as_aal('support', 'aal1');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'support without MFA is refused');
select tests.act_as('owner');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'an org owner cannot read it');
select tests.act_as('other_owner');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'another org''s owner cannot read it');
select tests.act_as('display');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'a paired device cannot read it');
select tests.act_as('anon');
select throws_ok($$ select * from api.platform_team() $$, '42501', null, 'anon cannot read it');

-- ---- revoke: nobody but the service role may call it
select tests.as_postgres();
select tests.as_aal('platform', 'aal2');
select throws_ok($$ select api.platform_revoke_role(tests.id('support')) $$, '42501', null,
  'an aal2 operator cannot call the revoke function');
select tests.act_as('anon');
select throws_ok($$ select api.platform_revoke_role(tests.id('support')) $$, '42501', null,
  'anon cannot call the revoke function');
select tests.as_postgres();
select is((select count(*) from app.platform_roles), 4::bigint, 'refused calls revoke nothing');

-- ---- revoke as the service role
insert into auth.sessions (id, user_id, created_at)
values (gen_random_uuid(), tests.id('support'), now()), (gen_random_uuid(), tests.id('support'), now()),
       (gen_random_uuid(), tests.id('owner'), now());
insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
select '00000000-0000-0000-0000-000000000000', 'rt-support', tests.id('support')::text, false, now(), now(), id
from auth.sessions where user_id = tests.id('support') limit 1;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;
select is(api.platform_revoke_role(tests.id('support')),
  '{"revoked": true, "previous_role": "support", "sessions": 2}'::jsonb,
  'revoking support reports the role and sessions ended');
reset role;
select is((select count(*) from app.platform_roles where user_id = tests.id('support')), 0::bigint, 'the role is gone');
select is((select count(*) from auth.sessions where user_id = tests.id('support')), 0::bigint, 'their sessions are gone');
select is((select count(*) from auth.refresh_tokens where token = 'rt-support'), 0::bigint,
  'their refresh tokens are gone, so a held token cannot refresh');
select is((select count(*) from auth.sessions where user_id = tests.id('owner')), 1::bigint,
  'other users keep their sessions');
select results_eq(
  $$ select target ->> 'previous_role', target ->> 'via' from app.platform_audit
     where action = 'platform_role.revoke' and target ->> 'user_id' = tests.id('support')::text $$,
  $$ values ('support', 'service_role') $$, 'the revoke is audited');

set local role service_role;
select is(api.platform_revoke_role(tests.id('support')),
  '{"revoked": false, "previous_role": null, "sessions": 0}'::jsonb,
  'an already revoked user is a no-op, not an error');
select is(api.platform_revoke_role(tests.id('nobody')),
  '{"revoked": false, "previous_role": null, "sessions": 0}'::jsonb,
  'a user who never had a role is a no-op');
select throws_ok($$ select api.platform_revoke_role(gen_random_uuid()) $$, 'P0001', 'not_found',
  'an unknown user is not_found');
select throws_ok($$ select api.platform_revoke_role(null) $$, 'P0001', 'not_found', 'null is not_found');

-- two operators: either can go, but not the last
select lives_ok($$ select api.platform_revoke_role(tests.id('op2')) $$, 'one of two operators can be revoked');
select throws_ok($$ select api.platform_revoke_role(tests.id('platform')) $$, 'P0001', 'last_operator',
  'the last operator cannot be revoked (also not by themselves)');
reset role;
select is((select count(*) from app.platform_roles where role = 'operator'), 1::bigint, 'the last operator is kept');
set local role service_role;
select is((api.platform_revoke_role(tests.id('platform'), true) ->> 'revoked')::boolean, true,
  'the last operator can be revoked when explicitly allowed');
reset role;

-- ---- no grant path exists
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname not in ('pg_catalog', 'information_schema')
             and p.prosrc ~* '(insert\s+into|update|merge\s+into|truncate(\s+table)?)\s+(only\s+)?app\.platform_roles'
             and p.proname not like 'create\_world%'),
  0::bigint, 'no function inserts into, updates or truncates platform_roles');
select is((select array_agg(p.oid::regprocedure::text) from pg_proc p
           where p.prosrc ~* 'delete\s+from\s+app\.platform_roles'
             and p.pronamespace in ('api'::regnamespace, 'private'::regnamespace, 'public'::regnamespace)),
  array['api.platform_revoke_role(uuid,boolean)'], 'the only function removing a role is the service-only revoke');
select ok(not has_table_privilege('authenticated', 'app.platform_roles', 'INSERT')
      and not has_table_privilege('authenticated', 'app.platform_roles', 'UPDATE')
      and not has_table_privilege('authenticated', 'app.platform_roles', 'DELETE')
      and not has_table_privilege('anon', 'app.platform_roles', 'SELECT')
      and not has_table_privilege('anon', 'app.platform_roles', 'INSERT'),
  'API roles have no write access to platform_roles, and anon none at all');

select * from finish();
rollback;
