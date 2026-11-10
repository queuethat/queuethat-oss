-- #1155: a business's platform SMS is paused automatically when its STOP, undelivered or filtered rate
-- spikes; operators pause and resume; the dispatcher's reserve_send refuses a paused org.
begin;
\ir ../helpers/_setup.psql
select plan(25);
select tests.create_world();

insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('c'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'staff');
update app.channel_limits set daily_cap = 100000, monthly_budget_micros = 999999999999, country_allowlist = '{US}'
where org_id = tests.id('org_a') and channel = 'sms';
update app.organizations set created_at = now() - interval '60 days';
insert into app.provider_settings (org_id, channel, provider, mode, enabled)
values (tests.id('org_a'), 'sms', 'twilio', 'platform', true)
on conflict (org_id, channel) do update set provider = 'twilio', mode = 'platform', enabled = true;

-- 40 sent texts, all delivered: healthy.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key,
                               status, sent_at, provider, delivery_status)
select tests.new_id('n' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.new_id('c'), 'called', 1, 'n' || i,
       'sent', now() - interval '1 hour', 'twilio', 'delivered'
from generate_series(1, 40) i;
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.new_id('later'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.new_id('c'), 'called', 1, 'later');

select is(private.platform_sms_breach(private.platform_sms_stats(tests.id('org_a'))), null, 'a healthy org breaches nothing');
select is(private.platform_sms_breach('{"sent":29,"stops":29,"filtered":29,"undelivered":29}'), null, 'under 30 sent there is no verdict');
select is(private.platform_sms_breach('{"sent":100,"stops":4,"filtered":0,"undelivered":0}'), null, '4% STOP is under the 5% threshold');
select is(private.platform_sms_breach('{"sent":100,"stops":5,"filtered":0,"undelivered":0}'), 'stop_rate', '5% STOP breaches');
select is(private.platform_sms_breach('{"sent":30,"stops":2,"filtered":0,"undelivered":0}'), null, 'two STOPs never pause, even on a small base');
select is(private.platform_sms_breach('{"sent":30,"stops":3,"filtered":0,"undelivered":0}'), 'stop_rate', 'three STOPs on a small base pause');
select is(private.platform_sms_breach('{"sent":100,"stops":2,"filtered":4,"undelivered":24}'), null, 'just under every threshold is fine');
select is(private.platform_sms_breach('{"sent":100,"stops":0,"filtered":5,"undelivered":0}'), 'filtered_rate', '5% filtered breaches');
select is(private.platform_sms_breach('{"sent":100,"stops":0,"filtered":0,"undelivered":25}'), 'undelivered_rate', '25% undelivered breaches');

select is(ops.pause_unhealthy_platform_sms(), 0, 'the job leaves a healthy org alone');

-- One number repeating STOP counts once; it is blamed on the org that last texted it only.
select tests.as_service();
select api.apply_platform_sms_event('stop', '+14155550188');
select api.apply_platform_sms_event('stop', '+14155550188');
select api.apply_platform_sms_event('stop', '+14155550188');
select tests.as_postgres();
select is((private.platform_sms_stats(tests.id('org_a')) ->> 'stops')::int, 1, 'the same number stopping three times is one STOP');
select is((select count(*)::int from private.platform_sms_stops where org_id = tests.id('org_b')), 0, 'a STOP is not blamed on an org that did not text the number');
delete from private.platform_sms_stops;

-- 3 of 40 filtered by carriers is 7.5%: paused.
update app.notifications set delivery_status = 'undelivered', error_code = 'twilio_30007'
where org_id = tests.id('org_a') and id in (tests.new_id('n1'), tests.new_id('n2'), tests.new_id('n3'));
select is(ops.pause_unhealthy_platform_sms(), 1, 'the job pauses the org over a threshold');
select is((select state || ':' || reason from private.platform_sms_pauses where org_id = tests.id('org_a')), 'auto:filtered_rate', 'the pause names the threshold');
select is((select count(*)::int from app.platform_audit where action = 'sms.auto_pause' and org_id = tests.id('org_a')), 1, 'the pause is audited');
select is((select count(*)::int from app.notifications where template_key = 'sms_paused_operator' and org_id = tests.id('org_a') and recipient_ref = tests.id('platform')), 1,
  'the operator is emailed about the pause');
select is((select count(*)::int from app.notifications where template_key = 'sms_paused' and org_id = tests.id('org_a')
           and recipient_ref = tests.id('owner')), 1, 'and the org owner is told their texts are paused');
select is((select count(*)::int from app.notifications where template_key in ('sms_paused', 'sms_paused_operator')
           and org_id = tests.id('org_b')), 0, 'nothing is sent for another org');
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('later'))), 'paused', 'reserve_send refuses a paused org');
select tests.as_postgres();

-- Another org is unaffected.
select is(private.platform_sms_paused(tests.id('org_b'), 'sms'), false, 'org B is not paused');

-- Operators resume; the job does not re-pause for 24 hours; support cannot change it.
select tests.act_as('platform');
select is(api.platform_set_sms_pause(tests.id('org_a'), false, 'carrier confirmed it was a one-off') ->> 'state', 'resumed', 'an operator resumes');
select tests.as_postgres();
select is(ops.pause_unhealthy_platform_sms(), 0, 'a resumed org is not re-paused within 24 h');
select tests.as_service();
select is((select decision from api.reserve_send(tests.id('later'))), 'allowed', 'a resumed org sends again');
select tests.act_as('staff');
select throws_ok($$ select api.platform_set_sms_pause(tests.id('org_a'), true, 'x') $$, '42501', null, 'a tenant member cannot pause');
select tests.act_as('platform');
select throws_ok($$ select api.platform_set_sms_pause(tests.id('org_a'), true, ' ') $$, 'P0001', 'invalid_input', 'a reason is required');

select * from finish();
rollback;
