-- 3-PAY2 (#363): release jobs, no-show charge, refund, job runner, tenancy.
begin;
\ir ../helpers/_setup.psql
select plan(23);
select tests.create_world();

select tests.as_postgres();
-- visit_a (waiting) already has the authorized hold payment_a. A second visit for the no-show cases.
select tests.new_visit('visit_ns', 'queue_a');
insert into app.payments (id, org_id, location_id, visit_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.new_id('payment_ns'), tests.id('org_a'), tests.id('loc_a'), tests.id('visit_ns'), 'fake', 'pi_ns', 'hold', 'authorized', 500, 'usd', 'ns');

-- AC1: serving then serving the visit queues exactly one release, however often it repeats.
select private.set_actor('staff', null, 'call');
update app.visits set status = 'called' where id = tests.id('visit_a');
select private.set_actor('staff', null, 'start');
update app.visits set status = 'serving' where id = tests.id('visit_a');
select private.set_actor('staff', null, 'complete');
update app.visits set status = 'served' where id = tests.id('visit_a');
select is((select count(*)::int from app.payment_jobs where payment_id = tests.id('payment_a') and action = 'release' and dedupe_key like 'release:%'),
          1, 'a served visit queues one release job');
select lives_ok(format($$ select private.enqueue_payment_release(%L) $$, tests.id('payment_a')), 'enqueueing again is a no-op');
select is((select count(*)::int from app.payment_jobs where dedupe_key = 'release:' || tests.id('payment_a')), 1, 'still one release job after a repeat');

-- AC2: a visit that is not a no-show cannot be charged.
select tests.act_as('manager');
select throws_ok(format($$ select api.staff_charge_no_show(%L, gen_random_uuid()) $$, tests.id('payment_ns')),
                 'P0001', 'illegal_payment_action', 'a waiting visit cannot be charged');

select tests.as_postgres();
select private.set_actor('staff', null, 'no_show');
update app.visits set status = 'no_show' where id = tests.id('visit_ns');
select tests.act_as('manager');
select is((select status from api.staff_charge_no_show(tests.id('payment_ns'), '00000000-0000-0000-0000-0000000000a1')), 'authorized', 'a no-show is charged (job queued)');
select is((select count(*)::int from app.payment_jobs where payment_id = tests.id('payment_ns') and action = 'charge_no_show'), 1, 'one charge job');
select lives_ok(format($$ select api.staff_charge_no_show(%L, gen_random_uuid()) $$, tests.id('payment_ns')), 'a second click with a new key is accepted');
select is((select count(*)::int from app.payment_jobs where payment_id = tests.id('payment_ns') and action = 'charge_no_show'), 1, 'but still one charge job');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where after ->> 'event' = 'charge_no_show' and row_id = tests.id('payment_ns')::text), 2, 'charges are audited');

-- AC3: staff are denied, another tenant gets not_found.
select tests.act_as('staff');
select throws_ok(format($$ select api.staff_charge_no_show(%L, gen_random_uuid()) $$, tests.id('payment_ns')), '42501', null, 'staff cannot charge');
select throws_ok(format($$ select api.staff_refund_payment(%L, null, null, gen_random_uuid()) $$, tests.id('payment_ns')), '42501', null, 'staff cannot refund');
select tests.act_as('other_owner');
select throws_ok(format($$ select api.staff_charge_no_show(%L, gen_random_uuid()) $$, tests.id('payment_ns')), 'P0001', 'not_found', 'org B cannot charge org A');
select throws_ok(format($$ select api.staff_refund_payment(%L, null, null, gen_random_uuid()) $$, tests.id('payment_ns')), 'P0001', 'not_found', 'org B cannot refund org A');

-- AC4: nobody deletes a payment.
select tests.act_as('owner');
select throws_ok(format($$ delete from app.payments where id = %L $$, tests.id('payment_ns')), '42501', null, 'owners cannot delete payments');

-- Refunds.
select tests.as_postgres();
insert into app.payments (id, org_id, location_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.new_id('payment_dep'), tests.id('org_a'), tests.id('loc_a'), 'fake', 'pi_dep', 'deposit', 'succeeded', 1000, 'usd', 'dep');
select tests.act_as('manager');
select throws_ok(format($$ select api.staff_refund_payment(%L, 1001, null, gen_random_uuid()) $$, tests.id('payment_dep')), 'P0001', 'illegal_payment_action', 'more than was paid cannot be refunded');
select lives_ok(format($$ select api.staff_refund_payment(%L, 400, 'goodwill', gen_random_uuid()) $$, tests.id('payment_dep')), 'a partial refund is queued');
select throws_ok(format($$ select api.staff_refund_payment(%L, 700, null, gen_random_uuid()) $$, tests.id('payment_dep')), 'P0001', 'illegal_payment_action', 'a queued refund counts against what is left');
select is((select count(*)::int from api.staff_refund_payment(tests.id('payment_dep'), 600, null, gen_random_uuid())), 1, 'the rest can still be refunded');

-- Job runner.
select tests.as_service();
create temp table claimed as select * from api.claim_payment_jobs(10, 60);
select ok((select count(*) from claimed where action = 'refund') = 2, 'the runner claims both refund jobs');
select is((select count(*)::int from api.claim_payment_jobs(10, 60)), 0, 'a second runner gets nothing while the lease holds');
select api.report_payment_result((select id from claimed where action = 'refund' and amount_minor = 400), '{"ok": true}');
select tests.as_postgres();
select is((select refunded_minor from app.payments where id = tests.id('payment_dep')), 400::bigint, 'a reported refund is recorded');
-- A late release never moves a captured payment.
select tests.as_postgres();
update app.payments set status = 'captured' where id = tests.id('payment_a');
update app.payment_jobs set status = 'claimed', locked_until = now() + interval '1 min' where id = tests.id('payment_job_a');
select tests.as_service();
select api.report_payment_result(tests.id('payment_job_a'), '{"ok": true}');
select tests.as_postgres();
select is((select status from app.payments where id = tests.id('payment_a')), 'captured', 'a late release leaves a captured payment alone');
-- Dead after six retryable failures.
update app.payment_jobs set status = 'claimed', attempts = 6, locked_until = now() + interval '1 min' where dedupe_key = 'fixture-job';
select tests.as_service();
select api.report_payment_result(tests.id('payment_job_a'), '{"ok": false, "retryable": true, "code": "network"}');
select tests.as_postgres();
select is((select status from app.payment_jobs where id = tests.id('payment_job_a')), 'dead', 'the sixth failure dead-letters the job');

select * from finish();
rollback;
