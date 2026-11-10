-- 4-APT1 (#385): recurring appointment series. Dates are derived from the next US DST change so the
-- test passes on any day of the year (the horizon is 365 days, a transition is at most 238 days away).
begin;
\ir ../helpers/_setup.psql
select plan(28);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
select tests.id('org_a'), tests.id('loc_a'), d, '09:00', '13:00' from generate_series(0, 6) d;
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60, max_days_ahead = 365
where service_id = tests.id('service_a');

create temp table ctx as
with off as (
  select d::date as d, extract(epoch from (d + time '10:00')) - extract(epoch from ((d + time '10:00') at time zone 'America/New_York')) as o
  from generate_series(current_date + 1, current_date + 400, interval '1 day') d
), t as (
  select min(d) as t from (select d, o, lag(o) over (order by d) as p from off) x where p is not null and o <> p
)
select greatest(current_date + 1, t - 21) as f, t from t;
grant select on ctx to public;
create temp table keys as select gen_random_uuid() dst, gen_random_uuid() conflict, gen_random_uuid() until_k, gen_random_uuid() cap;
grant select on keys to public;
create function pg_temp.at(p_date date, p_time time) returns timestamptz language sql as
  $$ select (p_date + p_time) at time zone 'America/New_York' $$;
grant execute on function pg_temp.at(date, time) to public;

-- a guest already holds the 11:00 slot two weeks in
select tests.act_as('staff');
select lives_ok(format($$ select api.staff_book_appointment(%L, %L, pg_temp.at(%L, '11:00'), null, 'Blocker', '+15551230100', null, 1, false, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('service_a'), (select f + 14 from ctx)), 'setup: the slot two weeks in is taken');

-- AC1: a weekly 10:00 series across the DST change is 10:00 local on every date
create temp table dst as
  select * from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '10:00', 1, 6, null, null,
    'Dana', '+15551230101', null, (select dst from keys));
grant select on dst to public;
select tests.as_postgres();
select is((select cardinality(booked) from dst), 6, 'AC1: all six weekly occurrences are booked');
select is((select count(distinct (starts_at at time zone 'America/New_York')::time)::int from app.appointments where series_id = (select series_id from dst)),
  1, 'AC1: every occurrence has the same local time');
select is((select min((starts_at at time zone 'America/New_York')::time) from app.appointments where series_id = (select series_id from dst)),
  time '10:00', 'AC1: and it is 10:00');
select is((select count(distinct extract(epoch from starts_at)::bigint % 86400)::int from app.appointments where series_id = (select series_id from dst)),
  2, 'AC1: the UTC time differs across the DST change (the series really crossed it)');
select is((select count(*)::int from app.appointments where series_id = (select series_id from dst) and source = 'staff' and guest_name = 'Dana'), 6,
  'occurrences are ordinary staff appointments with the series link');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = pg_temp.at((select f from ctx), '10:00')), 1,
  'each occurrence takes its own capacity');
select is((select (rule ->> 'weekday')::int from app.appointment_series where id = (select series_id from dst)),
  extract(dow from (select f from ctx))::int, 'the rule records the weekday');

-- AC2: the full date is a conflict, the rest are booked
select tests.act_as('staff');
create temp table cf as
  select * from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '11:00', 1, 6, null, null,
    'Casey', '+15551230102', null, (select conflict from keys));
grant select on cf to public;
select is((select cardinality(booked) from cf), 5, 'AC2: five dates are booked');
select is((select conflicts -> 0 ->> 'date' from cf), (select (f + 14)::text from ctx), 'AC2: the full date is returned as a conflict');
select is((select conflicts -> 0 ->> 'code' from cf), 'slot_full', 'AC2: with the reason');
select is((select count(*)::int from app.appointments where series_id = (select series_id from cf)), 5, 'AC2: only the free dates were booked');

-- repeating the call books nothing and returns the same answer
select is((select series_id from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '11:00', 1, 6, null, null,
    'Casey', '+15551230102', null, (select conflict from keys))), (select series_id from cf), 'a repeated key returns the same series');
select is((select count(*)::int from app.appointments where guest_name = 'Casey'), 5, 'and books nothing more');

-- until bounds the series; count is capped at 26 occurrences
select is((select cardinality(booked) from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '11:30', 1, null, (select f + 14 from ctx), null,
    'Uma', '+15551230103', null, (select until_k from keys))), 3, 'until ends the series on that date');
select is((select cardinality(booked) + jsonb_array_length(conflicts) from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '12:00', 1, 100, null, null,
    'Max', '+15551230104', null, (select cap from keys))), 26, 'a series never has more than 26 occurrences');
select throws_ok(format($$ select api.create_appointment_series(%L, %L, %L, '10:00', 0, 3, null, null, 'Bad', '+15551230105', null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('service_a'), (select f from ctx)), 'P0001', 'invalid_input', 'an interval of 0 weeks is invalid_input');
select throws_ok(format($$ select api.create_appointment_series(%L, %L, %L, '10:00', 1, null, null, null, 'Bad', '+15551230105', null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('service_a'), (select f from ctx)), 'P0001', 'invalid_input', 'a series needs a count or an end date');

-- cancel this and following
select is(api.cancel_series_from((select series_id from cf), (select f + 7 from ctx), gen_random_uuid()), 4, 'cancel_series_from cancels this and following');
select is(api.cancel_series_from((select series_id from cf), (select f + 7 from ctx), gen_random_uuid()), 0, 'repeating it cancels nothing');
select tests.as_postgres();
select is((select count(*)::int from app.appointments where series_id = (select series_id from cf) and status = 'booked'), 1, 'the earlier occurrence stays booked');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = pg_temp.at((select f + 7 from ctx), '11:00')), 0,
  'cancelled occurrences release their capacity');

-- a dry run lists the conflicts and keeps nothing
select tests.act_as('staff');
create temp table dry as
  select * from api.create_appointment_series(tests.id('loc_a'), tests.id('service_a'), (select f from ctx), '11:00', 1, 6, null, null,
    'Dry', '+15551230106', null, gen_random_uuid(), true);
grant select on dry to public;
select tests.as_postgres();
select is((select jsonb_array_length(conflicts) from dry), 2, 'dry run: both full dates are listed before confirming');
select is((select cardinality(booked) from dry), 4, 'dry run: and the four free dates would be booked');
select is((select count(*)::int from app.appointments where guest_name = 'Dry'), 0, 'dry run: nothing is booked');
select is((select series_id from dry), null, 'dry run: no series is kept');

-- AC3: another org sees and touches nothing
select tests.act_as('other_owner');
select is((select count(*)::int from app.appointment_series), 0, 'AC3: org B sees no org A series');
select throws_ok(format($$ select api.cancel_series_from(%L, %L, gen_random_uuid()) $$, (select series_id from dst), (select f from ctx)),
  'P0001', 'not_found', 'AC3: org B cannot cancel an org A series');
select * from finish();
rollback;
