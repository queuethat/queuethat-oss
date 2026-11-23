-- #85: the owner sees and chooses the join address (location slug) before it is printed.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();
select tests.create_user('founder');
select tests.create_user('second');

-- Suggestions: the plain name while it is free, then business plus location, never random first.
select tests.as_user(tests.id('founder'));
select is(api.suggest_location_slug('Corner Shop', 'Fade Co'), 'corner-shop',
  'a free location name is its own address');
select is(api.suggest_location_slug('Corner Shop', 'Fade Co', 'Fade Corner!'), 'fade-corner',
  'a wanted address is slugified and used when free');
create temp table boot on commit drop as
  select * from api.create_organization('Fade Co', 'Corner Shop', 'UTC', 'fade-corner');
select tests.as_postgres();
select is((select slug from app.locations where id = (select location_id from boot)), 'fade-corner',
  'create_organization keeps the address the owner chose');

select tests.as_user(tests.id('second'));
select is(api.suggest_location_slug('Fade Corner', 'Blade Co'), 'blade-co-fade-corner',
  'a taken name suggests business plus location');
select is(api.suggest_location_slug('Fade Corner', 'Blade Co', 'fade-corner'), 'blade-co-fade-corner',
  'a taken wanted address is not offered back');
select throws_ok($$ select api.create_organization('Blade Co', 'Fade Corner', 'UTC', 'fade-corner') $$,
  'P0001', 'slug_taken', 'a chosen address in use is refused, not changed');
select throws_ok($$ select api.create_organization('Blade Co', 'Fade Corner', 'UTC', 'Bad Slug') $$,
  'P0001', 'invalid_input', 'a malformed chosen address is refused');
select tests.as_postgres();
select is((select count(*) from app.organizations where name = 'Blade Co'), 0::bigint,
  'a refused address creates nothing');

-- An old address that redirects counts as taken (I-10: printed posters keep working).
insert into app.slug_redirects (old_slug, org_id, location_id)
  select 'old-corner', org_id, location_id from boot;
select tests.as_user(tests.id('second'));
select isnt(api.suggest_location_slug('Old Corner', null, 'old-corner'), 'old-corner',
  'an address that still redirects is never suggested');
select throws_ok($$ select api.create_organization('Blade Co', 'Old Corner', 'UTC', 'old-corner') $$,
  'P0001', 'slug_taken', 'nor can it be chosen');

-- Existing slugs never change.
select tests.as_postgres();
select is((select slug from app.locations where id = (select location_id from boot)), 'fade-corner',
  'the first location keeps its address');

select tests.as_anon();
select throws_ok($$ select api.suggest_location_slug('X') $$, '42501', null,
  'anon cannot ask for suggestions');

select * from finish();
rollback;
