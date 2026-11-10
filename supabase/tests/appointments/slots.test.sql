-- 2P-APT2 (#158): slot computation, DST and the public listing function.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();

-- loc_a (New York): Monday 2026-12-21 is open 09:00-12:00; service_a lasts 20 minutes.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
delete from app.availability_exceptions;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 20, slot_offset_minutes = 10, min_notice_minutes = 0
where service_id = tests.id('service_a');

create function pg_temp.local_times(p_service text, p_from date, p_to date, p_now timestamptz, p_tz text)
returns text[] language sql as $$
  select coalesce(array_agg(to_char(slot_start at time zone p_tz, 'MM-DD HH24:MI') order by slot_start), '{}')
  from private.available_slots(tests.id(p_service), p_from, p_to, p_now)
$$;
create temp table now_ as select '2026-12-14 12:00Z'::timestamptz as t;

-- AC1: offset grid, nothing ends after closing
select is(pg_temp.local_times('service_a', '2026-12-21', '2026-12-21', (select t from now_), 'America/New_York'),
  array['12-21 09:10','12-21 09:30','12-21 09:50','12-21 10:10','12-21 10:30','12-21 10:50','12-21 11:10','12-21 11:30'],
  'AC1: 20-minute slots with offset 10 start at 09:10 and the last ends by 12:00');

-- AC2: date rule beats weekday rule beats the default
insert into app.capacity_rules (org_id, service_id, scope, weekday, capacity)
values (tests.id('org_a'), tests.id('service_a'), 'slot', 1, 2);
insert into app.capacity_rules (org_id, service_id, scope, local_date, capacity)
values (tests.id('org_a'), tests.id('service_a'), 'slot', '2026-12-21', 1);
select is((select min(remaining) from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', (select t from now_))),
  1, 'AC2: the date rule gives remaining 1');
select is((select min(remaining) from private.available_slots(tests.id('service_a'), '2026-12-28', '2026-12-28', (select t from now_))),
  2, 'AC2: other Mondays follow the weekday rule');

-- a day cap bounds the whole date
insert into app.capacity_rules (org_id, service_id, scope, local_date, capacity)
values (tests.id('org_a'), tests.id('service_a'), 'day', '2026-12-28', 3);
insert into app.appointment_day_counts (org_id, service_id, local_date, count) values (tests.id('org_a'), tests.id('service_a'), '2026-12-28', 3);
select is(pg_temp.local_times('service_a', '2026-12-28', '2026-12-28', (select t from now_), 'America/New_York'),
  '{}'::text[], 'a full day shows no slots');

-- slot counts reduce remaining
insert into app.appointment_slot_counts (org_id, service_id, slot_start, count)
values (tests.id('org_a'), tests.id('service_a'), '2026-12-21 14:10Z', 1); -- 09:10 local, cap 1: full
select ok(not exists (select 1 from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', (select t from now_))
                      where slot_start = '2026-12-21 14:10Z'), 'a full slot is not listed');
delete from app.appointment_slot_counts where slot_start = '2026-12-21 14:10Z';

-- AC3: buffer before 10 and the fixture booking at 10:00 local (15:00Z, 20 min)
update app.booking_policies set buffer_before_minutes = 10 where service_id = tests.id('service_a');
select ok(not exists (select 1 from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', (select t from now_))
                      where slot_start = '2026-12-21 14:50Z'), 'AC3: the 09:50 slot overlaps the buffer before 10:00');
select ok(exists (select 1 from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', (select t from now_))
                  where slot_start = '2026-12-21 14:30Z'), 'AC3: the 09:30 slot ends before the buffer');
update app.booking_policies set buffer_before_minutes = 0 where service_id = tests.id('service_a');

-- AC4: notice
update app.booking_policies set min_notice_minutes = 120 where service_id = tests.id('service_a');
select is((select min(slot_start) from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', '2026-12-21 14:00Z')),
  '2026-12-21 16:10Z'::timestamptz, 'AC4: at 09:00 local with 120 minutes notice the first slot is 11:10');
update app.booking_policies set min_notice_minutes = 0 where service_id = tests.id('service_a');

-- availability rules narrow the window; an unavailable exception removes it
insert into app.availability_rules (org_id, location_id, weekday, starts, ends)
values (tests.id('org_a'), tests.id('loc_a'), 1, '10:00', '11:00');
select is(pg_temp.local_times('service_a', '2026-12-21', '2026-12-21', (select t from now_), 'America/New_York'),
  array['12-21 10:10','12-21 10:30'], 'availability rules narrow the bookable window');
insert into app.availability_exceptions (org_id, location_id, local_date, kind) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-21', 'unavailable');
select is(pg_temp.local_times('service_a', '2026-12-21', '2026-12-21', (select t from now_), 'America/New_York'),
  '{}'::text[], 'a whole-day exception removes every slot');
delete from app.availability_exceptions; delete from app.availability_rules;

-- not bookable / suspended org
update app.booking_policies set bookable = false where service_id = tests.id('service_a');
select is_empty($$ select * from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', '2026-12-14 12:00Z') $$,
  'a service that is not bookable has no slots');
update app.booking_policies set bookable = true where service_id = tests.id('service_a');
update app.organizations set status = 'suspended' where id = tests.id('org_a');
select is_empty($$ select * from private.available_slots(tests.id('service_a'), '2026-12-21', '2026-12-21', '2026-12-14 12:00Z') $$,
  'a suspended org has no slots');
update app.organizations set status = 'active' where id = tests.id('org_a');

-- AC5: Berlin DST days (loc_b / org B)
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'B', 'B');
insert into app.services (id, org_id, location_id, queue_id, name, expected_minutes)
values (tests.new_id('service_b'), tests.id('org_b'), tests.id('loc_b'), tests.id('queue_b'), 'Cut', 30);
insert into app.booking_policies (org_id, service_id, bookable, slot_minutes, min_notice_minutes) values (tests.id('org_b'), tests.id('service_b'), true, 30, 0);
insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values
  (tests.id('org_b'), tests.id('loc_b'), '2026-03-29', false, '01:00', '05:00'),
  (tests.id('org_b'), tests.id('loc_b'), '2026-10-25', false, '01:00', '05:00');
select is(pg_temp.local_times('service_b', '2026-03-29', '2026-03-29', '2026-03-01 00:00Z', 'Europe/Berlin'),
  array['03-29 01:00','03-29 01:30','03-29 03:00','03-29 03:30','03-29 04:00','03-29 04:30'],
  'AC5: spring forward skips the non-existent 02:00 hour');
select is((select count(distinct slot_start)::int from private.available_slots(tests.id('service_b'), '2026-10-25', '2026-10-25', '2026-10-01 00:00Z')), 10,
  'AC5: fall back yields 10 distinct instants, the repeated hour twice');
select is((pg_temp.local_times('service_b', '2026-10-25', '2026-10-25', '2026-10-01 00:00Z', 'Europe/Berlin'))[3:6],
  array['10-25 02:00','10-25 02:30','10-25 02:00','10-25 02:30'], 'AC5: both 02:00 hours are listed once each');

-- AC6 / AC7 and the public function
select tests.act_as('other_owner');
select is((select count(*)::int from app.appointments), 0, 'AC6: org B sees no org A appointments');
select tests.as_anon();
select throws_ok($$ select * from app.appointments $$, '42501', null, 'AC6: anon cannot read appointments');
select throws_ok(format($$ select * from api.get_available_slots('demo-barber', %L, '2026-12-01', '2027-01-15') $$, tests.id('service_a')),
  'P0001', 'range_too_large', 'AC7: more than 31 days is refused');

select * from finish();
rollback;
