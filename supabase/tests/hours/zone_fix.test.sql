-- Manitoba is UTC-5 all year from March 2026 (tz 2026e). The database must agree whether or not
-- its own tz data knows that (private.zone, docs/ops/time-zones.md).
begin;
\ir ../helpers/_setup.psql
select plan(10);

select is_empty($$
  select p.oid::regprocedure from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('api', 'app', 'ops', 'private', 'public')
    and p.prosrc ~* 'at\s+time\s+zone\s+([a-z_]+\.tz|[pv]_tz)\M'
$$, 'guard: every zone column is converted through private.zone (a copied older body drops the fix)');

select is(timestamptz '2026-12-01 12:00+00' at time zone private.zone('America/Winnipeg'),
  timestamp '2026-12-01 07:00', 'Winnipeg in December 2026 is UTC-5');
select is(timestamptz '2026-07-01 12:00+00' at time zone private.zone('America/Winnipeg'),
  timestamp '2026-07-01 07:00', 'Winnipeg in July 2026 is UTC-5');
select is(timestamptz '2026-12-01 12:00+00' at time zone private.zone('Canada/Central'),
  timestamp '2026-12-01 07:00', 'the Canada/Central link name too');
select is(private.zone('America/Chicago'), 'America/Chicago', 'other zones pass through');

select tests.create_world();
select tests.as_postgres();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
update app.locations set tz = 'America/Winnipeg', day_boundary = interval '4 hours'
where id = tests.id('loc_a');
-- Tuesday 2026-12-01, 09:00-17:00 local, which is 14:00-22:00 UTC.
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 2, '09:00', '17:00');

select ok(private.location_open_at(tests.id('loc_a'), '2026-12-01 14:30+00'),
  '09:30 local is open');
select ok(not private.location_open_at(tests.id('loc_a'), '2026-12-01 22:30+00'),
  '17:30 local is closed (stale data would read 16:30, open)');
select is(private.location_next_change(tests.id('loc_a'), '2026-12-01 12:00+00'),
  timestamptz '2026-12-01 14:00+00', 'the day opens at 09:00 local');
select is(private.service_day(tests.id('loc_a'), '2026-12-02 09:30+00'),
  date '2026-12-02', '04:30 local on the 2nd starts the new service day');
select is(private.quiet_hours_end('2026-12-01 12:30+00', 'America/Winnipeg'),
  timestamptz '2026-12-01 13:00+00', 'quiet hours end at 08:00 local');

select * from finish();
rollback;
