-- DS-14 (#1018): api.org_setup_state.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();
select tests.as_postgres();
delete from app.business_hours where location_id = tests.id('loc_a');
-- Visits are never deleted (I-1), so the fixture visit stays; queues are archived instead.
update app.queues set archived_at = now() where location_id = tests.id('loc_a');
insert into app.locations (id, org_id, name, slug, tz)
  values (tests.new_id('loc_new'), tests.id('org_a'), 'New place', 'setup-state-new', 'America/New_York');
delete from app.devices where location_id = tests.id('loc_a');
delete from app.invitations where org_id = tests.id('org_a');

select tests.act_as('owner');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_hours, false, 'no hours yet');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_queue, false, 'no queue yet');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_visit, true, 'the fixture visit counts');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_new'))).has_visit, false, 'a brand new location has no visit');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).devices, 0, 'no devices yet');
select cmp_ok((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).members, '>=', 1, 'the fixture members count');

select tests.as_postgres();
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
  values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '17:00');
insert into app.queues (org_id, location_id, name) values (tests.id('org_a'), tests.id('loc_a'), 'Main');
insert into app.invitations (org_id, email, role, token_hash)
  values (tests.id('org_a'), 'pending@example.test', 'staff', '\x01'),
         (tests.id('org_a'), 'expired@example.test', 'staff', '\x02');
update app.invitations set expires_at = now() - interval '1 day' where email = 'expired@example.test';

select tests.act_as('manager');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_hours, true, 'hours saved');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_queue, true, 'queue exists, a manager may ask');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).pending_invitations, 1,
  'only the live invitation counts, not the expired one');

select tests.as_postgres();
update app.queues set archived_at = now() where location_id = tests.id('loc_a');
select tests.act_as('owner');
select is((api.org_setup_state(tests.id('org_a'), tests.id('loc_a'))).has_queue, false, 'an archived queue does not count');

-- Role check: below manager, devices and anon are refused.
select tests.act_as('staff');
select throws_ok($$ select api.org_setup_state(tests.id('org_a'), tests.id('loc_a')) $$, 'P0001', 'not_found', 'staff are refused');
select tests.as_anon();
select throws_ok($$ select api.org_setup_state(tests.id('org_a'), tests.id('loc_a')) $$, '42501', null, 'anon cannot execute it');

-- Cross-tenant: another org's owner learns nothing, with the same error as a missing location.
select tests.act_as('other_owner');
select throws_ok($$ select api.org_setup_state(tests.id('org_a'), tests.id('loc_a')) $$, 'P0001', 'not_found', 'cross-tenant: org B owner is refused');
select throws_ok($$ select api.org_setup_state(tests.id('org_b'), tests.id('loc_a')) $$, 'P0001', 'not_found', 'cross-tenant: own org id with a foreign location is refused');

select * from finish();
rollback;
