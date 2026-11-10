-- N3 (#69): api.claim_outbox and api.report_outbox_result.
begin;
\ir ../helpers/_setup.psql
select plan(20);
select tests.create_world();
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1); -- a clock inside the send window (08:00-20:00), whatever time CI runs

-- visit_a (fixture) has push_a and the fixture row notification_a. Give it an email contact with
-- consent and a suppressed phone contact, then queue one row for each.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('email_c'), tests.id('org_a'), tests.id('guest_a'), 'email', 'guest@example.com', 'online'),
  (tests.new_id('phone_s'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550999', 'online');
insert into app.consents (id, org_id, contact_id, channel, purpose, status, source,
                          consent_text_version, consent_text_hash)
values (tests.new_id('consent_email'), tests.id('org_a'), tests.id('email_c'), 'email', 'transactional',
        'granted', 'online', 'v1', 'hash');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               vars, dedupe_key) values
  (tests.new_id('n_email'), tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('email_c'), 'called', 1,
   '{"ticket": "A001"}', 'n_email'),
  (tests.new_id('n_sms'), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('phone_s'), 'called', 1,
   '{}', 'n_sms');
update app.notifications set created_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute';

create table tests.jobs of api.outbox_job;
grant all on tests.jobs to service_role;

select tests.as_service();
select throws_ok($$ select api.claim_outbox(0, 60) $$, 'P0001', 'invalid_input', 'claim_outbox rejects a limit of 0');
insert into tests.jobs select * from api.claim_outbox(50, 60);
select tests.as_postgres();

select is((select count(*)::int from tests.jobs), 3, 'claim_outbox returns every due row');
select is((select count(*)::int from app.notifications where status = 'claimed' and locked_until > now()), 3,
  'claimed rows are leased');
select tests.as_service();
select is((select count(*)::int from api.claim_outbox(50, 60)), 0,
  'AC1: a second dispatcher gets none of the leased rows');
select tests.as_postgres();

select results_eq($$ select recipient, has_consent, is_suppressed, location_tz, body, subject, locale
                     from tests.jobs where id = tests.id('n_email') $$,
  $$ values ('{"kind": "address", "value": "guest@example.com"}'::jsonb, true, false, (select tz from app.locations where id = tests.id('loc_a')),
             'It''s your turn: {ticket}. [Please go to {counter}.]' || E'\n\n' ||
             '[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]', 'It''s your turn', 'en') $$,
  'an email job carries the address, consent, location zone and the resolved template');
select is((select vars ->> 'location_name' from tests.jobs where id = tests.id('n_email')),
  (select name from app.locations where id = tests.id('loc_a')),
  'a claimed job carries the location name, so "in line at {{location_name}}" is not "us"');
select is((select vars ->> 'ticket' from tests.jobs where id = tests.id('n_email')), 'A001',
  'and keeps the values the row already had');
select is((select consent_id from app.notifications where id = tests.id('n_email')), tests.id('consent_email'),
  'the consent the send relies on is recorded on the row');
select results_eq($$ select has_consent, is_suppressed from tests.jobs where id = tests.id('n_sms') $$,
  $$ values (false, true) $$, 'a phone contact without consent and on the suppression list says so');
select results_eq($$ select recipient ->> 'kind', has_consent, body from tests.jobs where id = tests.id('notification_a') $$,
  $$ values ('push', true, 'Your turn {ticket}') $$,
  'a push job is its own consent and uses the org''s template override');

------------------------------------------------------------------------------------------------
-- report_outbox_result
------------------------------------------------------------------------------------------------
select tests.as_service();
select api.report_outbox_result(tests.id('n_email'),
  '{"status": "sent", "provider": "mailpit", "provider_message_id": "m1", "cost_micros": 0}');
select api.report_outbox_result(tests.id('n_sms'), '{"status": "suppressed", "error_code": "no_consent"}');
select api.report_outbox_result(tests.id('notification_a'),
  '{"status": "failed", "retryable": true, "error_code": "http_503", "provider": "vapid"}');
select throws_ok($$ select api.report_outbox_result(tests.id('n_email'), '{"status": "maybe"}') $$,
  'P0001', 'invalid_input', 'an unknown status is rejected');
select throws_ok($$ select api.report_outbox_result(gen_random_uuid(), '{"status": "sent"}') $$,
  'P0001', 'not_found', 'an unknown row raises not_found');
select api.report_outbox_result(tests.id('n_email'), '{"status": "failed", "retryable": true}');
select tests.as_postgres();

select results_eq($$ select status::text, provider, provider_message_id, locked_until from app.notifications where id = tests.id('n_email') $$,
  $$ values ('sent', 'mailpit', 'm1', null::timestamptz) $$, 'sent records the provider and message id');
select is((select status::text from app.notifications where id = tests.id('n_email')), 'sent',
  'a report for a row no longer claimed changes nothing');
select results_eq($$ select status::text, error_code from app.notifications where id = tests.id('n_sms') $$,
  $$ values ('suppressed', 'no_consent') $$, 'suppressed is final and keeps the reason');

-- AC2: notification_a fails retryably until it is dead. Each round: make it due, claim, fail.
create table tests.backoff (attempt int, status text, delay_s int);
grant all on tests.backoff to service_role;
insert into tests.backoff select attempts, status, round(extract(epoch from next_attempt_at - now()))
from app.notifications where id = tests.id('notification_a');
do $$
begin
  for i in 2..6 loop
    update app.notifications set next_attempt_at = now() where id = tests.id('notification_a');
    perform api.claim_outbox(50, 60);
    perform api.report_outbox_result(tests.id('notification_a'), '{"status": "failed", "retryable": true}');
    insert into tests.backoff select attempts, status, round(extract(epoch from next_attempt_at - now()))
    from app.notifications where id = tests.id('notification_a');
  end loop;
end $$;
select results_eq($$ select attempt, status, delay_s from tests.backoff where status = 'failed' order by attempt $$,
  $$ values (1, 'failed', 30), (2, 'failed', 60), (3, 'failed', 120), (4, 'failed', 240), (5, 'failed', 480) $$,
  'AC2: a retryable failure backs off 30 s, doubling each attempt');
select results_eq($$ select attempt, status from tests.backoff order by attempt desc limit 1 $$,
  $$ values (6, 'dead') $$, 'AC2: the sixth failure marks the row dead');

-- Quiet hours defer, gone and non-retryable failures end it, an expired lease is due again.
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id(k), tests.id('org_a'), tests.id('visit_a'), 'email', tests.id('email_c'), 'almost_up', 1, k
from unnest(array['n_quiet', 'n_gone', 'n_bad', 'n_lease']) k;
select api.claim_outbox(50, 60);
select api.report_outbox_result(tests.id('n_quiet'), '{"status": "suppressed", "error_code": "quiet_hours"}');
select api.report_outbox_result(tests.id('n_gone'), '{"status": "gone"}');
select api.report_outbox_result(tests.id('n_bad'), '{"status": "failed", "retryable": false, "error_code": "http_400"}');
select results_eq($$ select status::text, quiet_hours_deferred, round(extract(epoch from next_attempt_at - now()) / 60)::int
                     from app.notifications where id = tests.id('n_quiet') $$,
  $$ values ('queued', true, 15) $$, 'quiet hours put the row back for 15 minutes');
select results_eq($$ select id, status::text, error_code from app.notifications where id in (tests.id('n_gone'), tests.id('n_bad')) order by dedupe_key $$,
  $$ values (tests.id('n_bad'), 'dead', 'http_400'), (tests.id('n_gone'), 'dead', 'gone') $$,
  'gone and non-retryable failures are dead at once');
update app.notifications set locked_until = now() - interval '1 second' where id = tests.id('n_lease');
select results_eq($$ select id, attempts from api.claim_outbox(50, 60) $$,
  $$ values (tests.id('n_lease'), 1) $$, 'an expired lease is claimed again and counts as an attempt');

select * from finish();
rollback;
