-- #89 (2A-ORG1): hours cannot be saved ambiguous.
begin;
\ir ../helpers/_setup.psql
select plan(17);

select tests.create_world();
select tests.as_postgres();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');


select tests.act_as('owner');
select lives_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 5, '18:00', '02:00') $$, 'Friday 18:00-02:00 saves');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 6, '01:00', '05:00') $$, 'P0001', 'hours_overlap',
  'AC1: Saturday 01:00-05:00 overlaps the Friday interval that spills past midnight');
select lives_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 6, '02:00', '05:00') $$, 'an interval starting when the spill ends is fine');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 5, '20:00', '21:00') $$, 'P0001', 'hours_overlap',
  'an interval inside another on the same day overlaps');
select lives_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 6, '23:00', '03:00') $$, 'Saturday 23:00 into Sunday saves');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 0, '02:00', '04:00') $$, 'P0001', 'hours_overlap',
  'Sunday 02:00 overlaps the Saturday spill');
select lives_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 0, '03:00', '04:00') $$, 'Sunday 03:00 starts as the spill ends');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '09:00') $$, 'P0001', 'hours_invalid',
  'opens = closes is rejected');
select lives_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 2, '08:00', '09:00'); insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 2, '10:00', '11:00');
                   insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 2, '12:00', '13:00') $$, 'three intervals a day save');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 2, '14:00', '15:00') $$, 'P0001', 'hours_too_many',
  'a fourth interval on a day is rejected');
select throws_ok($$ update app.business_hours set opens = '01:00' where weekday = 6 and opens = '02:00' $$,
  'P0001', 'hours_overlap', 'an update into an overlap is rejected too (Saturday 02:00 moved to 01:00 meets the Friday spill)');

select lives_ok($$ insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-24', false, '09:00', '13:00') $$, 'special hours save');
select throws_ok($$ insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-24', true, null, null) $$, 'P0001', 'hours_overlap',
  'a closed day cannot share a date with special hours');
select throws_ok($$ insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-24', false, '12:00', '14:00') $$, 'P0001', 'hours_overlap',
  'special-hours intervals of a date cannot overlap');
select lives_ok($$ insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-25', true, null, null) $$, 'a closed_all_day exception saves');
select throws_ok($$ insert into app.hours_exceptions (org_id, location_id, date, closed, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), '2026-12-25', true, null, null) $$, 'P0001', 'hours_overlap',
  'one row set per (location, date)');

select tests.act_as('other_owner');
select throws_ok($$ insert into app.business_hours (org_id, location_id, weekday, opens, closes)
  values (tests.id('org_a'), tests.id('loc_a'), 3, '09:00', '17:00') $$, '42501', null,
  'AC5: another org''s owner cannot insert hours for an org A location');

select * from finish();
rollback;
