-- 2B-A11 (#286): a block takes slots off the booking page (and out of booking) while every resource
-- that could do the service is blocked.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

-- loc_a (New York): Monday 2026-12-21 is open 09:00-12:00; service_a lasts 20 minutes, hourly-ish slots.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
delete from app.availability_exceptions;
delete from app.time_blocks;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 60, slot_offset_minutes = 0, min_notice_minutes = 0
where service_id = tests.id('service_a');
-- service_a is mapped to counter_a (Chair 1) only.
delete from app.service_resources where service_id = tests.id('service_a');
insert into app.service_resources (org_id, location_id, service_id, counter_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('counter_a'));

create function pg_temp.local_times(p_now timestamptz) returns text[] language sql as $$
  select coalesce(array_agg(to_char(slot_start at time zone 'America/New_York', 'HH24:MI') order by slot_start), '{}')
  from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', p_now)
$$;
create temp table now_ as select '2026-12-14 12:00Z'::timestamptz as t;

select is(pg_temp.local_times((select t from now_)), array['09:00', '10:00', '11:00'], 'without blocks: three hourly slots');

-- Block Chair 1 from 10:00 to 11:00 New York (15:00Z-16:00Z in December).
insert into app.time_blocks (org_id, location_id, counter_id, during)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('counter_a'), tstzrange('2026-12-21 15:00Z', '2026-12-21 16:00Z'));
select is(pg_temp.local_times((select t from now_)), array['09:00', '11:00'],
  'AC1: the blocked hour is gone from the booking page');
select is((select count(*)::int from private.slot_candidates(tests.id('service_a'), '2026-12-21', '2026-12-21', (select t from now_), true)
           where slot_start = '2026-12-21 15:00Z'), 0, 'a staff override of capacity does not bring a blocked slot back');

-- A block on a resource the service is not mapped to changes nothing.
insert into app.time_blocks (org_id, location_id, counter_id, during)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('counter_pair'), tstzrange('2026-12-21 14:00Z', '2026-12-21 15:00Z'));
select is(pg_temp.local_times((select t from now_)), array['09:00', '11:00'], 'a block on an unrelated resource hides nothing');

-- With a second mapped resource free at 10:00 the slot comes back; blocking it too hides the slot again.
insert into app.service_resources (org_id, location_id, service_id, counter_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('counter_pair'));
select is(pg_temp.local_times((select t from now_)), array['09:00', '10:00', '11:00'],
  'another mapped resource still free: the slot stays bookable');
insert into app.time_blocks (org_id, location_id, counter_id, during)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('counter_pair'), tstzrange('2026-12-21 15:00Z', '2026-12-21 16:00Z'));
select is(pg_temp.local_times((select t from now_)), array['09:00', '11:00'], 'every mapped resource blocked: the slot is hidden');

select * from finish();
rollback;
