-- 2B-Q5 (#230): counter assignment strategies and call_next's preference for assigned visits.
begin;
\ir ../helpers/_setup.psql
select plan(10);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4']) k;
delete from app.business_hours where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_rr'), tests.id('org_a'), tests.id('loc_a'), 'RR', 'R');
update app.counters set sort_order = 1 where id = tests.id('counter_a');
update app.counters set sort_order = 2 where id = tests.id('counter_pair');
-- The two world counters only (the world has no others at loc_a).

-- No strategy: nothing is assigned.
select tests.new_visit('n1', 'queue_rr');
select is((select assigned_counter_id from app.visits where id = tests.id('n1')), null, 'strategy none assigns nothing');

-- AC1: round robin 1, 2, 1, 2.
update app.queues set assignment_strategy = 'round_robin' where id = tests.id('queue_rr');
select tests.new_visit('r' || i, 'queue_rr') from generate_series(1, 4) i;
select is((select array_agg(c.label order by v.ticket_number) from app.visits v join app.counters c on c.id = v.assigned_counter_id
            where v.id in (tests.id('r1'), tests.id('r2'), tests.id('r3'), tests.id('r4'))),
  array['Chair 1', 'Chair 2', 'Chair 1', 'Chair 2'], 'AC1: round robin assigns 1, 2, 1, 2');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('r1') and type = 'assigned'), 1, 'an assigned event is written');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('r1') and type = 'joined'), 1, 'and the join event is untouched');

-- AC2: least busy.
insert into app.queues (id, org_id, location_id, name, ticket_prefix, assignment_strategy)
values (tests.new_id('queue_lb'), tests.id('org_a'), tests.id('loc_a'), 'LB', 'L', 'least_busy');
select tests.new_visit('l' || i, 'queue_lb') from generate_series(1, 4) i;
update app.visits set assigned_counter_id = tests.id('counter_a') where id in (tests.id('l1'), tests.id('l2'), tests.id('l3'));
update app.visits set assigned_counter_id = tests.id('counter_pair') where id = tests.id('l4');
select tests.new_visit('l5', 'queue_lb');
select is((select assigned_counter_id from app.visits where id = tests.id('l5')), tests.id('counter_pair'), 'AC2: least busy picks the counter with fewer assigned visits');

-- A counter on break is skipped once presence is reported.
insert into app.staff_presence (org_id, location_id, user_id, status, counter_id) values
  (tests.id('org_a'), tests.id('loc_a'), tests.id('manager'), 'available', tests.id('counter_a')),
  (tests.id('org_a'), tests.id('loc_a'), tests.id('admin'), 'break', tests.id('counter_pair'))
on conflict (user_id, location_id) do update set status = excluded.status, counter_id = excluded.counter_id, updated_at = now();
select tests.new_visit('l6', 'queue_lb');
select is((select assigned_counter_id from app.visits where id = tests.id('l6')), tests.id('counter_a'), 'a counter whose staff is on break is skipped');

-- call_next offers a counter its own assigned visits first.
select tests.act_as('staff');
select is((api.call_next(tests.id('queue_rr'), tests.id('counter_pair'), tests.id('k1'))).id, tests.id('r2'),
  'counter 2 is offered its assigned visit, not the older one assigned to counter 1');
select is((api.call_next(tests.id('queue_rr'), tests.id('counter_a'), tests.id('k2'))).id, tests.id('r1'), 'counter 1 gets its own first');

-- AC4: org B.
select tests.act_as('other_owner');
select is((select count(*)::int from app.queues where id = tests.id('queue_rr')), 0, 'AC4: org B cannot read the queue settings');
select tests.as_postgres();
select is((select count(*)::int from app.visit_events where type = 'assigned' and org_id = tests.id('org_b')), 0, 'and has no assignment events');

select * from finish();
rollback;
