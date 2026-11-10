-- PLT6 (#412): entitlements resolve per-org override -> deployment default, members see only their
-- own orgs' resolved values, and no API role reads or writes the two tables: whoever runs the
-- deployment sets them with SQL.
begin;
\ir ../helpers/_setup.psql
select plan(23);

select tests.create_world();
select tests.create_user('stranger');
-- create_world: fixture.flag defaults to false; org A overrides it to true.

-- AC1: the override applies to its org only.
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'true'::jsonb,
  'AC1: org A gets its override');
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), 'false'::jsonb,
  'AC1: org B gets the default');
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
select tests.as_user(tests.id('stranger'));
select is(api.org_entitlements(), '{}'::jsonb, 'a signed-in user with no membership gets an empty object');
select tests.as_anon();
select throws_ok('select api.org_entitlements()', '42501', null, 'anon cannot call org_entitlements');

-- No API role reads the tables or sets a value, not even an owner for their own org.
select tests.act_as('owner');
select is((select count(*)::int from app.org_entitlements), 0, 'an owner reads no override rows, which carry the reasons');
select is((select count(*)::int from app.entitlement_defaults), 0, 'nor the defaults');
select throws_ok($$ insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_a'), 'fixture.limit', '9', 'x') $$,
  '42501', null, 'an org owner cannot give their org an override');
select throws_ok($$ update app.org_entitlements set value = 'false' where org_id = tests.id('org_a') $$,
  '42501', null, 'or change one');
select throws_ok($$ delete from app.org_entitlements where org_id = tests.id('org_a') $$,
  '42501', null, 'or remove one');
select throws_ok($$ update app.entitlement_defaults set value = 'true' where key = 'fixture.flag' $$,
  '42501', null, 'or change a default');

-- Whoever runs the deployment sets them with SQL. An override is one row per org and key.
select tests.as_postgres();
insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_b'), 'fixture.flag', 'true', 'pilot');
select throws_ok($$ insert into app.org_entitlements (org_id, key, value, reason) values (tests.id('org_b'), 'fixture.flag', 'false', 'again') $$,
  '23505', null, 'an org has at most one override per key');
select is(private.entitlement(tests.id('org_b'), 'fixture.flag'), 'true'::jsonb, 'the new override applies at once');
-- AC2: removing the override restores the default.
delete from app.org_entitlements where org_id = tests.id('org_a') and key = 'fixture.flag';
select is(private.entitlement(tests.id('org_a'), 'fixture.flag'), 'false'::jsonb,
  'AC2: after the override is removed, org A gets the default again');

select ok(obj_description('api.org_entitlements()'::regprocedure, 'pg_proc') is not null
          and obj_description('private.entitlement(uuid, text)'::regprocedure, 'pg_proc') is not null,
  'the entitlement functions document their interfaces');

select * from finish();
rollback;
