-- F2 (#12): anon cannot reach base tables or helpers; api is the only anon-visible schema.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select ok(not has_schema_privilege('anon', 'app', 'USAGE'), 'anon has no USAGE on app');
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no USAGE on private');
select ok(not has_schema_privilege('anon', 'ops', 'USAGE'), 'anon has no USAGE on ops');
select ok(not has_schema_privilege('authenticated', 'ops', 'USAGE'), 'authenticated has no USAGE on ops');
select ok(has_schema_privilege('anon', 'api', 'USAGE'), 'anon has USAGE on api');
select ok(has_schema_privilege('authenticated', 'app', 'USAGE'), 'authenticated has USAGE on app');
select has_extension('pg_cron', 'pg_cron is installed');
select has_extension('pg_net', 'pg_net is installed');

select * from finish();
rollback;
