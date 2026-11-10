-- B1 (#1233): an invoice.paid for the monthly SMS bundle credits the ledger once; a cancelled or
-- unknown subscription gets nothing; credit already granted is never taken back.
begin;
\ir ../helpers/_setup.psql
select plan(14);
select tests.create_world();

update app.subscriptions set stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a', status = 'active'
where org_id = tests.id('org_a');
insert into app.subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status)
values (tests.id('org_b'), 'cus_b', 'sub_b', 'active')
on conflict (org_id) do update set stripe_customer_id = 'cus_b', stripe_subscription_id = 'sub_b', status = 'active';

select is((select sms_bundle_grant_micros from app.platform_flags), 6000000::bigint, 'default grant is 6.00 (placeholder until the Twilio rate is known)');

select tests.as_service();
select is(api.apply_bundle_grant('in_1', 'sub_a', '2026-01-01 10:00+00'), 'applied', 'AC1: a paid bundle invoice grants credit');
select tests.as_postgres();
select results_eq($$ select entry_type, amount_micros, stripe_ref from app.credit_ledger where org_id = tests.id('org_a') and entry_type = 'addon_allowance' $$,
  $$ values ('addon_allowance'::text, 6000000::bigint, 'in_1'::text) $$, 'AC1: one addon_allowance entry in the same ledger');
select is(private.credit_balance(tests.id('org_a')), 6000000::bigint, 'AC1: and the balance reflects it');

select tests.as_service();
select is(api.apply_bundle_grant('in_1', 'sub_a', '2026-01-01 10:00+00'), 'duplicate', 'AC2: a replayed invoice does not grant twice');
select is(api.apply_bundle_grant('in_2', 'sub_a', '2026-02-01 10:00+00'), 'applied', 'the next cycle grants again (rollover)');
select tests.as_postgres();
select is(private.credit_balance(tests.id('org_a')), 12000000::bigint, 'credit rolls over');

-- Cross-tenant: the grant lands only on the subscription's own org.
select is((select count(*) from app.credit_ledger where org_id = tests.id('org_b')), 0::bigint, 'another org gets nothing');

-- Failed payment then cancel: no further grants, nothing clawed back.
select tests.as_service();
select api.apply_billing_event('payment_failed', '2026-03-01 10:00+00', null, null, 'sub_a', null, null, null, null);
select is(api.apply_bundle_grant('in_3', 'sub_a', '2026-03-05 10:00+00'), 'applied', 'a paid invoice during dunning (the retry succeeded) still grants');
select api.apply_billing_event('deleted', '2026-04-01 10:00+00', null, 'cus_a', 'sub_a', 'canceled', null, null, null);
select is(api.apply_bundle_grant('in_4', 'sub_a', '2026-04-02 10:00+00'), 'ignored', 'AC3: a cancelled subscription gets no grant');
select tests.as_postgres();
select is(private.credit_balance(tests.id('org_a')), 18000000::bigint, 'AC3: granted credit stays');

select tests.as_service();
select is(api.apply_bundle_grant('in_5', 'sub_unknown', now()), 'unknown_subscription', 'an unknown subscription is reported');
select throws_ok($$ select api.apply_bundle_grant('', 'sub_b', now()) $$, 'P0001', 'invalid_input', 'a blank invoice id is refused');

-- Only the service role may call it.
select tests.as_anon();
select throws_ok($$ select api.apply_bundle_grant('in_9', 'sub_b', now()) $$, '42501', null, 'anon cannot call it');
select * from finish();
rollback;
