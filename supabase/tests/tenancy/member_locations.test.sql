-- 2B-ORG1 (#265): api.set_member_locations, and that a restricted member sees nothing of other locations.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5','k6','k7']) k;
insert into tests.ids (name, id)
select 'm_' || x, id from app.memberships, unnest(array['owner','staff','manager']) x
where org_id = tests.id('org_a') and user_id = tests.id(x);

-- A second location of org A with a queue, a counter, a visit and a device.
insert into app.locations (id, org_id, name, slug, tz) values
  (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'second-' || gen_random_uuid(), 'UTC');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a2'), 'B line', 'B');
insert into app.counters (org_id, location_id, label) values (tests.id('org_a'), tests.id('loc_a2'), 'B chair');
insert into app.devices (org_id, location_id, kind, name) values (tests.id('org_a'), tests.id('loc_a2'), 'display', 'B tv');
select tests.new_visit('visit_a2', 'queue_a2');

-- Owner restricts staff to location A.
select tests.act_as('owner');
select is((select location_ids from api.set_member_locations(tests.id('m_staff'), array[tests.id('loc_a')], tests.id('k1'))),
  array[tests.id('loc_a')], 'the owner restricts staff to location A');
select is((select location_ids from api.set_member_locations(tests.id('m_staff'), array[tests.id('loc_a')], tests.id('k1'))),
  array[tests.id('loc_a')], 'a repeated key returns the same result');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where table_name = 'memberships' and action = 'UPDATE'
             and row_id = tests.id('m_staff')::text and (after ->> 'location_ids') is not null), 1, 'the change is audited');

-- AC1: the restricted member sees nothing of location B.
select tests.act_as('staff');
select is((select count(*)::int from app.visits where location_id = tests.id('loc_a2')), 0, 'AC1: no visits of B');
select is((select count(*)::int from app.queues where location_id = tests.id('loc_a2')), 0, 'AC1: no queues of B');
select is((select count(*)::int from app.counters where location_id = tests.id('loc_a2')), 0, 'AC1: no counters of B');
select is((select count(*)::int from app.devices where location_id = tests.id('loc_a2')), 0, 'AC1: no devices of B');
select is((select count(*)::int from app.notifications n where n.visit_id = tests.id('visit_a2')), 0, 'AC1: no notifications of B visits');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 1, %L) $$, tests.id('visit_a2'), tests.id('k2')),
  'P0001', 'not_found', 'AC1: transition_visit on a B visit is not_found');
select is((select count(*)::int from app.visits where location_id = tests.id('loc_a')), 1, 'while location A is still visible');

-- AC2: a manager is denied.
select tests.act_as('manager');
select throws_ok(format($$ select api.set_member_locations(%L, null, %L) $$, tests.id('m_staff'), tests.id('k3')),
  '42501', 'permission_denied', 'AC2: a manager cannot assign locations');

-- AC3: a location of org B.
select tests.act_as('owner');
select throws_ok(format($$ select api.set_member_locations(%L, array[%L::uuid], %L) $$, tests.id('m_staff'), tests.id('loc_b'), tests.id('k4')),
  'P0001', 'invalid_location', 'AC3: a location of another org is invalid_location');
select throws_ok(format($$ select api.set_member_locations(%L, null, %L) $$, tests.id('m_owner'), tests.id('k5')),
  'P0001', 'forbidden_role', 'an owner cannot change their own locations');

select * from finish();
rollback;
