-- S2 (#23): service day across 2026 DST transitions and the day boundary.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();

-- loc_a is America/New_York, loc_b is Europe/Berlin; both use the default 04:00 boundary.
create temp table fixture (loc text, at timestamptz, expected date, why text);
insert into fixture values
  ('loc_a', '2026-06-10 05:30Z', '2026-06-09', 'NY 01:30 EDT belongs to the previous day'),
  ('loc_a', '2026-06-10 07:59Z', '2026-06-09', 'NY 03:59 EDT is still the previous day'),
  ('loc_a', '2026-06-10 08:00Z', '2026-06-10', 'NY 04:00 EDT starts the new day'),
  ('loc_a', '2026-03-08 07:59Z', '2026-03-07', 'NY spring-forward day, 03:59 EDT'),
  ('loc_a', '2026-03-08 08:00Z', '2026-03-08', 'NY spring-forward day, 04:00 EDT'),
  ('loc_a', '2026-11-01 08:59Z', '2026-10-31', 'NY fall-back day, 03:59 EST'),
  ('loc_a', '2026-11-01 09:00Z', '2026-11-01', 'NY fall-back day, 04:00 EST'),
  ('loc_a', '2026-11-01 05:30Z', '2026-10-31', 'NY fall-back day, first 01:30 EDT'),
  ('loc_a', '2026-11-01 06:30Z', '2026-10-31', 'NY fall-back day, second 01:30 EST'),
  ('loc_b', '2026-03-29 01:59Z', '2026-03-28', 'Berlin spring-forward day, 03:59 CEST'),
  ('loc_b', '2026-03-29 02:00Z', '2026-03-29', 'Berlin spring-forward day, 04:00 CEST'),
  ('loc_b', '2026-10-25 02:59Z', '2026-10-24', 'Berlin fall-back day, 03:59 CET'),
  ('loc_b', '2026-10-25 03:00Z', '2026-10-25', 'Berlin fall-back day, 04:00 CET');

select is(private.service_day(tests.id(loc), at), expected, why) from fixture order by loc, at;

update app.locations set day_boundary = '0' where id = tests.id('loc_a');
select is(private.service_day(tests.id('loc_a'), '2026-06-10 03:59Z'), '2026-06-09'::date,
  'with a midnight boundary, 23:59 EDT is the same calendar day');
select is(private.service_day(tests.id('loc_a'), '2026-06-10 04:00Z'), '2026-06-10'::date,
  'with a midnight boundary, 00:00 EDT is the next calendar day');

select * from finish();
rollback;
