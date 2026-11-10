-- 2A-Q2 (#101): call_next honours service mapping and waiting-guest assignment.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

-- Chair 1 = counter_a, Chair 2 = counter_pair (fixtures). Colour is mapped only to Chair 2.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_m'), tests.id('org_a'), tests.id('loc_a'), 'Mapped', 'M');
insert into app.services (id, org_id, location_id, queue_id, name) values
  (tests.new_id('svc_colour'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_m'), 'Colour'),
  (tests.new_id('svc_cut'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_m'), 'Cut');
insert into app.service_resources (org_id, location_id, service_id, counter_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_colour'), tests.id('counter_pair'));
select tests.new_visit('m1', 'queue_m', 'Colour guest');
select tests.new_visit('m2', 'queue_m', 'Cut guest');
select tests.new_visit('m3', 'queue_m', 'Second cut');
update app.visits set service_id = tests.id('svc_colour') where id = tests.id('m1');
update app.visits set service_id = tests.id('svc_cut') where id in (tests.id('m2'), tests.id('m3'));
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5','k6','k7','k8','ka1','ka2','kt1']) k;

-- AC1: Chair 1 skips the Colour guest.
select tests.act_as('staff');
select is((api.call_next(tests.id('queue_m'), tests.id('counter_a'), tests.id('k1'))).id, tests.id('m2'),
  'AC1: Chair 1 skips the Colour guest and calls the next eligible one');
select is((select status::text from app.visits where id = tests.id('m1')), 'waiting',
  'the skipped Colour guest keeps waiting');
-- Chair 2 gets the Colour guest, who is first in line.
select is((api.call_next(tests.id('queue_m'), tests.id('counter_pair'), tests.id('k2'))).id, tests.id('m1'),
  'Chair 2 calls the Colour guest');

-- AC2: assignment to a person.
select tests.as_postgres();
select private.set_actor('system', null, 'requeue');
update app.visits set status = 'waiting', counter_id = null where id in (tests.id('m1'), tests.id('m2'));
select tests.act_as('manager');
select (api.assign_visit(tests.id('m3'), null, tests.id('manager'), (select version from app.visits where id = tests.id('m3')), tests.id('ka1'))).id;
select tests.act_as('staff');
select is((api.call_next(tests.id('queue_m'), tests.id('counter_a'), tests.id('k3'))).id, tests.id('m2'),
  'AC2: a guest assigned to the manager is not called by staff');
select tests.act_as('manager');
select is((api.call_next(tests.id('queue_m'), tests.id('counter_a'), tests.id('k4'))).id, tests.id('m3'),
  'AC2: the manager gets the guest assigned to them (ahead of the unassigned Colour guest they cannot serve at Chair 1)');

select tests.as_postgres();
-- Staff resource: a staff resource mapped to Colour and owned by the caller makes Colour eligible.
insert into app.counters (id, org_id, location_id, label, kind, member_user_id)
values (tests.new_id('res_staff'), tests.id('org_a'), tests.id('loc_a'), 'Sam', 'staff', tests.id('staff'));
insert into app.service_resources (org_id, location_id, service_id, counter_id)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('svc_colour'), tests.id('res_staff'));
select tests.act_as('staff');
select is((api.call_next(tests.id('queue_m'), tests.id('counter_a'), tests.id('k5'))).id, tests.id('m1'),
  'a staff resource owned by the caller and mapped to the service makes it eligible anywhere');

-- Counter-assigned guest.
select tests.as_postgres();
select tests.new_visit('m4', 'queue_m', 'For Chair 2');
select tests.act_as('staff');
select api.assign_visit(tests.id('m4'), tests.id('counter_pair'), null, 0, tests.id('ka2'));
select is(api.call_next(tests.id('queue_m'), tests.id('counter_a'), tests.id('k6')), null,
  'a guest assigned to Chair 2 is not called from Chair 1');
select is((api.call_next(tests.id('queue_m'), tests.id('counter_pair'), tests.id('k7'))).id, tests.id('m4'),
  'the guest assigned to Chair 2 is called from Chair 2');

-- Staff override via transition_visit records override=true.
select tests.as_postgres();
select private.set_actor('system', null, 'requeue');
update app.visits set status = 'waiting', counter_id = null where id = tests.id('m1');
delete from app.service_resources where counter_id = tests.id('res_staff');
select tests.act_as('staff');
select api.transition_visit(tests.id('m1'), 'call', (select version from app.visits where id = tests.id('m1')),
  tests.id('kt1'), tests.id('counter_a'));
select is((select (payload ->> 'override')::boolean from app.visit_events
           where visit_id = tests.id('m1') and type = 'call' order by id desc limit 1), true,
  'a hand call of an ineligible visit succeeds and records override = true');
select tests.as_postgres();
select is((select payload ? 'override' from app.visit_events
           where visit_id = tests.id('m2') and type = 'call' order by id desc limit 1), false,
  'an eligible call carries no override flag');

-- Cross-tenant: org B staff cannot call an org A queue.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_m')),
  'P0001', 'not_found', 'org B cannot call_next an org A queue');

select * from finish();
rollback;
