-- #478: a location's country, set by its admins and shown to guests.
begin;
\ir ../helpers/_setup.psql
select plan(7);

select tests.create_world();

select tests.act_as('admin');
select results_eq(
  $$ update app.locations set country_code = 'GB' where id = tests.id('loc_a') returning country_code $$,
  $$ values ('GB') $$, 'an admin sets the location''s country');
select throws_ok(
  $$ update app.locations set country_code = 'gb' where id = tests.id('loc_a') $$,
  '23514', null, 'a country is two capital letters');

select tests.act_as('staff');
select is_empty(
  $$ update app.locations set country_code = 'FR' where id = tests.id('loc_a') returning 1 $$,
  'staff cannot change the country');
select tests.act_as('other_owner');
select is_empty(
  $$ update app.locations set country_code = 'FR' where id = tests.id('loc_a') returning 1 $$,
  'another org''s owner cannot change the country');
select tests.as_postgres();
select is((select country_code from app.locations where id = tests.id('loc_a')), 'GB',
  'the country is unchanged by denied updates');

select tests.as_anon();
select is((api.get_location_public('test-location-a')).country_code, 'GB',
  'guests see the location''s country');
select is((api.get_location_public('test-location-b')).country_code, null,
  'a location with no country returns null');

select * from finish();
rollback;
