-- Extension hooks, part 4: the month a deployment allows no more bookings in. The hook does nothing
-- here; a deployment that replaces its body removes that month from api.get_available_slots.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

-- loc_a (New York) is open Mondays 09:00-12:00; service_a lasts 20 minutes.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
delete from app.availability_exceptions;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 20, min_notice_minutes = 0, max_days_ahead = 120 where service_id = tests.id('service_a');

select function_returns('private', 'ext_booking_month_full', array['uuid', 'date'], 'boolean',
  'ext_booking_month_full(uuid, date) returns boolean');
select is(private.ext_booking_month_full(tests.id('loc_a'), '2026-12-01'), false, 'it allows every month here');

-- a range over two months: Monday 2026-12-28 and Monday 2027-01-04
select tests.as_anon();
select is((select count(distinct (slot_start at time zone 'America/New_York')::date)::int
           from api.get_available_slots('test-location-a', tests.id('service_a'), '2026-12-28', '2027-01-05')),
  2, 'both Mondays are listed while the hook says no');

select tests.as_postgres();
create or replace function private.ext_booking_month_full(p_location_id uuid, p_month date) returns boolean
language sql stable set search_path = '' as $$ select p_location_id = tests.id('loc_a') and p_month = date '2026-12-01' $$;
select tests.as_anon();
select is((select array_agg(d order by d) from (select distinct (slot_start at time zone 'America/New_York')::date d
           from api.get_available_slots('test-location-a', tests.id('service_a'), '2026-12-28', '2027-01-05')) x),
  array['2027-01-04'::date], 'a month the hook calls full lists no slot, the other month is unaffected');
select tests.as_postgres();
create or replace function private.ext_booking_month_full(p_location_id uuid, p_month date) returns boolean
language sql stable set search_path = '' as $$ select true $$;
select tests.as_anon();
select is((select count(*)::int from api.get_available_slots('test-location-a', tests.id('service_a'), '2026-12-28', '2027-01-05')),
  0, 'a deployment that calls every month full lists nothing');

select * from finish();
rollback;
