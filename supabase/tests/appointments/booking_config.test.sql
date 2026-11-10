-- 2P-APT1 (#157): booking config constraints, membership check, audit. RLS itself is in the matrix.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();

-- AC3: slot_minutes check (as postgres, to isolate the constraint from RLS)
select tests.as_postgres();
select throws_ok(
  format($$insert into app.booking_policies (org_id, service_id, slot_minutes) values (%L, %L, 4)$$,
         tests.id('org_a'), tests.id('service_a2')),
  '23514', null, 'AC3: slot_minutes 4 is rejected');
select lives_ok(
  format($$insert into app.booking_policies (org_id, service_id, slot_minutes) values (%L, %L, 45)$$,
         tests.id('org_a'), tests.id('service_a2')),
  'AC3: slot_minutes 45 is accepted');
select throws_ok(
  format($$update app.booking_policies set slot_minutes = 20, slot_offset_minutes = 20 where service_id = %L$$,
         tests.id('service_a2')),
  '23514', null, 'offset must be smaller than the slot length');
select is((select version from app.booking_policies where service_id = tests.id('service_a2')), 1, 'version starts at 1');
select is((select location_id from app.booking_policies where service_id = tests.id('service_a2')), tests.id('loc_a'),
  'location_id is derived from the service');

-- AC4: availability for a user with no membership in the org is rejected
select throws_ok(
  format($$insert into app.availability_rules (org_id, location_id, staff_user_id, weekday, starts, ends)
           values (%L, %L, %L, 2, '09:00', '12:00')$$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('other_owner')),
  '23503', null, 'AC4: a non-member cannot own an availability rule');
select lives_ok(
  format($$insert into app.availability_rules (org_id, location_id, staff_user_id, weekday, starts, ends)
           values (%L, %L, %L, 2, '09:00', '12:00')$$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('staff')),
  'a member can');

-- AC2: staff cannot write, manager can
select tests.act_as('staff');
select throws_ok(
  format($$insert into app.availability_rules (org_id, location_id, weekday, starts, ends)
           values (%L, %L, 3, '09:00', '12:00')$$, tests.id('org_a'), tests.id('loc_a')),
  '42501', null, 'AC2: a staff member cannot insert an availability rule');
select tests.act_as('manager');
select lives_ok(
  format($$insert into app.availability_rules (org_id, location_id, weekday, starts, ends)
           values (%L, %L, 3, '09:00', '12:00')$$, tests.id('org_a'), tests.id('loc_a')),
  'AC2: a manager can');

-- AC5: audit_log records before and after for a capacity edit
select tests.act_as('admin');
update app.capacity_rules set capacity = 7 where id = tests.id('capacity_rule_a');
select tests.as_postgres();
select ok((select (before ->> 'capacity')::int = 2 and (after ->> 'capacity')::int = 7
           from app.audit_log where table_name = 'capacity_rules' and action = 'UPDATE'
             and row_id = tests.id('capacity_rule_a')::text),
  'AC5: audit_log holds before and after of a capacity change');

select * from finish();
rollback;
