-- A4 (#1225): operators are warned at 60% of a pause threshold and get a daily digest; the purge keeps
-- app.platform_daily_stats. Thresholds are shared with private.platform_sms_breach.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();

-- The warning is a pure function of the stats, beside the breach it mirrors.
select is(private.platform_sms_warning('{"sent":100,"stops":2,"filtered":2,"undelivered":14}'), null, 'just under 60% of every threshold: no warning');
select is(private.platform_sms_warning('{"sent":100,"stops":3,"filtered":0,"undelivered":0}'), 'stop_rate', '3 STOPs is 60% of the 5 that pause');
select is(private.platform_sms_warning('{"sent":100,"stops":0,"filtered":3,"undelivered":0}'), 'filtered_rate', '3 filtered is 60% of 5');
select is(private.platform_sms_warning('{"sent":100,"stops":0,"filtered":0,"undelivered":15}'), 'undelivered_rate', '15 undelivered is 60% of 25');
select is(private.platform_sms_warning('{"sent":30,"stops":2,"filtered":0,"undelivered":0}'), 'stop_rate', 'on a small base 2 STOPs is two thirds of the floor of 3');
select is(private.platform_sms_warning('{"sent":30,"stops":1,"filtered":1,"undelivered":0}'), null, 'a single message never warns');
select is(private.platform_sms_warning('{"sent":29,"stops":29,"filtered":29,"undelivered":29}'), null, 'under 30 sent there is no verdict');
select is(private.platform_sms_warning('{"sent":100,"stops":5,"filtered":0,"undelivered":0}'), null, 'an org that already breaches is paused, not warned');
select is(private.platform_sms_breach('{"sent":100,"stops":4,"filtered":0,"undelivered":0}'), null, 'breach thresholds are unchanged (4% STOP)');
select is(private.platform_sms_breach('{"sent":100,"stops":5,"filtered":0,"undelivered":0}'), 'stop_rate', 'breach thresholds are unchanged (5% STOP)');

-- The job warns an operator once per org, metric and day, and does not pause.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('c'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'staff');
update app.organizations set created_at = now() - interval '60 days';
insert into app.provider_settings (org_id, channel, provider, mode, enabled)
values (tests.id('org_a'), 'sms', 'twilio', 'platform', true)
on conflict (org_id, channel) do update set provider = 'twilio', mode = 'platform', enabled = true;
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key,
                               status, sent_at, provider, delivery_status)
select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.new_id('c'), 'called', 1, 'n' || i,
       'sent', now() - interval '1 hour', 'twilio', 'delivered'
from generate_series(1, 40) i;
select is(ops.pause_unhealthy_platform_sms(), 0, 'healthy: nothing paused');
select is((select count(*)::int from app.notifications where template_key = 'sms_warning_operator'), 0, 'healthy: nobody is warned');
-- 3 of 40 filtered is 7.5%, a breach; 2 of 40 is 5% too. 1 of 40 is 2.5%: under 60% of 5% needs 3 of 100, so use 2.
update app.notifications set delivery_status = 'undelivered', error_code = 'twilio_30007'
where org_id = tests.id('org_a') and id in (tests.new_id('n1'));
update app.notifications set delivery_status = 'undelivered', error_code = 'twilio_30001'
where org_id = tests.id('org_a') and id in (tests.new_id('n2'), tests.new_id('n3'), tests.new_id('n4'), tests.new_id('n5'),
  tests.new_id('n6'), tests.new_id('n7'), tests.new_id('n8'), tests.new_id('n9'), tests.new_id('n10'), tests.new_id('n11'));
-- 10 of 40 undelivered is 25%: that is a breach. Keep 7 (17.5%, 70% of 25%) for a warning.
update app.notifications set delivery_status = 'delivered', error_code = null
where org_id = tests.id('org_a') and id in (tests.new_id('n9'), tests.new_id('n10'), tests.new_id('n11'));
select is(ops.pause_unhealthy_platform_sms(), 0, 'at 70% of the undelivered threshold the org is not paused');
select is((select count(*)::int from app.notifications where template_key = 'sms_warning_operator' and org_id = tests.id('org_a')
           and recipient_ref = tests.id('platform')), 1, 'the operator is warned');
select is((select vars ->> 'metric' from app.notifications where template_key = 'sms_warning_operator' and org_id = tests.id('org_a') and recipient_ref = tests.id('platform')),
          'undelivered_rate', 'the warning names the metric');
select ops.pause_unhealthy_platform_sms();
select is((select count(*)::int from app.notifications where template_key = 'sms_warning_operator' and org_id = tests.id('org_a')
           and recipient_ref = tests.id('platform')), 1,
          'a second run the same day does not warn again');
select is((select count(*)::int from app.notifications where template_key = 'sms_warning_operator' and org_id = tests.id('org_b')), 0,
          'another org is not named');

-- Daily digest: totals come from the A1 rollup; skipped when there is nothing to report.
delete from app.notifications where template_key = 'sms_warning_operator';
select is(ops.platform_sms_digest(), 0, 'nothing to report: no digest');
insert into app.platform_sms_daily (day, org_id, template_key, locale, country, messages, segments, delivered, cost_micros, billed_micros)
values ((now() at time zone 'UTC')::date - 1, tests.id('org_a'), 'called', 'en', 'US', 12, 14, 11, 120000, 150000);
select cmp_ok(ops.platform_sms_digest(), '>=', 1, 'a digest is queued for the operators');
select is(ops.platform_sms_digest(), 0, 'the same day it is not queued twice');
select is((select vars ->> 'messages' || '/' || (vars ->> 'cost') from app.notifications where template_key = 'sms_digest_operator' and recipient_ref = tests.id('platform')),
          '12/$0.12', 'the digest carries yesterday''s totals');
select * from finish();
rollback;
