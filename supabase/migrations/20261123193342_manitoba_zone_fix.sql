-- Manitoba moved to year-round UTC-5 in March 2026 (IANA tz 2026e). A Postgres build with older tz
-- data still applies UTC-6 to America/Winnipeg from November 2026, so opening hours, the service
-- day, slots, reminders and quiet hours there run an hour off (docs/ops/time-zones.md).
--
-- Alternatives (interface rule 7): (1) move Manitoba locations to a UTC-5 zone: a data edit on
-- every install, and pages would then name the zone EST; (2) wait for the host's tz update;
-- (3) one helper that names the zone to use, applied to every `at time zone <zone column>` in the
-- database. (3) won (Riz, 2026-11-23): no tenant data changes, and it switches itself off once the
-- database's own tz data is current.
--
-- The rewrite is done in place, function by function, rather than by copying ~35 bodies here: a
-- copy would be thousands of lines and would race every parallel PR that touches those functions.
-- The guard test supabase/tests/hours/zone_fix.test.sql fails if a later migration brings back a
-- bare `at time zone l.tz`, so a redefinition copied from an older file can't drop the fix.

create function private.zone(p_tz text)
returns text
language sql immutable parallel safe set search_path = '' as $$
  select case
    -- Stale data: December 2026 in Winnipeg still reads as UTC-6.
    -- Canada/Central is the old link name for the same zone.
    when p_tz in ('America/Winnipeg', 'Canada/Central')
     and (timestamptz '2026-12-01 12:00+00' at time zone 'America/Winnipeg')
         = timestamp '2026-12-01 06:00'
      then '<-05>+05'
    else p_tz
  end
$$;
comment on function private.zone(text) is
  'The zone name to convert with for an IANA name stored on a location or schedule: the name itself, '
  'except where this database''s tz data predates a known rule change. America/Winnipeg is then '
  'fixed UTC-5 (Manitoba''s rule since March 2026; earlier winters would read an hour late, and no '
  'install has data from before then). Use `x at time zone private.zone(l.tz)`, never a bare l.tz.';
revoke all on function private.zone(text) from public;
grant execute on function private.zone(text) to authenticated, service_role;

-- Wrap every zone column or zone parameter in private.zone. 'UTC' literals are left alone.
do $$
declare
  f record;
  pattern constant text := '(at\s+time\s+zone\s+)([a-z_]+\.tz|[pv]_tz)\M';
begin
  for f in
    select p.oid, pg_catalog.pg_get_functiondef(p.oid) as def
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('api', 'app', 'ops', 'private', 'public')
      and p.prokind = 'f'
      and p.prosrc ~* pattern
  loop
    execute pg_catalog.regexp_replace(f.def, pattern, '\1private.zone(\2)', 'gi');
  end loop;
end $$;

notify pgrst, 'reload schema';
