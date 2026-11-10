-- PLT6 (#412): entitlements resolve override -> global default, operators set and clear
-- overrides through one audited RPC, and members see only their own orgs' resolved values.
begin;
\ir ../helpers/_setup.psql
select plan(22);

select tests.create_world();
-- create_world: fixture.flag defaults to false; org A overrides it to true.

-- AC1: the override applies to its org only.
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'true'::jsonb,
  'AC1: org A gets its override');
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), 'false'::jsonb,
  'AC1: org B gets the global default');
select ok(private.entitled(tests.id('org_a'), 'fixture.flag'), 'AC1: entitled is true for org A');
select ok(not private.entitled(tests.id('org_b'), 'fixture.flag'), 'AC1: entitled is false for org B');

-- Unknown keys and non-boolean values never switch a feature on.
select is(private.entitlement(tests.id('org_a'), 'no.such_key'), null, 'an unknown key resolves to null');
select ok(not private.entitled(tests.id('org_a'), 'no.such_key'), 'entitled is false for an unknown key');
insert into app.entitlement_defaults (key, value, description) values ('fixture.limit', '5', 'Test limit');
select ok(not private.entitled(tests.id('org_a'), 'fixture.limit'), 'entitled is false for a non-boolean value');

-- AC3: members see their own orgs' resolved values, never another org's.
select tests.act_as('staff');
select is(api.org_entitlements() -> tests.id('org_a')::text,
  '{"fixture.flag": true, "fixture.limit": 5, "limit.locations": -1, "limit.members": -1, "messaging.daily_cap": 200, "messaging.monthly_budget_micros": 20000000, "messaging.new_org_days": 14, "messaging.new_org_daily_cap": 25, "paid_channels": true}'::jsonb,
  'org A staff get every key for org A, resolved');
select tests.act_as('other_owner');
select is(api.org_entitlements() ? tests.id('org_a')::text, false,
  'AC3: org B owner does not see org A');
select is(api.org_entitlements() -> tests.id('org_b')::text ->> 'fixture.flag', 'false',
  'org B owner sees org B''s default');
select tests.act_as('display');
select ok(api.org_entitlements() ? tests.id('org_a')::text, 'a paired display sees its org');
select tests.act_as('platform');
select is(api.org_entitlements(), '{}'::jsonb, 'an operator with no membership gets an empty object');
select tests.as_anon();
select throws_ok('select api.org_entitlements()', '42501', null, 'anon cannot call org_entitlements');

-- Only operators set overrides.
select tests.act_as('owner');
select throws_ok($$ select api.platform_set_entitlement(tests.id('org_a'), 'fixture.flag', 'false', 'x') $$,
  '42501', 'permission_denied', 'an org owner cannot set entitlements');

select tests.act_as('platform');
select throws_ok($$ select api.platform_set_entitlement(tests.id('org_a'), 'no.such_key', 'true', 'x') $$,
  'P0001', 'not_found', 'an unknown key is not_found');
select throws_ok($$ select api.platform_set_entitlement(gen_random_uuid(), 'fixture.flag', 'true', 'x') $$,
  'P0001', 'not_found', 'an unknown org is not_found');
select throws_ok($$ select api.platform_set_entitlement(tests.id('org_a'), 'fixture.flag', 'true', ' ') $$,
  'P0001', 'invalid_input', 'a blank reason is invalid_input');

-- Setting twice keeps one row; AC2: clearing restores the default.
select api.platform_set_entitlement(tests.id('org_b'), 'fixture.flag', 'true', 'pilot');
select api.platform_set_entitlement(tests.id('org_b'), 'fixture.flag', 'true', 'pilot');
select is((select count(*)::int from app.org_entitlements where org_id = tests.id('org_b')), 1,
  'setting the same override twice keeps one row');
select api.platform_set_entitlement(tests.id('org_a'), 'fixture.flag', null, 'trial over');
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'false'::jsonb,
  'AC2: after clearing the override, org A gets the global default again');
select lives_ok($$ select api.platform_set_entitlement(tests.id('org_a'), 'fixture.flag', null, 'again') $$,
  'clearing an override that is not there is a no-op');

select tests.as_postgres();
select results_eq(
  $$ select action, org_id, target -> 'value', target -> 'previous_value', reason, actor_id
     from app.platform_audit where action like 'entitlement.%' order by id $$,
  $$ values ('entitlement.set', tests.id('org_b'), 'true'::jsonb, 'null'::jsonb, 'pilot', tests.id('platform')),
            ('entitlement.set', tests.id('org_b'), 'true'::jsonb, 'true'::jsonb, 'pilot', tests.id('platform')),
            ('entitlement.clear', tests.id('org_a'), 'null'::jsonb, 'true'::jsonb, 'trial over', tests.id('platform')),
            ('entitlement.clear', tests.id('org_a'), 'null'::jsonb, 'null'::jsonb, 'again', tests.id('platform')) $$,
  'every set and clear is audited with the operator, the reason and the previous value');

select ok(obj_description('api.org_entitlements()'::regprocedure, 'pg_proc') is not null
          and obj_description('api.platform_set_entitlement(uuid, text, jsonb, text)'::regprocedure, 'pg_proc') is not null
          and obj_description('private.entitlement(uuid, text)'::regprocedure, 'pg_proc') is not null,
  'the entitlement functions document their interfaces');

select * from finish();
rollback;
