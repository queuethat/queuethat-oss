-- PLT1 (#407): every api.platform_* function is behind private.require_platform, which needs a
-- platform role AND an aal2 (MFA) session. platform_whoami is the one exception.
begin;
\ir ../helpers/_setup.psql
select plan(17);

select tests.create_world();
select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');

/**
 * Calls every api.platform_* function except platform_whoami as p_actor with the given aal,
 * passing null for every argument, and returns the signatures that did NOT raise 42501.
 * Each call runs in a subtransaction that is rolled back, so a missing guard changes nothing.
 */
create function tests.unguarded_platform_functions(p_actor text, p_aal text) returns setof text
language plpgsql as $$
declare
  claims jsonb := (select a.claims || jsonb_build_object('aal', p_aal) from tests.actors a where a.name = p_actor);
  f record;
  outcome text;
begin
  for f in
    select p.oid::regprocedure::text as signature, format('%I.%I', n.nspname, p.proname) as name,
           (select string_agg(format('null::%s', format_type(t, null)), ', ' order by i)
              from unnest(p.proargtypes) with ordinality as a(t, i)) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api' and p.proname like 'platform\_%' and p.proname <> 'platform_whoami'
    order by 1
  loop
    begin
      perform tests.set_claims('authenticated', claims);
      execute format('select * from %s(%s)', f.name, coalesce(f.args, ''));
      raise exception using errcode = 'QMPRB', message = 'unguarded';
    exception
      when insufficient_privilege then outcome := 'guarded';
      when others then outcome := 'unguarded';
    end;
    if outcome = 'unguarded' then
      return next f.signature;
    end if;
  end loop;
end $$;
grant execute on function tests.unguarded_platform_functions(text, text) to authenticated;

-- The real schema: AC1 (org owner, aal2) and AC2 (operator, aal1).
select is_empty($$ select * from tests.unguarded_platform_functions('owner', 'aal2') $$,
  'AC1: an org owner with an aal2 session gets 42501 from every api.platform_* function');
select is_empty($$ select * from tests.unguarded_platform_functions('platform', 'aal1') $$,
  'AC2: an operator with an aal1 session gets 42501 from every api.platform_* function');

-- The rule catches a platform function without the guard, and passes one with it.
select ok(tests.catches(
  $$create function api.platform_zz(p_org uuid) returns int language sql set search_path = '' as 'select 1';
    grant execute on function api.platform_zz(uuid) to authenticated$$,
  $$select * from tests.unguarded_platform_functions('platform', 'aal1')$$, 'api.platform_zz(uuid)'),
  'catches an api.platform_* function that does not call require_platform');
select ok(not tests.catches(
  $$create function api.platform_zz(p_org uuid) returns int language plpgsql set search_path = '' as
      'begin perform private.require_platform(''support''); return 1; end';
    grant execute on function api.platform_zz(uuid) to authenticated$$,
  $$select * from tests.unguarded_platform_functions('platform', 'aal1')$$, 'api.platform_zz(uuid)'),
  'passes an api.platform_* function that calls require_platform first');

-- The guard itself, through a fixture platform function that needs operator.
create function api.platform_fixture() returns int
language plpgsql set search_path = '' as $$
begin
  perform private.require_platform('operator');
  return 1;
end $$;
grant execute on function api.platform_fixture() to authenticated;

select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select throws_ok('select api.platform_fixture()', '42501', 'permission_denied',
  'an operator with an aal1 session is denied');
select tests.as_user(tests.id('platform'));
select throws_ok('select api.platform_fixture()', '42501', 'permission_denied',
  'an operator whose JWT has no aal claim is denied');
select tests.as_user(tests.id('platform'), '{"aal":"aal2"}');
select is(api.platform_fixture(), 1, 'an operator with an aal2 session passes');
select tests.as_user(tests.id('support'), '{"aal":"aal2"}');
select throws_ok('select api.platform_fixture()', '42501', 'permission_denied',
  'support with aal2 is denied a function that needs operator');
select lives_ok($$ select private.require_platform('support') $$,
  'support with aal2 passes require_platform(''support'')');
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select throws_ok('select api.platform_fixture()', '42501', 'permission_denied',
  'an org owner with aal2 is denied');

-- platform_whoami: no MFA needed, never raises for a signed-in user.
select tests.as_user(tests.id('platform'), '{"aal":"aal1"}');
select is(api.platform_whoami(), 'operator'::app.platform_role,
  'AC2: platform_whoami returns operator for an aal1 operator');
select tests.as_user(tests.id('support'), '{"aal":"aal1"}');
select is(api.platform_whoami(), 'support'::app.platform_role, 'platform_whoami returns support');
select tests.as_user(tests.id('owner'), '{"aal":"aal2"}');
select is(api.platform_whoami(), null, 'platform_whoami returns null for a non-operator');
select ok(not private.is_platform('support'), 'is_platform is false for an org owner');
select tests.as_anon();
select throws_ok('select api.platform_whoami()', '42501', null, 'anon cannot call platform_whoami');

select tests.as_postgres();
select is(obj_description('api.platform_whoami()'::regprocedure, 'pg_proc') is not null, true,
  'platform_whoami documents its interface');
select ok(not has_function_privilege('authenticated', 'private.platform_audit(text, uuid, jsonb, text)', 'EXECUTE'),
  'API roles cannot write platform_audit through the helper');

select * from finish();
rollback;
