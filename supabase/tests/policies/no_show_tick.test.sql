-- 2A-Q6 (#105): grace period, no-show warning and the automatic no-show sweep.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5']) k;

update app.queues set auto_no_show_enabled = true, grace_minutes = 5, no_show_warning_seconds = 60
where id = tests.id('queue_a');

-- Calls visit_a (the only waiting visit) as staff; the grace period starts now.
select tests.act_as('staff');
select api.call_next(tests.id('queue_a'), tests.id('counter_a'), tests.id('k1'));
select tests.as_postgres();
select is((select grace_until from app.visits where id = tests.id('visit_a')), now() + interval '5 minutes',
  'calling starts the grace period (called + grace_minutes)');

-- AC1: warning at +4:10, no-show at +5:01.
select is(private.no_show_sweep(now() + interval '3 minutes 59 seconds'), 0, 'nothing before the warning window');
select is(private.no_show_sweep(now() + interval '4 minutes 10 seconds'), 1, 'AC1: the tick at +4:10 writes one warning');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('visit_a') and type = 'no_show_warning'),
  1, 'AC1: one no_show_warning event exists');
-- AC2: idempotent.
select is(private.no_show_sweep(now() + interval '4 minutes 10 seconds'), 0, 'AC2: a second tick changes nothing');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('visit_a') and type = 'no_show_warning'),
  1, 'AC2: no duplicate warning');
select is(private.no_show_sweep(now() + interval '5 minutes 1 second'), 1, 'AC1: the tick at +5:01 marks no-show');
select is((select status::text from app.visits where id = tests.id('visit_a')), 'no_show', 'AC1: status is no_show');
select is((select actor_kind::text || ':' || reason from app.visit_events
           where visit_id = tests.id('visit_a') and type = 'no_show'), 'system:grace_expired',
  'AC1: the no-show is by the system with reason grace_expired');

-- AC5: staff can undo the automatic no-show.
select tests.act_as('staff');
select is((api.undo_event((select max(id) from app.visit_events where visit_id = tests.id('visit_a')),
                          tests.id('k2'))).status::text, 'called', 'AC5: undoing the sweep''s no-show puts the guest back in called');
select tests.as_postgres();
select ok((select grace_until > now() from app.visits where id = tests.id('visit_a')),
  'AC5: the restored call gets a fresh grace period');

-- AC3: a recall moves grace_until, so the old deadline does nothing.
select tests.new_visit('v2', 'queue_a', 'Two');
select tests.act_as('staff');
select api.call_next(tests.id('queue_a'), tests.id('counter_a'), tests.id('k3'));
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set grace_until = now() + interval '30 seconds' where id = tests.id('v2');
select tests.act_as('staff');
select api.transition_visit(tests.id('v2'), 'recall', (select version from app.visits where id = tests.id('v2')),
  tests.id('k4'));
select tests.as_postgres();
select is(private.no_show_sweep(now() + interval '1 minute'), 0, 'AC3: a recall extends the grace period');

-- Disabled and paused queues are skipped.
update app.queues set auto_no_show_enabled = false where id = tests.id('queue_a');
select is(private.no_show_sweep(now() + interval '1 hour'), 0, 'a queue with auto no-show off is never swept');
update app.queues set auto_no_show_enabled = true, manual_state = 'paused' where id = tests.id('queue_a');
select is(private.no_show_sweep(now() + interval '1 hour'), 0, 'a paused queue is skipped');

-- AC4: denied to API roles.
select tests.as_anon();
select throws_ok($$ select ops.no_show_tick() $$, '42501', null, 'AC4: anon cannot run the tick');
select tests.act_as('owner');
select throws_ok($$ select ops.no_show_tick() $$, '42501', null, 'AC4: authenticated cannot run the tick');

select * from finish();
rollback;
