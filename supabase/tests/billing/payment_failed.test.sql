-- #1083: a failed payment emails the org's owners once, with the grace end date; a reminder follows
-- four days before the grace period ends.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();

select tests.create_user('owner2');
insert into app.memberships (org_id, user_id, role) values (tests.id('org_a'), tests.id('owner2'), 'owner');
update app.subscriptions set stripe_customer_id = 'cus_a', stripe_subscription_id = 'sub_a', status = 'active'
where org_id = tests.id('org_a');
insert into app.subscriptions (org_id, stripe_customer_id, stripe_subscription_id, status)
values (tests.id('org_b'), 'cus_b', 'sub_b', 'active')
on conflict (org_id) do update set stripe_customer_id = 'cus_b', stripe_subscription_id = 'sub_b', status = 'active';

select is((select count(*) from app.notification_templates
           where org_id is null and channel = 'email' and trigger in ('payment_failed', 'payment_grace_ending')),
  2::bigint, 'both emails have a system template');

select is((select count(*) from app.notification_templates
           where org_id is null and trigger in ('payment_failed', 'payment_grace_ending')
             and body like '%[Open Billing: {app_url}/admin/billing]%'), 2::bigint,
  'both emails link to Billing through the optional {app_url} sentence');

-- Billing off: a failure writes no email.
select tests.as_service();
select api.apply_billing_event('payment_failed', '2026-01-01 10:00+00', null, null, 'sub_b', null, null, null, null);
select tests.as_postgres();
select is((select status from app.subscriptions where org_id = tests.id('org_b')), 'past_due', 'billing off: the failure is still recorded');
select is((select count(*) from app.notifications where template_key = 'payment_failed'), 0::bigint,
  'billing off: no email');
update app.subscriptions set status = 'active', grace_ends_at = null where org_id = tests.id('org_b');

-- AC1: the first failure queues one email per owner, and nobody else.
update app.platform_flags set billing_enabled = true;
select tests.as_service();
select api.apply_billing_event('payment_failed', '2026-01-02 10:00+00', null, null, 'sub_a', null, null, null, null);
select tests.as_postgres();
select results_eq(
  $$ select recipient_ref, channel::text, category::text, visit_id is null, vars ->> 'org'
     from app.notifications where template_key = 'payment_failed' order by recipient_ref $$,
  $$ select * from (values (tests.id('owner'), 'email', 'transactional', true, 'Org A'),
                           (tests.id('owner2'), 'email', 'transactional', true, 'Org A')) x order by 1 $$,
  'AC1: one account email per owner of the org');
select is((select vars ->> 'grace_end' from app.notifications where template_key = 'payment_failed' limit 1),
  to_char((select grace_ends_at from app.subscriptions where org_id = tests.id('org_a')) at time zone 'UTC',
          'FMMonth FMDD, YYYY') || ' UTC',
  'AC1: it carries the grace end date');
select is((select count(*) from app.notifications where template_key = 'payment_failed'
           and recipient_ref in (tests.id('admin'), tests.id('manager'), tests.id('staff'))),
  0::bigint, 'admins, managers and staff get nothing');
select is((select count(*) from app.notifications where org_id = tests.id('org_b')), 0::bigint,
  'cross-tenant: the other org''s owner gets nothing');

-- Once per failure: Stripe repeats the event, retries the invoice, or sends the status in an update.
select tests.as_service();
select api.apply_billing_event('payment_failed', '2026-01-03 10:00+00', null, null, 'sub_a', null, null, null, null);
select api.apply_billing_event('subscription', '2026-01-04 10:00+00', null, 'cus_a', 'sub_a', 'past_due', null, 1, null);
select tests.as_postgres();
select is((select count(*) from app.notifications where template_key = 'payment_failed'), 2::bigint,
  'AC1: repeats of the same failure queue nothing more');

-- A subscription update that moves a paying org to past_due emails too.
-- (one transaction has one now(), so age the first emails' keys as if the second failure came weeks later)
update app.notifications set dedupe_key = dedupe_key || ':earlier' where template_key = 'payment_failed';
update app.subscriptions set status = 'active', grace_ends_at = null, last_event_at = null where org_id = tests.id('org_a');
select tests.as_service();
select api.apply_billing_event('subscription', '2026-02-01 10:00+00', null, 'cus_a', 'sub_a', 'past_due', null, 1, null);
select tests.as_postgres();
select is((select count(*) from app.notifications where template_key = 'payment_failed'), 4::bigint,
  'a new failure after paying again emails the owners again');

-- Day-10 reminder: only inside the last four days, once per grace period, owners only.
select is(ops.send_payment_grace_reminders(), 0, 'no reminder with 14 days left');
update app.subscriptions set grace_ends_at = now() + interval '3 days' where org_id = tests.id('org_a');
select is(ops.send_payment_grace_reminders(), 2, 'with 3 days left both owners are reminded');
select is(ops.send_payment_grace_reminders(), 0, 'once per grace period');
select is((select count(*) from app.notifications where template_key = 'payment_grace_ending'
           and recipient_ref in (tests.id('owner'), tests.id('owner2')) and org_id = tests.id('org_a')),
  2::bigint, 'the reminder goes to the owners');
update app.subscriptions set status = 'active', grace_ends_at = null where org_id = tests.id('org_a');
update app.subscriptions set status = 'past_due', grace_ends_at = now() - interval '1 day' where org_id = tests.id('org_a');
select is(ops.send_payment_grace_reminders(), 0, 'no reminder once the grace period is over');
update app.platform_flags set billing_enabled = false;
update app.subscriptions set grace_ends_at = now() + interval '2 days' where org_id = tests.id('org_a');
select is(ops.send_payment_grace_reminders(), 0, 'billing off: no reminder');

-- Privileges: not callable by members or the public.
select tests.act_as('owner');
select throws_ok($$select ops.send_payment_grace_reminders()$$, '42501', null, 'owners cannot run the reminder job');
select tests.act_as('staff');
select is((select count(*) from app.notifications where template_key = 'payment_failed'), 0::bigint,
  'staff do not see account mail rows');

select * from finish();
rollback;
