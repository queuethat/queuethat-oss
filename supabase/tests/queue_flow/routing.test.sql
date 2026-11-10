-- 2B-Q4 (#229): routing rules pick the queue of a location-level join.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('q_pass'), tests.id('org_a'), tests.id('loc_a'), 'Passport', 'P'),
  (tests.new_id('q_lic'), tests.id('org_a'), tests.id('loc_a'), 'Licence', 'L'),
  (tests.new_id('q_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B', 'B');
insert into app.services (id, org_id, location_id, queue_id, name) values
  (tests.new_id('s_pass'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_pass'), 'Passport'),
  (tests.new_id('s_lic'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_lic'), 'Licence'),
  (tests.new_id('s_none'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_pass'), 'Unrouted');
insert into app.routing_rules (id, org_id, location_id, rank, service_id, target_queue_id) values
  (tests.new_id('r_pass'), tests.id('org_a'), tests.id('loc_a'), 1, tests.id('s_pass'), tests.id('q_pass')),
  (tests.new_id('r_lic'), tests.id('org_a'), tests.id('loc_a'), 2, tests.id('s_lic'), tests.id('q_lic'));

create function tests.rjoin(p_name text, p_service text, p_queue text default null) returns text language sql as $$
  select api.join_queue(case when p_queue is null then null else tests.id(p_queue) end,
    case when p_service is null then null else tests.id(p_service) end, p_name, null, null, 1, 'en', gen_random_uuid(),
    null, null, '{}', null, null, tests.id('loc_a'))::text
$$;
grant execute on function tests.rjoin(text, text, text) to service_role;

select tests.as_service();
select tests.rjoin('Pat', 's_pass');
select tests.rjoin('Lee', 's_lic');
select tests.as_postgres();
select is((select q.name from app.visits v join app.queues q on q.id = v.queue_id where v.guest_name = 'Lee'), 'Licence',
  'AC1: service Licence lands in the Licence queue');
select is((select q.name from app.visits v join app.queues q on q.id = v.queue_id where v.guest_name = 'Pat'), 'Passport',
  'and Passport in the Passport queue');
select is((select payload ->> 'routing_rule_id' from app.visit_events e join app.visits v on v.id = e.visit_id
           where v.guest_name = 'Lee' and e.type = 'joined'), tests.id('r_lic')::text, 'the joined event names the routing rule');

-- AC2: Q-17 holds through routing
update app.queues set manual_state = 'closed' where id = tests.id('q_lic');
select tests.as_service();
select throws_ok($$ select tests.rjoin('Closed', 's_lic') $$, 'P0001', 'queue_not_accepting', 'AC2: a closed target queue refuses');
select tests.as_postgres();
update app.queues set manual_state = 'open' where id = tests.id('q_lic');

-- AC3: no rule
select tests.as_service();
select throws_ok($$ select tests.rjoin('Nobody', 's_none') $$, 'P0001', 'no_route', 'AC3: no matching rule raises no_route');
select throws_ok($$ select tests.rjoin('Nobody', null) $$, 'P0001', 'no_route', 'and so does no service');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'Nobody'), 0, 'AC3: nothing was created');

-- inactive rule and rank
update app.routing_rules set active = false where id = tests.id('r_lic');
select tests.as_service();
select throws_ok($$ select tests.rjoin('Off', 's_lic') $$, 'P0001', 'no_route', 'an inactive rule does not route');
select tests.as_postgres();

-- AC4: cross tenant FK
select throws_ok(format($$ insert into app.routing_rules (org_id, location_id, target_queue_id) values (%L, %L, %L) $$,
  tests.id('org_a'), tests.id('loc_a'), tests.id('q_b')), '23503', null, 'AC4: a rule cannot target another org''s queue');
select tests.act_as('other_owner');
select is((select count(*)::int from app.routing_rules), 0, 'org B sees no org A rules');

-- AC5: an explicit queue behaves as before
select tests.as_service();
select tests.rjoin('Direct', null, 'q_lic');
select tests.as_postgres();
select is((select q.name from app.visits v join app.queues q on q.id = v.queue_id where v.guest_name = 'Direct'), 'Licence',
  'AC5: p_queue_id still joins that queue');

-- a service of another queue is left off a routed visit
update app.routing_rules set active = true, service_id = tests.id('s_pass'), target_queue_id = tests.id('q_lic') where id = tests.id('r_lic');
update app.routing_rules set active = false where id = tests.id('r_pass');
select tests.as_service();
select tests.rjoin('Cross', 's_pass');
select tests.as_postgres();
select is((select q.name from app.visits v join app.queues q on q.id = v.queue_id where v.guest_name = 'Cross'), 'Licence', 'the rule decides the queue');
select is((select service_id from app.visits where guest_name = 'Cross'), null, 'a service of another queue is not recorded');
-- the join page learns only that routing is on
select is((api.get_location_public('test-location-a')).routing, true, 'location_public.routing is true while a rule is active');
update app.routing_rules set active = false where location_id = tests.id('loc_a');
select is((api.get_location_public('test-location-a')).routing, false, 'location_public.routing is false with no active rule');
select tests.as_anon();
select throws_ok($$ select count(*) from app.routing_rules $$, '42501', null, 'anon has no table access');
select * from finish();
rollback;
