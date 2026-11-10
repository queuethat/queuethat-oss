-- #89 (2A-ORG1): private.location_open_at / location_next_change across midnight, DST and exceptions.
begin;
\ir ../helpers/_setup.psql
select plan(9);

select tests.create_world();
select tests.as_postgres();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

-- AC2: Friday 18:00-02:00 in Europe/Berlin.
update app.locations set tz = 'Europe/Berlin' where id = tests.id('loc_a');
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 5, '18:00', '02:00');
select ok(private.location_open_at(tests.id('loc_a'), '2026-10-31 01:30 Europe/Berlin'),
  'AC2: Saturday 01:30 local is inside Friday''s cross-midnight interval');
select ok(not private.location_open_at(tests.id('loc_a'), '2026-10-31 02:30 Europe/Berlin'),
  'AC2: Saturday 02:30 local is closed');
select is(private.location_next_change(tests.id('loc_a'), '2026-10-31 01:30 Europe/Berlin'),
  '2026-10-31 02:00 Europe/Berlin'::timestamptz, 'next change from inside is the close, on Saturday');
select is(private.location_next_change(tests.id('loc_a'), '2026-10-31 02:30 Europe/Berlin'),
  '2026-11-06 18:00 Europe/Berlin'::timestamptz, 'next change from closed is next Friday''s opening');

-- AC3: America/New_York, Sunday 01:00-04:00 on the spring-forward (2026-03-08) and fall-back (2026-11-01) days.
update app.locations set tz = 'America/New_York' where id = tests.id('loc_a');
delete from app.business_hours where location_id = tests.id('loc_a');
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 0, '01:00', '04:00');

select is_empty($$
  select t from generate_series('2026-03-08 04:00+00'::timestamptz, '2026-03-08 10:00+00', interval '15 minutes') t
  where (private.location_open_at(tests.id('loc_a'), t), private.location_next_change(tests.id('loc_a'), t))
    is distinct from (
      t >= '2026-03-08 06:00+00' and t < '2026-03-08 08:00+00',   -- 01:00 EST to 04:00 EDT: two real hours
      case when t < '2026-03-08 06:00+00' then '2026-03-08 06:00+00'
           when t < '2026-03-08 08:00+00' then '2026-03-08 08:00+00'
           else '2026-03-15 05:00+00' end::timestamptz)
$$, 'AC3: spring forward, every 15 minutes matches the fixture');

select is_empty($$
  select t from generate_series('2026-11-01 03:00+00'::timestamptz, '2026-11-01 11:00+00', interval '15 minutes') t
  where (private.location_open_at(tests.id('loc_a'), t), private.location_next_change(tests.id('loc_a'), t))
    is distinct from (
      t >= '2026-11-01 05:00+00' and t < '2026-11-01 09:00+00',   -- 01:00 EDT to 04:00 EST: four real hours
      case when t < '2026-11-01 05:00+00' then '2026-11-01 05:00+00'
           when t < '2026-11-01 09:00+00' then '2026-11-01 09:00+00'
           else '2026-11-08 06:00+00' end::timestamptz)
$$, 'AC3: fall back, every 15 minutes matches the fixture');

-- Exceptions override the weekly pattern.
insert into app.hours_exceptions (org_id, location_id, date, closed)
values (tests.id('org_a'), tests.id('loc_a'), '2026-11-08', true);
select ok(not private.location_open_at(tests.id('loc_a'), '2026-11-08 02:00 America/New_York'),
  'a closed_all_day exception overrides the weekly hours');
select is(private.location_next_change(tests.id('loc_a'), '2026-11-07 12:00 America/New_York'),
  '2026-11-15 01:00 America/New_York'::timestamptz, 'next change skips the closed day');

-- AC4: a closed_all_day exception for today stops an anon join during normal hours.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
select tests.id('org_a'), tests.id('loc_a'), d, '00:00', '23:59' from generate_series(0, 6) d;
insert into app.hours_exceptions (org_id, location_id, date, closed)
values (tests.id('org_a'), tests.id('loc_a'),
        (now() at time zone 'America/New_York')::date, true);
select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'Bo', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'AC4: anon joining on a closed_all_day exception date is rejected');

select * from finish();
rollback;
