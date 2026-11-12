-- Extension hooks (migration ..._extension_hooks): the tenant functions call a private hook at one
-- fixed point, the hooks do nothing here, and a deployment that replaces a hook's body changes the
-- tenant function's answer without redefining it.
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();

-- ------------------------------------------------------------------ the contract: names and shapes
select function_returns('private', 'ext_entitlement', array['uuid', 'text'], 'jsonb',
  'private.ext_entitlement(uuid, text) returns jsonb');
select function_returns('private', 'ext_is_blocked', array['uuid', 'text', 'text'], 'boolean',
  'private.ext_is_blocked(uuid, text, text) returns boolean');
select function_returns('private', 'ext_support_grant', array['uuid'], 'app.support_grants',
  'private.ext_support_grant(uuid) returns app.support_grants');
select is_empty(
  $$ select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname like 'ext\_%'
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')
            or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)) $$,
  'no client role can call a hook directly');
select ok((select bool_and(obj_description(p.oid, 'pg_proc') like 'Extension hook:%') from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname like 'ext\_%'),
  'every hook states its contract');

-- ------------------------------------------------------------------ here they change nothing
select is(private.ext_entitlement(tests.id('org_b'), 'fixture.flag'), null, 'ext_entitlement is null');
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), 'false'::jsonb,
  'so an org without an override gets the default');
select is(private.is_blocked(tests.id('org_a'), '+14155550100', 'someone@example.test'), false,
  'nothing is blocked');
select is((select count(*)::int from private.support_grant(tests.id('org_a')) g where g.id is not null), 0,
  'no support grant is in force');

-- ------------------------------------------------------------------ a deployment's body takes effect
create or replace function private.ext_entitlement(p_org_id uuid, p_key text) returns jsonb
language sql stable set search_path = '' as $$ select '"from-hook"'::jsonb where p_key = 'fixture.flag' $$;
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), '"from-hook"'::jsonb,
  'a hook value outranks the deployment default');
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'true'::jsonb,
  'and the org''s own override outranks the hook');
select is(private.entitlement(tests.id('org_b'), 'no.such.key'), null,
  'an unknown key with no hook value is still null');

create or replace function private.ext_is_blocked(p_org_id uuid, p_phone_e164 text, p_email text) returns boolean
language sql stable set search_path = '' as $$ select p_email = 'blocked@example.test' $$;
select is(private.is_blocked(tests.id('org_a'), null, 'blocked@example.test'), true,
  'a hook that blocks a contact blocks it');
select is(private.is_blocked(tests.id('org_a'), '+14155550100', null), false,
  'and a null answer from the hook counts as not blocked');

create or replace function private.ext_support_grant(p_org_id uuid) returns app.support_grants
language sql stable set search_path = '' as $$
  select g.* from app.support_grants g where g.org_id = p_org_id order by g.created_at limit 1
$$;
select is((select g.id from private.support_grant(tests.id('org_a')) g), tests.id('grant_a'),
  'support_grant returns the hook''s grant');
select is((select count(*)::int from private.support_grant(tests.id('org_b')) g where g.id is not null), 0,
  'and none where the hook has none');

-- A hook that hands back another org's grant gives no access here (I-3).
create or replace function private.ext_support_grant(p_org_id uuid) returns app.support_grants
language sql stable set search_path = '' as $$
  select g.* from app.support_grants g where g.id = tests.id('grant_a')
$$;
select is((select count(*)::int from private.support_grant(tests.id('org_b')) g where g.id is not null), 0,
  'support_grant ignores a grant the hook returns for a different org');

select * from finish();
rollback;
