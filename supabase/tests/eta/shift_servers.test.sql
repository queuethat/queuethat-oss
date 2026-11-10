-- 2B-ORG5 (#269): the ETA's server count from the shift schedule (private.eta_servers).
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.staff_shifts;
insert into app.queues (id, org_id, location_id, name, ticket_prefix, servers_on_duty)
values (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Shifts', 'S', 1);
select tests.new_visit('s' || i, 'queue_s') from generate_series(1, 4) i;

select is(private.eta_servers(tests.id('queue_s')), 1, 'without use_shift_schedule servers_on_duty is used');

update app.queues set use_shift_schedule = true where id = tests.id('queue_s');
insert into app.staff_shifts (org_id, location_id, user_id, during) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('staff'), tstzrange(now() - interval '1 hour', now() + interval '1 hour')),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('manager'), tstzrange(now() - interval '2 hours', now() + interval '2 hours'));
select is(private.eta_servers(tests.id('queue_s')), 2, 'AC4: two scheduled staff, servers = 2');
create temp table eta_shift as select eta_low, eta_high from private.visit_eta(tests.id('s4'));
update app.queues set use_shift_schedule = false, servers_on_duty = 2 where id = tests.id('queue_s');
select results_eq($$ select eta_low, eta_high from private.visit_eta(tests.id('s4')) $$, $$ select eta_low, eta_high from eta_shift $$,
  'AC4: the estimate equals servers_on_duty = 2');
update app.queues set use_shift_schedule = true, servers_on_duty = 1 where id = tests.id('queue_s');

-- A shift in the future does not count; with nobody on shift the fallback applies.
update app.staff_shifts set during = tstzrange(now() + interval '3 hours', now() + interval '5 hours');
select is(private.eta_servers(tests.id('queue_s')), 1, 'nobody on shift now falls back to servers_on_duty');
update app.queues set servers_on_duty = 0 where id = tests.id('queue_s');
select is((select eta_state::text from private.visit_eta(tests.id('s2'))), 'unstaffed', 'and servers_on_duty = 0 is still unstaffed');

select * from finish();
rollback;
