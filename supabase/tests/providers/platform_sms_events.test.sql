-- Platform Twilio part 2 (#1089): delivery reports and STOP/START from the shared number.
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();

-- org A sends through the platform; org B has its own Twilio
insert into app.provider_settings (org_id, channel, provider, mode, config) values
  (tests.id('org_a'), 'sms', 'twilio', 'platform', '{}'),
  (tests.id('org_b'), 'sms', 'twilio', 'own', '{}');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('phone_p'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'US', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, provider, provider_message_id, sent_at) values
  (tests.new_id('p1'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_p'), 'called', 1, 'p1', 'sent', 'twilio', 'SM_p1', now()),
  (tests.new_id('p2'), tests.id('org_b'), tests.id('visit_b'), 'sms', tests.id('phone_p'), 'called', 1, 'p2', 'sent', 'twilio', 'SM_p2', now());
select tests.as_service();

select ok(api.apply_platform_sms_event('status', null, 'SM_p1', 'delivered'), 'a report for a platform org message is applied');
select is((select delivery_status from app.notifications where id = tests.id('p1')), 'delivered', 'and the message is delivered');
select ok(not api.apply_platform_sms_event('status', null, 'SM_p2', 'delivered'), 'a message of an org with its own Twilio is not touched by this route');
select is((select delivery_status from app.notifications where id = tests.id('p2')), null, 'and stays as it was');

select api.apply_platform_sms_event('stop', '+14155550142');
select is((select count(*)::int from app.suppressions where channel = 'sms' and value = '+14155550142' and reason = 'platform_stop' and org_id = tests.id('org_a')), 1,
  'a STOP suppresses the number for a platform org');
select is((select count(*)::int from app.suppressions where channel = 'sms' and value = '+14155550142' and org_id = tests.id('org_b')), 0,
  'but not for an org on its own Twilio (a different sender)');
select lives_ok($$select api.apply_platform_sms_event('stop', '+14155550142')$$, 'a repeated STOP is a no-op');

select tests.as_postgres();
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'sms', '+14155550199', 'bounce'), (tests.id('org_b'), 'sms', '+14155550142', 'stop'),
  (tests.id('org_a'), 'sms', '+14155550143', 'stop');
select tests.as_service();
select api.apply_platform_sms_event('stop', '+14155550143');
select api.apply_platform_sms_event('start', '+14155550143');
select api.apply_platform_sms_event('start', '+14155550142');
select is((select count(*)::int from app.suppressions where value = '+14155550142' and org_id = tests.id('org_a')), 0, 'START lifts the stop for platform orgs');
select is((select count(*)::int from app.suppressions where value = '+14155550142' and org_id = tests.id('org_b')), 1, 'and leaves an own-account org''s stop alone');
select is((select count(*)::int from app.suppressions where value = '+14155550143' and org_id = tests.id('org_a')), 1, 'an org''s own unsubscribe survives a STOP and START on the shared number');
select throws_ok($$select api.apply_platform_sms_event('stop', 'not a phone')$$, 'P0001', 'invalid_input', 'a malformed number is refused');

select tests.act_as('owner');
select throws_ok($$select api.apply_platform_sms_event('stop', '+14155550142')$$, '42501', null, 'tenants cannot call it');

select * from finish();
rollback;
