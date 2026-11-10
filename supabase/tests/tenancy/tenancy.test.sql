-- S1 (#22): tenancy rules beyond the RLS matrix.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();

-- create_organization
select tests.as_user(tests.create_user('founder'));
select lives_ok(
  $$ create temp table boot on commit drop as
     select * from api.create_organization('  Demo Barber ', 'Main Street', 'America/New_York') $$,
  'a signed-in user can create an organization');
select tests.as_postgres();

select is((select name from app.organizations where id = (select org_id from boot)), 'Demo Barber',
  'organization name is trimmed');
select is((select role::text from app.memberships
           where org_id = (select org_id from boot) and user_id = tests.id('founder')), 'owner',
  'the caller becomes owner');
select is((select slug from app.locations where id = (select location_id from boot)), 'main-street',
  'the location slug is derived from its name');

select tests.as_user(tests.id('founder'));
select isnt((select location_id from api.create_organization('Other', 'Main Street', 'UTC')),
            null::uuid, 'a second location with the same name still gets created');
select tests.as_postgres();
select ok((select slug from app.locations where name = 'Main Street' and slug <> 'main-street') ~ '^main-street-[0-9a-f]{4}$',
  'and its slug gets a unique suffix');

select tests.as_user(tests.id('founder'));
select throws_ok($$ select api.create_organization('X', 'Y', 'Mars/Olympus') $$,
  'P0001', 'invalid_timezone', 'an unknown timezone raises invalid_timezone');
select throws_ok($$ select api.create_organization(' ', 'Y', 'UTC') $$,
  'P0001', 'invalid_input', 'a blank name raises invalid_input');

select tests.as_anon();
select throws_ok($$ select api.create_organization('X', 'Y', 'UTC') $$,
  '42501', null, 'anon cannot create an organization');

-- Devices can never bootstrap an org (they would become its owner).
select tests.act_as('display');
select throws_ok($$ select api.create_organization('Mine', 'Mine', 'UTC') $$,
  '42501', 'permission_denied', 'a paired display cannot create an organization');
select tests.act_as('kiosk');
select throws_ok($$ select api.create_organization('Mine', 'Mine', 'UTC') $$,
  '42501', 'permission_denied', 'a paired kiosk cannot create an organization');

-- Cross-tenant writes and immutable org_id
select tests.act_as('other_owner');
select throws_ok(
  $$ insert into app.business_hours (org_id, location_id, weekday, opens, closes)
     values (tests.id('org_a'), tests.id('loc_a'), 3, '09:00', '17:00') $$,
  '42501', null, 'org B owner cannot insert into org A');

select tests.as_postgres();
select tests.create_user('two_org_admin');
insert into app.memberships (org_id, user_id, role) values
  (tests.id('org_a'), tests.id('two_org_admin'), 'owner'),
  (tests.id('org_b'), tests.id('two_org_admin'), 'owner');
select tests.as_user(tests.id('two_org_admin'));
select throws_ok(
  $$ update app.business_hours set org_id = tests.id('org_b') where id = tests.id('hours_a') $$,
  '42501', 'org_id is immutable', 'org_id cannot change, even for a member of both orgs');

-- Locations
select tests.act_as('owner');
select throws_ok($$ update app.locations set slug = 'renamed' where id = tests.id('loc_a') $$,
  'P0001', 'slug_immutable', 'a location slug cannot change');
select throws_ok($$ update app.locations set tz = 'Nowhere/City' where id = tests.id('loc_a') $$,
  'P0001', 'invalid_timezone', 'a location timezone must be valid');

-- Revoked devices lose access on the next request.
select tests.as_postgres();
update app.devices set revoked_at = now() where id = tests.id('display_device');
select tests.act_as('display');
select is((select count(*) from app.locations), 0::bigint, 'a revoked display sees no locations');

select * from finish();
rollback;
