-- 4-BILL1 (#377): subscriptions follow the org's locations and Stripe's events; nothing is deleted.
begin;
\ir ../helpers/_setup.psql
select plan(39);
select tests.create_world();

select tests.as_postgres();
update app.subscriptions set stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a'
where org_id = tests.id('org_a');
delete from app.billing_jobs;

-- Billing off (the default): locations change nothing, no plan applies.
insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Second', 'bill-second', 'UTC');
select is((select desired_quantity from app.subscriptions where org_id = tests.id('org_a')), 1,
  'billing off: adding a location records nothing');
select is((select count(*) from app.billing_jobs), 0::bigint, 'billing off: no sync job');
select is(private.org_plan(tests.id('org_a')), null, 'billing off: no plan applies');

-- AC1: a third location makes the sync job request quantity 3.
update app.platform_flags set billing_enabled = true;
insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Third', 'bill-third', 'UTC');
select is((select desired_quantity from app.subscriptions where org_id = tests.id('org_a')), 3,
  'AC1: the desired quantity counts the locations');
insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Fourth', 'bill-fourth', 'UTC');
select is((select count(*) from app.billing_jobs where status = 'queued'), 1::bigint, 'two changes share one waiting job');
select tests.as_service();
select is((select quantity from api.claim_billing_jobs(10, 60) where stripe_subscription_id = 'sub_a'), 4,
  'AC1: the claimed job asks for the current location count');
select tests.as_postgres();
select is((select count(*) from app.billing_jobs where status = 'claimed'), 1::bigint, 'the job is leased');
select is((select count(*) from api.claim_billing_jobs(10, 60)), 0::bigint, 'a leased job is not claimed twice');

-- A location added while the job runs queues the next sync; success stores what Stripe has.
insert into app.locations (org_id, name, slug, tz) values (tests.id('org_a'), 'Fifth', 'bill-fifth', 'UTC');
select tests.as_service();
select api.report_billing_result((select id from app.billing_jobs where status = 'claimed'), '{"ok":true,"quantity":4}');
select tests.as_postgres();
select is((select quantity from app.subscriptions where org_id = tests.id('org_a')), 4, 'success stores the confirmed quantity');
select is((select count(*) from app.billing_jobs where status = 'queued'), 1::bigint, 'the missed change queues another sync');
select tests.as_service();
select is((select count(*) from api.claim_billing_jobs(10, 60)), 1::bigint, 'it is due at once');
select api.report_billing_result((select id from app.billing_jobs where status = 'claimed'), '{"ok":false,"retryable":true,"code":"rate_limited"}');
select tests.as_postgres();
select is((select status || '/' || last_error from app.billing_jobs where org_id = tests.id('org_a') and status <> 'done'),
  'queued/rate_limited', 'a retryable failure goes back to the queue');
select ok((select next_attempt_at > now() from app.billing_jobs where status = 'queued'), 'with a backoff');
select tests.as_service();
select lives_ok($$select api.report_billing_result((select id from app.billing_jobs where status = 'queued'), '{"ok":true,"quantity":5}')$$,
  'reporting a job that is not claimed is a no-op');

-- AC2: a failed payment is past_due with a grace period; no data is deleted.
select is(api.apply_billing_event('payment_failed', '2026-01-01 10:00+00', null, null, 'sub_a', null, null, null, null),
  'applied', 'payment_failed applies');
select tests.as_postgres();
select is((select status from app.subscriptions where org_id = tests.id('org_a')), 'past_due', 'AC2: the subscription is past_due');
select ok((select grace_ends_at > now() + interval '13 days' from app.subscriptions where org_id = tests.id('org_a')),
  'with a 14 day grace period');
select is((select count(*) from app.locations where org_id = tests.id('org_a')), 5::bigint, 'AC2: no location is deleted');
select is(private.org_plan(tests.id('org_a')), 'standard', 'the paid plan holds during the grace period');
update app.subscriptions set grace_ends_at = now() - interval '1 second' where org_id = tests.id('org_a');
select is(private.org_plan(tests.id('org_a')), 'free', 'after it the org resolves to the free plan');

-- Ordering and repeats.
select tests.as_service();
select is(api.apply_billing_event('subscription', '2026-01-01 09:00+00', null, 'cus_a', 'sub_a', 'active', null, 5, null),
  'ignored', 'an event older than the newest applied is ignored');
select is(api.apply_billing_event('subscription', '2026-01-02 09:00+00', null, 'cus_a', 'sub_a', 'active', null, 5, '2026-02-01 00:00+00'),
  'applied', 'a newer event applies');
select tests.as_postgres();
select is((select status || '/' || (grace_ends_at is null) from app.subscriptions where org_id = tests.id('org_a')),
  'active/true', 'paying again ends the grace period');

-- Linking by the org id we put in metadata; other orgs are refused.
select tests.as_service();
select is(api.apply_billing_event('subscription', now(), tests.id('org_a'), 'cus_x', 'sub_other', 'active', null, 1, null),
  'ignored', 'a second live subscription for an org is not tracked');
select is(api.apply_billing_event('subscription', now(), tests.id('org_b'), 'cus_a', 'sub_b', 'active', null, 1, null),
  'org_mismatch', 'a customer that belongs to another org writes nothing');
select is(api.apply_billing_event('subscription', now(), tests.id('org_b'), 'cus_b', 'sub_a', 'active', null, 1, null),
  'org_mismatch', 'metadata that disagrees with the subscription''s org writes nothing');
select is(api.apply_billing_event('deleted', now(), null, null, 'sub_nope', null, null, null, null),
  'unknown_subscription', 'an unknown subscription is reported');
select is(api.apply_billing_event('subscription', now(), tests.id('org_b'), 'cus_b', 'sub_b', 'active', null, 1, null),
  'applied', 'a new org links its own subscription');

-- Review fixes: a late failure never revives a canceled subscription or an unpaid first invoice.
select is(api.apply_billing_event('subscription', now() + interval '1 minute', null, 'cus_a', 'sub_a', 'canceled', null, 1, null), 'applied', 'cancel');
select is(api.apply_billing_event('payment_failed', now() + interval '2 minutes', null, null, 'sub_a', null, null, null, null), 'ignored',
  'a late payment_failed does not revive a canceled subscription');
select is(api.apply_billing_event('subscription', now() + interval '3 minutes', null, 'cus_a', 'sub_a', 'incomplete', null, 1, null), 'applied', 'incomplete again');
select is(api.apply_billing_event('payment_failed', now() + interval '4 minutes', null, null, 'sub_a', null, null, null, null), 'ignored',
  'a failed first invoice starts no grace period');
select is(api.apply_billing_event('subscription', now() + interval '5 minutes', null, 'cus_b', 'sub_a', 'active', null, 1, null), 'org_mismatch',
  'a customer owned by another org is refused for a known subscription too');
select tests.as_postgres();
update app.subscriptions set status = 'active' where org_id = tests.id('org_a');

-- Entitlement plan defaults resolve between the override and the global default.
select tests.as_postgres();
insert into app.entitlement_defaults (key, value, description) values ('fixture.seats', '9', 'Test seats');
insert into app.plan_entitlements (plan_id, key, value) values ('free', 'fixture.seats', '1'), ('standard', 'fixture.seats', '20');
select is(private.entitlement(tests.id('org_a'), 'fixture.seats'), '20'::jsonb, 'an active org gets its plan default');
update app.subscriptions set status = 'canceled' where org_id = tests.id('org_b');
select is(private.entitlement(tests.id('org_b'), 'fixture.seats'), '1'::jsonb, 'a canceled org gets the free plan default');
update app.platform_flags set billing_enabled = false;
select is(private.entitlement(tests.id('org_b'), 'fixture.seats'), '9'::jsonb, 'billing off: the global default, unlimited');

-- AC3 and privileges.
select tests.act_as('other_owner');
select is((select count(*) from app.subscriptions where org_id = tests.id('org_a')), 0::bigint, 'AC3: org B cannot read org A''s subscription');
select tests.act_as('owner');
select is((select count(*) from app.subscriptions), 1::bigint, 'an owner reads only their own org''s subscription');
select throws_ok($$select api.apply_billing_event('payment_failed', now(), null, null, 'sub_a', null, null, null, null)$$, '42501', null,
  'members cannot apply billing events');

select * from finish();
rollback;
