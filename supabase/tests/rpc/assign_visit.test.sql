-- 2A-Q2 (#101): api.assign_visit.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5','k6','k7','k8','k9']) k;

select tests.act_as('staff');
select is((api.assign_visit(tests.id('visit_a'), tests.id('counter_a'), null, 0, tests.id('k1'))).id,
  tests.id('visit_a'), 'staff assigns a waiting visit to a counter');
select is((select assigned_counter_id from app.visits where id = tests.id('visit_a')), tests.id('counter_a'),
  'the counter is stored');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('visit_a') and type = 'assigned'),
  1, 'one assigned event is written');
select is((select version from app.visits where id = tests.id('visit_a')), 1, 'the version bumped once');

-- Same key: replay, no second event.
select api.assign_visit(tests.id('visit_a'), tests.id('counter_a'), null, 0, tests.id('k1'));
select is((select count(*)::int from app.visit_events where visit_id = tests.id('visit_a') and type = 'assigned'),
  1, 'repeating a key changes nothing');

-- Same assignment under a new key: no event.
select api.assign_visit(tests.id('visit_a'), tests.id('counter_a'), null, 1, tests.id('k2'));
select is((select count(*)::int from app.visit_events where visit_id = tests.id('visit_a') and type = 'assigned'),
  1, 'assigning what is already assigned writes no event');

select throws_ok(format($$ select api.assign_visit(%L, null, null, 0, %L) $$, tests.id('visit_a'), tests.id('k3')),
  'P0001', 'stale_visit', 'a stale version is rejected');

-- Staff member must cover the location; the counter must be active.
select throws_ok(format($$ select api.assign_visit(%L, null, %L, 1, %L) $$,
  tests.id('visit_a'), tests.id('other_owner'), tests.id('k4')),
  'P0001', 'not_found', 'a user outside the location cannot be assigned');
select tests.as_postgres();
update app.counters set active = false where id = tests.id('counter_pair');
select tests.act_as('staff');
select throws_ok(format($$ select api.assign_visit(%L, %L, null, 1, %L) $$,
  tests.id('visit_a'), tests.id('counter_pair'), tests.id('k5')),
  'P0001', 'not_found', 'an inactive counter cannot be assigned');

-- Both null unassigns.
select is((api.assign_visit(tests.id('visit_a'), null, null, 1, tests.id('k6'))).id, tests.id('visit_a'), 'both null unassigns');
select is((select assigned_counter_id from app.visits where id = tests.id('visit_a')), null, 'the counter is cleared');

-- Only waiting visits.
select tests.as_postgres();
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled', finished_at = now() where id = tests.id('visit_a');
select tests.act_as('staff');
select throws_ok(format($$ select api.assign_visit(%L, null, null, %s, %L) $$, tests.id('visit_a'),
  (select version from app.visits where id = tests.id('visit_a')), tests.id('k7')),
  'P0001', 'illegal_transition', 'only waiting visits can be assigned');

-- AC4: cross tenant.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.assign_visit(%L, null, null, 0, gen_random_uuid()) $$, tests.id('visit_a')),
  'P0001', 'not_found', 'AC4: org B gets not_found on an org A visit');

select * from finish();
rollback;
