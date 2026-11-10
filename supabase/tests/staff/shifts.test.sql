-- 2B-ORG5 (#269): app.staff_shifts and api.list_shifts.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();
update app.locations set tz = 'Europe/Berlin', day_boundary = '04:00' where id = tests.id('loc_a');
delete from app.staff_shifts;

insert into app.staff_shifts (org_id, location_id, user_id, during, note) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('staff'), tstzrange('2026-06-10 20:00+00', '2026-06-11 00:00+00'), 'late'),  -- 22:00-02:00 local
  (tests.id('org_a'), tests.id('loc_a'), tests.id('manager'), tstzrange('2026-03-28 22:00+00', '2026-03-29 06:00+00'), 'dst'), -- spans the 2026-03-29 change
  (tests.id('org_a'), tests.id('loc_a'), tests.id('admin'), tstzrange('2026-06-12 07:00+00', '2026-06-12 15:00+00'), null);

select tests.act_as('staff');
-- AC1
select is((select count(*)::int from api.list_shifts(tests.id('loc_a'), '2026-06-10', '2026-06-11') where note = 'late'), 1,
  'AC1: a 22:00-02:00 shift is listed once');
select is((select service_day from api.list_shifts(tests.id('loc_a'), '2026-06-10', '2026-06-12') where note = 'late'), '2026-06-10'::date,
  'AC1: on the service day it starts, although it ends after midnight');
select is((select count(*)::int from api.list_shifts(tests.id('loc_a'), '2026-06-11', '2026-06-11') where note = 'late'), 0,
  'AC1: not again on the next day');
-- AC2
select is((select (ends_at - starts_at)::text from api.list_shifts(tests.id('loc_a'), '2026-03-28', '2026-03-28') where note = 'dst'), '08:00:00',
  'AC2: the DST night is 8 real hours');
select is((select extract(epoch from (ends_at at time zone 'Europe/Berlin') - (starts_at at time zone 'Europe/Berlin'))::int / 3600
           from api.list_shifts(tests.id('loc_a'), '2026-03-28', '2026-03-28') where note = 'dst'), 9,
  'AC2: while the wall clock difference is 9 hours');
-- AC3
select tests.act_as('manager');
select throws_ok(format($$ insert into app.staff_shifts (org_id, location_id, user_id, during)
  values (%L, %L, %L, tstzrange('2026-06-10 23:00+00', '2026-06-11 03:00+00')) $$,
  tests.id('org_a'), tests.id('loc_a'), tests.id('staff')), '23P01', null, 'AC3: overlapping shifts of one person are refused');
select lives_ok(format($$ insert into app.staff_shifts (org_id, location_id, user_id, during)
  values (%L, %L, %L, tstzrange('2026-06-11 00:00+00', '2026-06-11 03:00+00')) $$,
  tests.id('org_a'), tests.id('loc_a'), tests.id('staff')), 'back-to-back shifts are fine (upper bound exclusive)');
-- AC5
select tests.act_as('other_owner');
select is((select count(*)::int from app.staff_shifts), 0, 'AC5: org B sees no shifts');
select throws_ok(format($$ select * from api.list_shifts(%L, '2026-06-10', '2026-06-11') $$, tests.id('loc_a')),
  'P0001', 'not_found', 'AC5: and list_shifts of a foreign location is not_found');

select * from finish();
rollback;
