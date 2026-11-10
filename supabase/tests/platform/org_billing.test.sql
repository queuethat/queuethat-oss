-- #1131: the platform billing panel. api.platform_org_billing and api.platform_billing_overview:
-- roles (support reads, tenants and anon never), MFA, cross-tenant denial, every subscription
-- state, overrides with who/when, suspended orgs, revoked grants, timezones, no secrets.
begin;
\ir ../helpers/_setup.psql
select plan(95);
select tests.create_world();

select tests.create_user('support');
insert into app.platform_roles (user_id, role) values (tests.id('support'), 'support');
select tests.create_user('norole');
create function tests.as_operator() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal2"}') $$;
create function tests.as_support() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal2"}') $$;
create function tests.as_support_aal1() returns void
language sql as $$ select tests.as_user(tests.id('support'), '{"aal":"aal1"}') $$;
create function tests.as_operator_aal1() returns void
language sql as $$ select tests.as_user(tests.id('platform'), '{"aal":"aal1"}') $$;
create function tests.as_norole() returns void
language sql as $$ select tests.as_user(tests.id('norole'), '{"aal":"aal2"}') $$;
grant execute on function tests.as_operator(), tests.as_support(), tests.as_support_aal1(),
  tests.as_operator_aal1(), tests.as_norole() to authenticated;

select tests.as_postgres();
update app.visits set guest_name = 'Zelda Guestname' where id = tests.id('visit_a');
update app.subscriptions set stripe_customer_id = 'cus_orgA', stripe_subscription_id = 'sub_orgA_secret',
  current_period_end = '2026-12-31 23:30:00+00' where org_id = tests.id('org_a');
update app.platform_flags set billing_enabled = false;

-- Billing off: nothing is limited, and the panel says so.
select tests.as_support();
create temp table off as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select standing from off), 'billing_off', 'billing off: standing is billing_off');
select is((select billing_enabled from off), false, 'billing off: the flag is shown');
select is((select effective_plan from off), null, 'billing off: no plan applies');
select is((select status from off), 'active', 'billing off: the subscription row is still shown');

update app.platform_flags set billing_enabled = true;

-- Roles: support and operator read; nobody else does (AC: role checks).
select tests.as_support();
select lives_ok($$ select api.platform_org_billing(tests.id('org_a')) $$, 'support reads one tenant''s billing');
select lives_ok($$ select api.platform_billing_overview() $$, 'support reads the overview');
select tests.as_operator();
select lives_ok($$ select api.platform_org_billing(tests.id('org_a')) $$, 'an operator reads one tenant''s billing');
select lives_ok($$ select api.platform_billing_overview() $$, 'an operator reads the overview');

