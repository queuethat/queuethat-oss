-- #350: Twilio error 21610 (the number opted out at Twilio) is reported as `gone`, which
-- suppresses that number for the org only, so no later SMS to it is attempted.
begin;
\ir ../helpers/_setup.psql
select plan(5);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Sms', 'S');
select tests.new_visit('sms_visit', 'queue_s');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_sms'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+15558675310', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, locked_until)
values (tests.new_id('n_sms'), tests.id('org_a'), tests.id('sms_visit'), 'sms', tests.id('contact_sms'),
        'almost_up', 1, 'sms1', 'claimed', now() + interval '1 minute');

select lives_ok($$ select api.report_outbox_result(tests.id('n_sms'),
  '{"status": "gone", "provider": "twilio", "error_code": "unsubscribed"}') $$,
  'a gone sms result is accepted');
select is((select status::text from app.notifications where id = tests.id('n_sms')), 'dead',
  'the message is dead, never retried');
select results_eq($$ select org_id, channel::text, value from app.suppressions
   where channel = 'sms' and value = '+15558675310' $$,
  $$ values (tests.id('org_a'), 'sms', '+15558675310') $$,
  'the number is suppressed for the sending org');
select is((select reason::text from app.suppressions where org_id = tests.id('org_a') and value = '+15558675310'),
  'stop', 'it is an org-only stop, not a bounce that other orgs honour');
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_b') and value = '+15558675310'), 0,
  'another org is unaffected');

select * from finish();
rollback;
