-- 2A-Q11 (#110): manual wait override in the ETA and api.set_wait_override.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1','k2','k3','k4','k5']) k;
delete from app.business_hours where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_o'), tests.id('org_a'), tests.id('loc_a'), 'Override', 'O');
select tests.new_visit('o' || i, 'queue_o') from generate_series(1, 6) i;

-- No override: the normal formula (a state other than override).
select isnt((select eta_state::text from private.visit_eta(tests.id('o3'))), 'override', 'without an override the formula is used');

select tests.act_as('staff');
select is((api.set_wait_override(tests.id('queue_o'), 30, null, tests.id('k1'))).id, tests.id('queue_o'), 'staff set an override');
select tests.as_postgres();
select ok((select wait_override_until between now() + interval '59 minutes' and now() + interval '61 minutes' or
                   wait_override_until = ((private.service_day(location_id) + 1)::timestamp + (select day_boundary from app.locations where id = location_id)) at time zone (select tz from app.locations where id = location_id)
           from app.queues where id = tests.id('queue_o')), 'until defaults to an hour, capped at the end of the service day');

-- AC1: 30 min, 6 waiting, 3rd guest: about 15 with state override.
select is((select eta_state::text from private.visit_eta(tests.id('o3'))), 'override', 'AC1: state is override');
select is((select eta_low || '-' || eta_high from private.visit_eta(tests.id('o3'))), '10-20', 'AC1: the 3rd guest of 6 gets about 15 (+/-25%, in fives)');
select is((select eta_state::text from private.visit_eta(tests.id('o1'))), 'next', 'the first guest is still next');
select is((select eta_low || '-' || eta_high from private.queue_eta(tests.id('queue_o'))), '25-40', 'a new guest is told about the override itself (30, +/-25%)');
select is((select eta_quoted_low from (select * from app.visits where id = tests.id('o3')) v), (select eta_quoted_low from app.visits where id = tests.id('o3')), 'quotes are untouched');

-- AC2: expired.
update app.queues set wait_override_until = now() - interval '1 minute' where id = tests.id('queue_o');
select isnt((select eta_state::text from private.visit_eta(tests.id('o3'))), 'override', 'AC2: an expired override is ignored');

-- Clearing and validation.
select tests.act_as('staff');
select is((api.set_wait_override(tests.id('queue_o'), null, null, tests.id('k2'))).id, tests.id('queue_o'), 'a null minutes clears');
select tests.as_postgres();
select is((select wait_override_minutes from app.queues where id = tests.id('queue_o')), null, 'the override is cleared');
select tests.act_as('staff');
select throws_ok(format($$ select api.set_wait_override(%L, 241, null, %L) $$, tests.id('queue_o'), tests.id('k3')),
  'P0001', 'invalid_input', 'more than 240 minutes is rejected');

-- AC3: cross tenant.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.set_wait_override(%L, 30, null, %L) $$, tests.id('queue_o'), tests.id('k4')),
  'P0001', 'not_found', 'AC3: org B gets not_found');
select tests.as_anon();
select throws_ok(format($$ select api.set_wait_override(%L, 30, null, %L) $$, tests.id('queue_o'), tests.id('k4')),
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