-- Cross-tenant and tenant roles: every org role, in its own org and in another, and a paired device.
select is(tests.probe('owner', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny',
  'an org owner cannot read their own org through the platform function');
select is(tests.probe('admin', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny', 'admin denied');
select is(tests.probe('manager', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny', 'manager denied');
select is(tests.probe('staff', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny', 'staff denied');
select is(tests.probe('other_owner', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny',
  'cross-tenant: another org''s owner is denied org A''s billing');
select is(tests.probe('other_owner', $$ select count(*) from api.platform_org_billing(tests.id('org_b')) $$), 'deny',
  'cross-tenant: and their own org''s');
select is(tests.probe('display', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny', 'a paired display is denied');
select is(tests.probe('kiosk', $$ select count(*) from api.platform_billing_overview() $$), 'deny', 'a kiosk is denied the overview');
select is(tests.probe('owner', $$ select count(*) from api.platform_billing_overview() $$), 'deny', 'an owner is denied the overview');
select is(tests.probe('anon', $$ select count(*) from api.platform_org_billing(tests.id('org_a')) $$), 'deny', 'anon is denied one org');
select is(tests.probe('anon', $$ select count(*) from api.platform_billing_overview() $$), 'deny', 'anon is denied the overview');
select ok(not has_function_privilege('anon', 'api.platform_org_billing(uuid)', 'execute')
      and not has_function_privilege('anon', 'api.platform_billing_overview()', 'execute'),
  'anon holds no execute privilege on either function');

-- A signed-in user with no platform role, and platform roles without MFA.
select tests.as_norole();
select throws_ok($$ select api.platform_org_billing(tests.id('org_a')) $$, '42501', 'permission_denied', 'no platform role: denied');
select tests.as_support_aal1();
select throws_ok($$ select api.platform_org_billing(tests.id('org_a')) $$, '42501', 'permission_denied', 'MFA: support at aal1 is denied');
select throws_ok($$ select api.platform_billing_overview() $$, '42501', 'permission_denied', 'MFA: support at aal1 is denied the overview');
select tests.as_operator_aal1();
select throws_ok($$ select api.platform_org_billing(tests.id('org_a')) $$, '42501', 'permission_denied', 'MFA: an operator at aal1 is denied');

select tests.as_support();
select throws_ok($$ select api.platform_org_billing(gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown org is not_found');
select throws_ok($$ select api.platform_org_billing(null) $$, 'P0001', 'not_found', 'a null org is not_found');

-- Active subscription, with a revoked support grant on the org (the world has one): no grant is needed.
create temp table active as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select count(*) from app.support_grants where org_id = tests.id('org_a') and revoked_at is not null
           and not exists (select 1 from app.support_grants g where g.org_id = tests.id('org_a') and g.revoked_at is null)),
  1::bigint, 'revoked grant: org A has only a revoked grant, and the panel above still answered');
select is((select standing from active), 'good', 'active: standing good');
select is((select plan_id from active), 'standard', 'active: plan id');
select is((select plan_name from active), 'Standard', 'active: plan name');
select is((select effective_plan from active), 'standard', 'active: the entitlements come from the paid plan');
select is((select status from active), 'active', 'active: Stripe status');
select is((select billing_interval from active), 'month', 'active: monthly');
select is((select stripe_customer_id from active), 'cus_orgA', 'active: the customer id for the Stripe link');
select is((select org_status::text from active), 'active', 'active: org status');
select is((select locations_billed from active), 1, 'active: locations billed');
select is((select locations_actual from active), 1, 'active: locations that exist');
select is((select grace_ends_at from active), null, 'active: no grace period');
select is((select last_payment_failed_at from active), null, 'active: no failed payment');

-- AC: no secrets, card data, subscription id or guest data anywhere in the output.
select ok(to_jsonb(a)::text not like '%sub_orgA_secret%' and to_jsonb(a)::text not like '%Zelda%'
          and to_jsonb(a)::text not ilike '%card%' and to_jsonb(a)::text not ilike '%secret%'
          and to_jsonb(a)::text not like '%+1415%', 'no subscription id, card data or guest data in the output')
from active a;
select is((select count(*) from pg_attribute a join pg_type ty on ty.typrelid = a.attrelid
           where ty.oid = 'api.platform_org_billing'::regtype and a.attnum > 0
             and a.attname::text ~ '(subscription_id|card|token|secret|payment_method|hash)'), 0::bigint,
  'the result type has no subscription id, card, token, secret or hash column');

-- Annual billing and a current period end that stays the same instant in any session time zone.
update app.subscriptions set billing_interval = 'year' where org_id = tests.id('org_a');
select tests.as_support();
set local timezone = 'Pacific/Kiritimati';
create temp table tz1 as select current_period_end, billing_interval from api.platform_org_billing(tests.id('org_a'));
set local timezone = 'America/Los_Angeles';
create temp table tz2 as select current_period_end from api.platform_org_billing(tests.id('org_a'));
set local timezone = 'UTC';
select tests.as_postgres();
select is((select billing_interval from tz1), 'year', 'annual: interval shown');
select is((select current_period_end from tz1), '2026-12-31 23:30:00+00'::timestamptz, 'timezone: the period end is the stored instant (UTC+14 session)');
select is((select current_period_end from tz2), '2026-12-31 23:30:00+00'::timestamptz, 'timezone: and the same instant in UTC-8');

-- No subscription row: a tenant that never subscribed (org B), billing on.
select tests.as_support();
create temp table none as select * from api.platform_org_billing(tests.id('org_b'));
select tests.as_postgres();
select is((select has_subscription from none), false, 'no subscription: flagged');
select is((select standing from none), 'no_subscription', 'no subscription: standing');
select is((select effective_plan from none), 'free', 'no subscription: on the free plan');
select is((select status from none), null, 'no subscription: no status');
select is((select stripe_customer_id from none), null, 'no subscription: no Stripe link');
select is((select locations_actual from none), 1, 'no subscription: locations still counted');
select is((select jsonb_array_length(pending_jobs) from none), 0, 'no subscription: no jobs');

-- Resolved limits come from the resolver and say where each came from.
select is((select e ->> 'value' from none, jsonb_array_elements(none.entitlements) e where e ->> 'key' = 'limit.locations'), '1',
  'limits: the free plan limit applies to an org with no subscription');
select is((select e ->> 'source' from none, jsonb_array_elements(none.entitlements) e where e ->> 'key' = 'limit.locations'), 'plan',
  'limits: sourced from the plan');
select is((select e ->> 'source' from none, jsonb_array_elements(none.entitlements) e where e ->> 'key' = 'limit.members'), 'plan', 'members limit from the plan');
select is((select e ->> 'source' from none, jsonb_array_elements(none.entitlements) e where e ->> 'key' = 'messaging.new_org_days'), 'default', 'a key with no plan or override is default');
select is((select e ->> 'value' from active, jsonb_array_elements(active.entitlements) e where e ->> 'key' = 'limit.locations'), '-1',
  'limits: the paid plan is unlimited');

-- Failed payment: past_due inside the grace period still resolves to the paid plan.
select tests.as_service();
select is(api.apply_billing_event('payment_failed', now(), null, null, 'sub_orgA_secret', null, null, 1, null), 'applied', 'fixture: payment failure applied');
select tests.as_postgres();
select tests.as_support();
create temp table pd as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select status from pd), 'past_due', 'past_due: status');
select is((select standing from pd), 'grace', 'past_due: standing grace');
select is((select effective_plan from pd), 'standard', 'past_due: still on the paid plan inside the grace period');
select ok((select grace_ends_at from pd) between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour', 'past_due: 14-day grace end');
select ok((select last_payment_failed_at from pd) is not null, 'past_due: the last failed payment email time');
select is((select grace_reminder_at from pd), null, 'past_due: no reminder yet');

-- The reminder shows once queued; grace over resolves to free and limits apply.
select private.enqueue_payment_email(tests.id('org_a'), 'payment_grace_ending');
update app.subscriptions set grace_ends_at = now() - interval '1 day' where org_id = tests.id('org_a');
select tests.as_support();
create temp table pd2 as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select standing from pd2), 'free', 'grace over: standing free');
select is((select effective_plan from pd2), 'free', 'grace over: free plan');
select is((select status from pd2), 'past_due', 'grace over: Stripe still says past_due');
select ok((select grace_reminder_at from pd2) is not null, 'grace over: the reminder time is shown');
select is((select e ->> 'value' from pd2, jsonb_array_elements(pd2.entitlements) e where e ->> 'key' = 'limit.locations'), '1', 'grace over: the free limit applies');

-- Canceled, unpaid and incomplete all earn only the free plan.
update app.subscriptions set status = 'canceled' where org_id = tests.id('org_a');
select tests.as_support();
create temp table cx as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select standing from cx), 'free', 'canceled: standing free');
select is((select status from cx), 'canceled', 'canceled: status');
select is((select plan_id from cx), 'standard', 'canceled: the plan on record is kept for support');
select is((select effective_plan from cx), 'free', 'canceled: entitlements come from free');
update app.subscriptions set status = 'incomplete' where org_id = tests.id('org_a');
select tests.as_support();
select is((select standing from api.platform_org_billing(tests.id('org_a'))), 'free', 'incomplete: standing free');
select tests.as_postgres();
update app.subscriptions set status = 'trialing', grace_ends_at = null where org_id = tests.id('org_a');
select tests.as_support();
select is((select standing from api.platform_org_billing(tests.id('org_a'))), 'good', 'trialing: standing good');
select tests.as_postgres();
update app.subscriptions set status = 'active' where org_id = tests.id('org_a');

-- Overrides: who set them, why and when; an override beats the plan; a deleted setter shows as null.
select tests.as_operator();
select api.platform_set_entitlement(tests.id('org_a'), 'limit.locations', '10', 'Pilot customer');
select tests.as_postgres();
update app.org_entitlements set set_at = '2026-10-01 12:00:00+00' where org_id = tests.id('org_a') and key = 'limit.locations';
select tests.as_support();
create temp table ov as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select jsonb_array_length(overrides) from ov), 2, 'overrides: the fixture flag and the new one');
select is((select o ->> 'reason' from ov, jsonb_array_elements(ov.overrides) o where o ->> 'key' = 'limit.locations'), 'Pilot customer', 'overrides: reason');
select is((select o ->> 'set_by_email' from ov, jsonb_array_elements(ov.overrides) o where o ->> 'key' = 'limit.locations'), 'platform@test.local', 'overrides: who set it');
select is((select (o ->> 'set_at')::timestamptz from ov, jsonb_array_elements(ov.overrides) o where o ->> 'key' = 'limit.locations'),
  '2026-10-01 12:00:00+00'::timestamptz, 'overrides: when');
select is((select o ->> 'set_by_email' from ov, jsonb_array_elements(ov.overrides) o where o ->> 'key' = 'fixture.flag'), null, 'overrides: no setter on record shows null');
select is((select e ->> 'source' from ov, jsonb_array_elements(ov.entitlements) e where e ->> 'key' = 'limit.locations'), 'override', 'overrides: source override');
select is((select e ->> 'value' from ov, jsonb_array_elements(ov.entitlements) e where e ->> 'key' = 'limit.locations'), '10', 'overrides: the override value wins');
select tests.as_operator();
select api.platform_set_entitlement(tests.id('org_a'), 'limit.locations', null, 'Pilot over');
select tests.as_support();
select is((select jsonb_array_length(overrides) from api.platform_org_billing(tests.id('org_a'))), 1, 'overrides: a cleared override disappears');
select tests.as_postgres();

-- Pending jobs: queued and failed show, done does not; only a provider code, no tenant data.
insert into app.billing_jobs (org_id, status, attempts, last_error) values (tests.id('org_a'), 'failed', 2, 'resource_missing');
insert into app.billing_jobs (org_id, status) values (tests.id('org_a'), 'done');
insert into app.billing_jobs (org_id, status) values (tests.id('org_b'), 'queued');
select tests.as_support();
create temp table jobs as select * from api.platform_org_billing(tests.id('org_a'));
select tests.as_postgres();
select is((select jsonb_array_length(pending_jobs) from jobs), 2, 'jobs: the world''s queued job and the failed one; done is hidden, other orgs'' jobs are not shown');
select ok((select pending_jobs::text like '%resource_missing%' from jobs), 'jobs: the provider error code is shown');

-- Suspended org: the panel still answers and says so.
select tests.as_operator();
select api.platform_set_org_status(tests.id('org_a'), 'suspended', 'Chargeback');
select tests.as_support();
select is((select org_status::text from api.platform_org_billing(tests.id('org_a'))), 'suspended', 'suspended: the org status is on the panel');
select is((select standing from api.platform_org_billing(tests.id('org_a'))), 'good', 'suspended: billing standing is separate from org status');
select tests.as_operator();
select api.platform_set_org_status(tests.id('org_a'), 'active', 'Resolved');
select tests.as_postgres();

select ok(obj_description('api.platform_org_billing(uuid)'::regprocedure, 'pg_proc') is not null
      and obj_description('api.platform_billing_overview()'::regprocedure, 'pg_proc') is not null,
  'both functions document their interfaces');

-- Overview. Start from a clean slate of subscriptions.
delete from app.subscriptions;
insert into app.organizations (id, name) select tests.new_id('ov_' || g), 'Overview ' || g from generate_series(1, 8) g;
insert into app.subscriptions (org_id, status, current_period_end, grace_ends_at, last_event_at) values
  (tests.id('ov_1'), 'past_due', now() + interval '20 days', now() + interval '5 days', now()),
  (tests.id('ov_2'), 'canceled', null, null, now() - interval '10 days'),
  (tests.id('ov_3'), 'canceled', null, null, now() - interval '40 days'),
  (tests.id('ov_4'), 'trialing', now() + interval '3 days', null, now()),
  (tests.id('ov_5'), 'trialing', now() + interval '10 days', null, now()),
  (tests.id('ov_6'), 'trialing', now() - interval '1 day', null, now()),
  (tests.id('ov_7'), 'active', now() + interval '3 days', null, now()),
  (tests.id('ov_8'), 'canceled', null, null, null);
select tests.as_support();
create temp table ovw as select * from api.platform_billing_overview();
select tests.as_postgres();
select is((select past_due from ovw), 1, 'overview: one past_due');
select is((select canceled_30d from ovw), 1, 'overview: only the cancellation in the last 30 days (not 40 days ago, not unknown)');
select is((select trials_ending_7d from ovw), 1, 'overview: only the trial ending within 7 days (not 10 days, not already ended, not active)');
select is((select jsonb_array_length(attention) from ovw), 3, 'overview: the attention list has the three orgs');
select is((select array_agg(a ->> 'reason') from ovw, jsonb_array_elements(ovw.attention) a), array['past_due', 'trial_ending', 'canceled'], 'overview: past_due first, then trials, then cancellations');
select is((select (attention -> 0 ->> 'name') from ovw), 'Overview 1', 'overview: names the org');
update app.platform_flags set billing_enabled = false;
select tests.as_support();
select is((select attention from api.platform_billing_overview()), '[]'::jsonb, 'overview: billing off: empty list');
select is((select past_due + canceled_30d + trials_ending_7d from api.platform_billing_overview()), 0, 'overview: billing off: zero counts');

select * from finish();
rollback;
