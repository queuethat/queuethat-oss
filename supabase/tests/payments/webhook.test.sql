-- 3-PAY4 (#365): Stripe outcomes applied forward-only, per endpoint org.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

select tests.as_postgres();
-- payment_a is an authorized hold with intent pi_fixture; add a deposit and a saved card.
insert into app.payments (id, org_id, location_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.new_id('pay_dep'), tests.id('org_a'), tests.id('loc_a'), 'stripe', 'pi_dep', 'deposit', 'requires_action', 1000, 'usd', 'wd1');
insert into app.payments (id, org_id, location_id, provider, setup_intent_id, kind, status, amount_minor, currency, idempotency_key)
values (tests.new_id('pay_card'), tests.id('org_a'), tests.id('loc_a'), 'stripe', 'seti_1', 'card_on_file', 'requires_action', 500, 'usd', 'wd2');
update app.payments set provider = 'stripe' where id = tests.id('payment_a');

select tests.as_service();
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'succeeded', 'pi_dep', null, null, null, null), 'applied', 'a deposit succeeds');
-- AC1
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'authorized', 'pi_dep', null, null, null, null), 'ignored', 'a late authorized event is ignored');
select tests.as_postgres();
select is((select status from app.payments where id = tests.id('pay_dep')), 'succeeded', 'and the payment stays succeeded');
select tests.as_service();
-- AC3: replaying the same outcome changes nothing further
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'succeeded', 'pi_dep', null, null, null, null), 'ignored', 'a replayed succeeded event is a no-op');
-- AC2
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'canceled', 'pi_fixture', tests.id('org_b'), null, null, null), 'org_mismatch', 'a metadata org that differs from the endpoint org writes nothing');
select is(api.apply_payment_event(tests.id('org_b'), 'stripe', 'canceled', 'pi_fixture', null, null, null, null), 'unknown_intent', 'another org''s endpoint cannot reach this intent');
select tests.as_postgres();
select is((select status from app.payments where id = tests.id('payment_a')), 'authorized', 'so the hold is untouched');
select tests.as_service();
select api.apply_payment_event(tests.id('org_a'), 'stripe', 'setup_succeeded', 'seti_1', tests.id('org_a'), null, 'cus_1', 'pm_1');
select api.apply_payment_event(tests.id('org_a'), 'stripe', 'refunded', 'pi_dep', null, 1000, null, null);
select tests.as_postgres();
select is((select payment_method_id || '/' || status from app.payments where id = tests.id('pay_card')), 'pm_1/authorized', 'a saved card stores the method and is ready');
select is((select status from app.payments where id = tests.id('pay_dep')), 'refunded', 'a full refund marks the payment refunded');
-- review fixes: a canceled event cannot release a paid payment; a refund is counted once
select tests.as_postgres();
update app.payments set status = 'requires_action' where id = tests.id('payment_a');
select tests.as_service();
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'succeeded', 'pi_fixture', null, null, null, null), 'ignored', 'a never-authorized hold cannot be captured by an event');
select is(api.apply_payment_event(tests.id('org_a'), 'stripe', 'canceled', 'pi_dep', null, null, null, null), 'ignored', 'a canceled event cannot release a paid payment');
select tests.as_postgres();
update app.payments set status = 'succeeded', refunded_minor = 0 where id = tests.id('pay_dep');
insert into app.payment_jobs (id, org_id, location_id, payment_id, action, amount_minor, status, dedupe_key, locked_until)
values (tests.new_id('job_ref'), tests.id('org_a'), tests.id('loc_a'), tests.id('pay_dep'), 'refund', 300, 'claimed', 'rf1', now() + interval '1 min');
select tests.as_service();
select api.apply_payment_event(tests.id('org_a'), 'stripe', 'refunded', 'pi_dep', null, 300, null, null);
select api.report_payment_result(tests.id('job_ref'), '{"ok": true}');
select tests.as_postgres();
select is((select refunded_minor from app.payments where id = tests.id('pay_dep')), 300::bigint, 'webhook then job reports the refund once');
select tests.act_as('manager');
select throws_ok($$ select api.apply_payment_event(null, 'stripe', 'succeeded', 'pi_dep', null, null, null, null) $$, '42501', null, 'signed-in users cannot apply events');

select * from finish();
rollback;
