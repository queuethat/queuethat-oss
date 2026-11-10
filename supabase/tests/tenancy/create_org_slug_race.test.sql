-- #497: api.create_organization retries when a concurrent signup takes its location slug first.
-- A real race needs two connections (tests/concurrency/create_organization.test.ts); here
-- private.unique_location_slug is swapped, inside this rolled-back transaction, for one that
-- hands out an already-taken slug the way a lost race would.
begin;
\ir ../helpers/_setup.psql
select plan(6);

select tests.create_world();
select tests.create_user('newcomer');
create sequence pg_temp.slug_calls;
create table pg_temp.taken_slugs (n int primary key, slug text);

-- Hands out the slugs in pg_temp.taken_slugs first (as a stale read would), then real ones.
create or replace function private.unique_location_slug(p_name text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  call_no int := nextval('pg_temp.slug_calls');
  stale text := (select t.slug from pg_temp.taken_slugs t where t.n = call_no);
begin
  return coalesce(stale, private.slugify(p_name) || '-' || substr(md5(gen_random_uuid()::text), 1, 4));
end $$;

insert into pg_temp.taken_slugs values (1, 'test-location-a');
create temp table made of api.org_bootstrap;
grant insert on made to authenticated;
select tests.as_user(tests.id('newcomer'));
insert into made select * from api.create_organization('Newcomer Co', 'Test Location A', 'UTC');
select tests.as_postgres();

select isnt((select slug from app.locations where id = (select location_id from made)),
  'test-location-a', 'a lost slug race gives the new location a different slug');
select is((select slug like 'test-location-a-%' from app.locations
           where id = (select location_id from made)), true,
  'the retried slug is still derived from the location name');
select is(currval('pg_temp.slug_calls'), 2::bigint, 'it retried exactly once');
select is((select role::text from app.memberships
           where org_id = (select org_id from made) and user_id = tests.id('newcomer')), 'owner',
  'the caller still becomes the owner');
select is((select org_id from app.locations where slug = 'test-location-a'), tests.id('org_a'),
  'the other organization keeps its location and slug');

-- A slug that is taken on every attempt gives up after five tries instead of looping forever.
select setval('pg_temp.slug_calls', 1, false);
insert into pg_temp.taken_slugs select g, 'test-location-a' from generate_series(2, 10) g;
select tests.as_user(tests.id('newcomer'));
select throws_ok(
  $$ select api.create_organization('Unlucky Co', 'Test Location A', 'UTC') $$,
  '23505', null, 'endless collisions still raise the unique violation');

select * from finish();
rollback;
