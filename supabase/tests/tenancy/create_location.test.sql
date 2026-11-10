-- #1080: api.create_location adds a location to an org; slug derivation, plan limit and tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

select tests.as_postgres();
update app.platform_flags set billing_enabled = false;

-- An admin adds a location; the slug is derived from the name and made unique.
select tests.act_as('admin');
select is((api.create_location(tests.id('org_a'), '  Second Street ', 'America/Chicago', null)).slug,
  'second-street', 'slug derived from the trimmed name');
select is((select count(*) from app.locations where org_id = tests.id('org_a') and name = 'Second Street'),
  1::bigint, 'the location exists in the org, name trimmed');
select is((api.create_location(tests.id('org_a'), 'Second Street', 'UTC', null)).slug <> 'second-street',
  true, 'a second location with the same name gets a different slug');
select is((api.create_location(tests.id('org_a'), 'Own slug', 'UTC', 'my-shop')).slug, 'my-shop',
  'a typed slug is kept');

-- Errors.
select throws_ok($$select api.create_location(tests.id('org_a'), 'Taken', 'UTC', 'my-shop')$$,
  'P0001', 'slug_taken', 'a slug in use is refused');
select throws_ok($$select api.create_location(tests.id('org_a'), 'Bad', 'UTC', 'Not A Slug')$$,
  'P0001', 'invalid_input', 'a malformed slug is refused');
select throws_ok($$select api.create_location(tests.id('org_a'), '   ', 'UTC', null)$$,
  'P0001', 'invalid_input', 'a blank name is refused');
select throws_ok($$select api.create_location(tests.id('org_a'), 'Mars', 'Mars/Olympus', null)$$,
  'P0001', 'invalid_timezone', 'an unknown time zone is refused');

-- Roles and tenancy: a manager is below admin; org B's owner is a stranger to org A.
select tests.act_as('manager');
select throws_ok($$select api.create_location(tests.id('org_a'), 'Nope', 'UTC', null)$$,
  '42501', 'permission_denied', 'a manager cannot add a location');
select tests.act_as('other_owner');
select throws_ok($$select api.create_location(tests.id('org_a'), 'Nope', 'UTC', null)$$,
  'P0001', 'not_found', 'cross-tenant: org B cannot add a location to org A');
select tests.as_postgres();
select is((select count(*) from app.locations where org_id = tests.id('org_a') and name = 'Nope'),
  0::bigint, 'and nothing was created');
select tests.as_anon();
select throws_ok($$select api.create_location(tests.id('org_a'), 'Nope', 'UTC', null)$$,
  '42501', null, 'anon cannot call it');

-- The plan limit applies: a free org with one location cannot add a second.
select tests.as_postgres();
update app.platform_flags set billing_enabled = true;
select tests.act_as('other_owner');
select throws_ok($$select api.create_location(tests.id('org_b'), 'Second', 'UTC', null)$$,
  'P0001', 'plan_limit_reached', 'a free org gets plan_limit_reached for a second location');

select * from finish();
rollback;
