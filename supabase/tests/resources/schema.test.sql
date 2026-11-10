-- 2A-Q1 (#100): resource kinds, staff resources, service mapping, assigned_counter_id.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

select is((select kind::text from app.counters where id = tests.id('counter_a')), 'counter',
  'phase-1 counters default to kind counter');
select ok((select active and seats is null and member_user_id is null
           from app.counters where id = tests.id('counter_a')),
  'phase-1 counters are active with no seats or member');

-- AC1: a staff resource must point at a member of the location.
select throws_ok(
  format($$ insert into app.counters (org_id, location_id, label, kind, member_user_id)
            values (%L, %L, 'Dana', 'staff', %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('other_owner')),
  'P0001', 'invalid_input', 'a staff resource for a non-member is rejected');
select throws_ok(
  format($$ insert into app.counters (org_id, location_id, label, kind) values (%L, %L, 'Dana', 'staff') $$,
         tests.id('org_a'), tests.id('loc_a')),
  'P0001', 'invalid_input', 'a staff resource needs a member_user_id');
select lives_ok(
  format($$ insert into app.counters (org_id, location_id, label, kind, member_user_id)
            values (%L, %L, 'Sam', 'staff', %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('staff')),
  'a staff resource for a member of the location is accepted');
update app.memberships set location_ids = array[tests.id('loc_b')] where user_id = tests.id('staff');
select throws_ok(
  format($$ insert into app.counters (org_id, location_id, label, kind, member_user_id)
            values (%L, %L, 'Sam 2', 'staff', %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('staff')),
  'P0001', 'invalid_input', 'a member whose membership does not cover the location is rejected');

-- AC2: cross-tenant mapping is rejected.
select tests.act_as('other_owner');
select throws_ok(
  format($$ insert into app.service_resources (org_id, location_id, service_id, counter_id) values (%L, %L, %L, %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('counter_pair')),
  '42501', null, 'a manager of org B cannot map an org A service (RLS)');
select tests.as_postgres();
select throws_ok(
  format($$ insert into app.service_resources (org_id, location_id, service_id, counter_id) values (%L, %L, %L, %L) $$,
         tests.id('org_b'), tests.id('loc_a'), tests.id('service_a'), tests.id('counter_pair')),
  '23503', null, 'the composite foreign key rejects a cross-org mapping');

-- Same-location rule.
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'UTC');
insert into app.counters (id, org_id, location_id, label)
values (tests.new_id('counter_a2'), tests.id('org_a'), tests.id('loc_a2'), 'Elsewhere');
select throws_ok(
  format($$ insert into app.service_resources (org_id, location_id, service_id, counter_id) values (%L, %L, %L, %L) $$,
         tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('counter_a2')),
  '23503', null, 'a service cannot map to a resource at another location');

-- Audit trail.
select is((select count(*)::int from app.audit_log
           where table_name = 'service_resources' and action = 'INSERT' and org_id = tests.id('org_a')),
  1, 'mapping inserts are audited');

-- assigned_counter_id is composite-FK'd to the visit's location.
select throws_ok(
  format($$ update app.visits set assigned_counter_id = %L where id = %L $$,
         tests.id('counter_a2'), tests.id('visit_a')),
  '23503', null, 'a visit cannot be assigned to a counter at another location');

select * from finish();
rollback;
