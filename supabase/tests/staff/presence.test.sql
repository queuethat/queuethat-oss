-- 2B-S1 (#271): api.set_my_presence and presence in the ETA.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5','k6','k7']) k;
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.staff_presence;
insert into app.queues (id, org_id, location_id, name, ticket_prefix, servers_on_duty)
values (tests.new_id('queue_p'), tests.id('org_a'), tests.id('loc_a'), 'Presence', 'P', 1);
select tests.new_visit('p' || i, 'queue_p') from generate_series(1, 6) i;

-- Nobody reported: the fallback.
select is(private.eta_servers(tests.id('queue_p')), 1, 'without presence servers_on_duty is used');

select tests.act_as('staff');
select is((api.set_my_presence(tests.id('loc_a'), 'available', null, tests.id('k1'))).status, 'available', 'staff set presence');
select tests.act_as('manager');
select is((api.set_my_presence(tests.id('loc_a'), 'available', null, tests.id('k2'))).status, 'available', 'a second person sets presence');
select tests.as_postgres();
select is(private.eta_servers(tests.id('queue_p')), 2, 'two available staff');
create temp table eta2 as select eta_low, eta_high from private.visit_eta(tests.id('p6'));

-- AC1: one goes on break, the estimate widens.
select tests.act_as('manager');
select is((api.set_my_presence(tests.id('loc_a'), 'break', null, tests.id('k3'))).status, 'break', 'one goes on break');
select tests.as_postgres();
select ok((select eta_high from private.visit_eta(tests.id('p6'))) > (select eta_high from eta2), 'AC1: the estimate for waiting guests widens');

-- AC2: all on break.
select tests.act_as('staff');
select api.set_my_presence(tests.id('loc_a'), 'break', null, tests.id('k4'));
select tests.as_postgres();
select is((select eta_state::text from private.visit_eta(tests.id('p3'))), 'unstaffed', 'AC2: everyone on break is unstaffed');

-- Stale presence counts as away; with nothing fresh the fallback returns.
update app.staff_presence set updated_at = now() - interval '13 hours', status = 'available';
select is(private.eta_servers(tests.id('queue_p')), 1, 'presence older than 12 hours is ignored');

-- Idempotency and validation.
select tests.act_as('staff');
select is((api.set_my_presence(tests.id('loc_a'), 'away', null, tests.id('k5'))).status, 'away', 'away');
select is((api.set_my_presence(tests.id('loc_a'), 'available', null, tests.id('k5'))).status, 'away', 'a repeated key returns the first result');
select throws_ok(format($$ select api.set_my_presence(%L, 'lunch', null, %L) $$, tests.id('loc_a'), tests.id('k6')),
  'P0001', 'invalid_input', 'an unknown status is rejected');

-- AC3: cross tenant.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.set_my_presence(%L, 'available', null, %L) $$, tests.id('loc_a'), tests.id('k7')),
  'P0001', 'not_found', 'AC3: org B is denied');

select * from finish();
rollback;
