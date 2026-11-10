-- F2 (#12): schemas, grants and extensions every later migration relies on.
--
--   app      base tables. Exposed through PostgREST to `authenticated` only; anon has no USAGE,
--            so a table that forgot its RLS policy is still unreachable for anonymous callers.
--   api      the public RPC surface (anon + authenticated). Functions are granted one by one.
--   private  helpers used by policies and api functions. Never exposed through PostgREST.
--   ops      jobs run by pg_cron or the service role (rollover, purges). Never exposed.

create schema if not exists app;
create schema if not exists api;
create schema if not exists private;
create schema if not exists ops;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Turn that off for every
-- function the migration role creates, so each api.* grant is a deliberate act.
alter default privileges revoke execute on functions from public;
alter default privileges in schema api revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema ops revoke execute on functions from public;

-- app: authenticated users reach tables only through RLS; anon gets nothing.
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;
alter default privileges in schema app revoke all on tables from public, anon;
alter default privileges in schema app revoke all on sequences from public, anon;
alter default privileges in schema app revoke all on functions from public, anon;
alter default privileges in schema app
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant usage, select on sequences to authenticated, service_role;

-- api: callable surface. Composite/enum types live here too, so both roles need USAGE.
revoke all on schema api from public;
grant usage on schema api to anon, authenticated, service_role;
alter default privileges in schema api revoke all on tables from public, anon, authenticated;

-- private: policies run as the caller, so authenticated needs USAGE to evaluate helper calls.
-- Each helper still needs an explicit EXECUTE grant. anon gets nothing.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;

-- ops: service role and pg_cron (postgres) only.
revoke all on schema ops from public, anon, authenticated;
grant usage on schema ops to service_role;

-- Jobs (rollover sweeps, idempotency purge, dispatcher re-kick) and outbound HTTP from the DB.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
