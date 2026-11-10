-- 3-CG14 (#339): the phase 3 compliance gate, database half. One named check per bullet of
-- docs/compliance/security-review.md section 9 "Phase 3", driven through the public entry points
-- (inbound keywords, outbox enqueue and claim, reserve_send, guest and staff consent RPCs) rather than
-- the tables, so removing a control fails the check even if its unit test was deleted.
-- Every check is clock-independent: the send window is steered by picking a time zone.
-- Webhook signatures and replay (the Edge Function half) are in tests/compliance/phase3.test.ts.
begin;
\ir ../helpers/_setup.psql
select plan(48);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
update app.organizations set legal_name = 'Acme Cuts Ltd', support_contact = 'help@acme.test',
  postal_address = '1 Main St, Springfield' where id = tests.id('org_a');
-- A location clock inside the 08:00-20:00 window, whatever time CI runs.
update app.locations set tz = (select name from pg_timezone_names
  where extract(hour from now() at time zone name) = 12 and name !~ '^(posix|Etc|SystemV)' limit 1);

create function tests.inbound(p_org text, p_channel text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), p_channel, p_from, '+14155550000', p_body, 'twilio', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text, text) to service_role;
create function tests.suppressed(p_org text, p_channel text, p_value text) returns int language sql as $$
  select count(*)::int from app.suppressions where org_id = tests.id(p_org) and channel = p_channel::app.notification_channel and value = p_value
$$;
create function tests.enqueue(p_channel text, p_contact text, p_key text, p_category app.message_category default 'transactional',
                              p_trigger text default 'called') returns void language sql as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
  values (tests.id('org_a'), tests.id('visit_a'), p_channel::app.notification_channel, tests.id(p_contact), p_trigger, 1, p_category, p_key)
$$;
create function tests.outcome(p_key text) returns text language sql as $$
  select concat_ws('/', status::text, error_code, wa_mode) from app.notifications where dedupe_key = p_key
$$;

------------------------------------------------------------------------------------------------
-- CG14-01 replayed provider events are no-ops (signatures: phase3.test.ts)
------------------------------------------------------------------------------------------------
select tests.as_service();
select is((api.record_webhook_event('twilio', 'ep:SM1', tests.id('org_a'), '{}')).is_duplicate, false, 'CG14-01 a provider event is recorded once');
select is((api.record_webhook_event('twilio', 'ep:SM1', tests.id('org_a'), '{}')).is_duplicate, true, 'CG14-01 a replay is a duplicate');
select tests.as_anon();
select throws_ok($$ select api.record_webhook_event('twilio', 'ep:SM2', null, '{}') $$, '42501', null,
  'CG14-01 only the (signature-verifying) function can write events: anon cannot');
select tests.as_service();
select tests.inbound('org_a', 'sms', '+14155550123', 'hello', 'SMrep');
select tests.inbound('org_a', 'sms', '+14155550123', 'hello', 'SMrep');
select tests.as_postgres();
select is((select count(*)::int from app.inbound_messages where provider_message_id = 'SMrep'), 1, 'CG14-01 a replayed inbound message is stored once');

------------------------------------------------------------------------------------------------
-- CG14-02 every STOP keyword suppresses within the call that carries it
------------------------------------------------------------------------------------------------
select tests.as_service();
select is(tests.inbound('org_a', 'sms', '+1415555020' || i, k, 'K' || i), 'stop', 'CG14-02 ' || k || ' is an opt-out')
from unnest(array['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']) with ordinality as t(k, i);
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value like '+1415555020_'), 6,
  'CG14-02 six keywords left six suppressions, one per call');
select tests.as_service();
select is(tests.inbound('org_a', 'sms', '+14155550201', 'START', 'S1'), 'start', 'CG14-03 START is recognised');
select is(tests.inbound('org_a', 'sms', '+14155550202', 'unstop', 'S2'), 'start', 'CG14-03 UNSTOP is recognised');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value in ('+14155550201', '+14155550202')), 0,
  'CG14-03 START and UNSTOP remove the suppression');

-- HELP returns the business name and contact (a visit with that number gives the reply a destination).
select tests.new_visit('typed', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('typed');
select tests.as_service();
select is(tests.inbound('org_a', 'sms', '+14155550177', 'help', 'H1'), 'help', 'CG14-04 HELP is recognised');
select tests.as_postgres();
select is((select vars ->> 'business_name' || '|' || (vars ->> 'support_contact') from app.notifications
           where template_key = 'help' and visit_id = tests.id('typed')), 'Acme Cuts Ltd|help@acme.test',
  'CG14-04 the HELP reply names the business and its contact');

-- Staff cannot send to a suppressed number, and cannot lift the suppression themselves.
insert into app.suppressions (org_id, channel, value, reason) values (tests.id('org_a'), 'sms', '+14155550188', 'stop');
select tests.new_visit('opted_out', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550188' where id = tests.id('opted_out');
select tests.act_as('manager');
select throws_ok($$ select api.log_manual_contact(tests.id('opted_out'), 'whatsapp') $$, 'P0001', 'suppressed',
  'CG14-05 staff get no number to message for an opted-out guest');
select throws_ok($$ delete from app.suppressions where org_id = tests.id('org_a') and value = '+14155550188' $$, '42501', null,
  'CG14-05 and cannot delete the suppression');
select tests.as_postgres();
select is(tests.suppressed('org_a', 'sms', '+14155550188'), 1, 'CG14-05 which is still in place');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_s'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'online');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_s'), 'sms', 'transactional', 'granted', 'online', 'v1', 'h');
select tests.enqueue('sms', 'contact_s', 's1');
select is((select j.is_suppressed from api.claim_outbox(200, 60) j where j.id = (select id from app.notifications where dedupe_key = 's1')), true,
  'CG14-05 a consented but opted-out number reaches the dispatcher flagged suppressed');

------------------------------------------------------------------------------------------------
-- CG14-06 quiet hours: DST-correct windows; "called" exempt
------------------------------------------------------------------------------------------------
select tests.as_postgres();
create function tests.window_at(p_tz text, p_local text) returns timestamptz language sql as $$
  select private.next_send_window(tests.id('loc_a'), (p_local::timestamp) at time zone p_tz)
$$;
create temp table tests_loc_tz as select tz from app.locations where id = tests.id('loc_a');
update app.locations set tz = 'America/New_York' where id = tests.id('loc_a');
select is(tests.window_at('America/New_York', '2026-03-07 21:30'), '2026-03-08 12:00:00+00'::timestamptz,
  'CG14-06 21:30 on the eve of US DST start opens at 08:00 EDT');
select is(tests.window_at('America/New_York', '2026-11-01 21:30'), '2026-11-02 13:00:00+00'::timestamptz,
  'CG14-06 21:30 on the day US DST ends opens at 08:00 EST');
update app.locations set tz = 'Europe/Berlin' where id = tests.id('loc_a');
select is(tests.window_at('Europe/Berlin', '2026-10-24 21:00'), '2026-10-25 07:00:00+00'::timestamptz,
  'CG14-06 Berlin on the night before the clocks go back opens at 08:00 CET');
update app.locations set tz = (select name from pg_timezone_names where extract(hour from now() at time zone name) = 23 and name !~ '^(posix|Etc|SystemV)' limit 1)
where id = tests.id('loc_a');
select tests.enqueue('sms', 'contact_a', 'q1', 'transactional', 'almost_up');
select tests.enqueue('sms', 'contact_a', 'q2', 'transactional', 'called');
select count(*) from api.claim_outbox(200, 60);
select results_eq($$ select dedupe_key, status::text, quiet_hours_deferred from app.notifications where dedupe_key in ('q1', 'q2') order by 1 $$,
  $$ values ('q1', 'queued', true), ('q2', 'claimed', false) $$, 'CG14-06 at 23:00 local almost_up waits and called is claimed');
update app.locations set tz = (select tz from tests_loc_tz) where id = tests.id('loc_a');

------------------------------------------------------------------------------------------------
-- CG14-07 marketing needs a marketing consent
------------------------------------------------------------------------------------------------
select tests.enqueue('sms', 'contact_a', 'm1', 'marketing', 'broadcast_marketing');
select is(tests.outcome('m1'), 'suppressed/no_marketing_consent', 'CG14-07 transactional consent alone blocks a marketing sms');
select tests.enqueue('sms', 'contact_a', 'm2', 'transactional', 'almost_up');
select is((select status::text from app.notifications where dedupe_key = 'm2'), 'queued', 'CG14-07 and still lets transactional through');
select throws_ok($$ insert into app.notification_templates (org_id, trigger, channel, category, body) values (null, 'called', 'sms', 'marketing', 'x') $$,
  '23514', null, 'CG14-07 a marketing template cannot ride the called trigger');

------------------------------------------------------------------------------------------------
-- CG14-08 staff attestation
------------------------------------------------------------------------------------------------
select tests.new_id('k1');
select tests.new_visit('sv', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550166' where id = tests.id('sv');
select tests.act_as('staff');
select throws_ok($$ select api.staff_capture_consent(tests.id('sv'), 'sms', false, 1, tests.id('k1')) $$, 'P0001', 'attestation_required',
  'CG14-08 a staff-added number without attestation is refused');
select lives_ok($$ select api.staff_capture_consent(tests.id('sv'), 'sms', true, 1, tests.id('k1')) $$, 'CG14-08 with attestation it is recorded');
select tests.as_postgres();
select results_eq($$ select source, captured_by_user_id = tests.id('staff'), attested_at is not null from app.consents where source = 'staff' $$,
  $$ values ('staff', true, true) $$, 'CG14-08 the consent row records who attested and when');
select throws_ok($$ insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
  values (tests.id('org_a'), tests.id('contact_a'), 'sms', 'transactional', 'granted', 'staff', '1', 'h') $$,
  '23514', null, 'CG14-08 the table itself refuses an unattested staff consent');

------------------------------------------------------------------------------------------------
-- CG14-09 daily cap and country allowlist before the provider call; 80% alert
------------------------------------------------------------------------------------------------
update app.channel_limits set daily_cap = 10, country_allowlist = '{US}', monthly_budget_micros = null
where org_id = tests.id('org_a') and channel = 'sms';
insert into app.guest_contacts (id, org_id, guest_id, channel, value, country_code, created_source) values
  (tests.new_id('us'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550144', 'US', 'online'),
  (tests.new_id('uk'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+447700900123', 'GB', 'online');
insert into app.notifications (id, org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
select tests.new_id('c' || i), tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id(case when i = 12 then 'uk' else 'us' end), 'called', 1, 'c' || i
from generate_series(1, 12) i;
create function pg_temp.reserve(p_from int, p_to int) returns void language plpgsql as $$
begin
  for i in p_from..p_to loop perform api.reserve_send(tests.id('c' || i)); end loop;
end $$;
grant all on function pg_temp.reserve(int, int) to service_role;
select tests.as_service();
select pg_temp.reserve(1, 7);
select tests.as_postgres();
select is((select count(*)::int from app.notifications where template_key = 'usage_alert'), 0, 'CG14-09 below 80% nobody is alerted');
select tests.as_service();
select pg_temp.reserve(8, 8);
select tests.as_postgres();
select is((select count(*)::int from app.usage_alerts where org_id = tests.id('org_a') and channel = 'sms' and day = (now() at time zone 'UTC')::date and threshold = 80), 1, 'CG14-09 the 8th of 10 sends records the 80% alert');
select tests.as_service();
select pg_temp.reserve(9, 10);
select is((select decision from api.reserve_send(tests.id('c11'))), 'cap_reached', 'CG14-09 the 11th send is stopped by the daily cap');
select is((select decision from api.reserve_send(tests.id('c12'))), 'country_blocked', 'CG14-09 a +44 number is stopped by the country allowlist');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- CG14-10 consent copy is versioned; the row stores version and hash
------------------------------------------------------------------------------------------------
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
create table tests.tokens (name text primary key, token text);
grant all on tests.tokens to anon, authenticated;
create function tests.join_as(p_name text, p_phone text) returns void language sql as $$
  insert into tests.tokens
  select p_name, (api.join_queue(tests.id('queue_a'), null, p_name, p_phone, null, 1, 'en', gen_random_uuid())).token
$$;
grant execute on function tests.join_as(text, text) to anon;
select tests.as_anon();
select tests.join_as('gv', '+14155550133');
select tests.as_postgres();
create table tests.hashes as
  select encode(sha256(convert_to(private.render_consent_text(tests.id('loc_a'), 'sms', 'transactional', 'en', 2), 'UTF8')), 'hex') as h;
grant select on tests.hashes to anon;
create function tests.tok() returns text language sql security definer as $$ select token from tests.tokens where name = 'gv' $$;
grant execute on function tests.tok() to anon;
select tests.as_anon();
select throws_ok($$ select api.guest_grant_consent(tests.tok(), 'sms', 2, repeat('0', 64), 'en') $$, 'P0001', 'consent_text_mismatch',
  'CG14-10 a hash that is not the published copy is refused');
select lives_ok($$ select api.guest_grant_consent(tests.tok(), 'sms', 2, (select h from tests.hashes), 'en') $$, 'CG14-10 the published copy is accepted');
select tests.as_postgres();
select results_eq($$ select c.consent_text_version, c.consent_text_hash = (select h from tests.hashes) from app.consents c
  join app.visits v on v.contact_id = c.contact_id where v.guest_token_hash = private.token_hash(tests.tok()) and c.source = 'online' $$,
  $$ values ('2', true) $$, 'CG14-10 the consent row stores the version and the hash the guest saw');

------------------------------------------------------------------------------------------------
-- CG14-11 WhatsApp: opt-in on the channel; outside 24 h only an approved template
------------------------------------------------------------------------------------------------
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_w'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550125', 'online');
select tests.enqueue('whatsapp', 'contact_a', 'w1');
select is(tests.outcome('w1'), 'suppressed/no_consent', 'CG14-11 an sms consent is not a whatsapp opt-in');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_w'), 'whatsapp', 'transactional', 'granted', 'online', 'v1', 'h');
select tests.enqueue('whatsapp', 'contact_w', 'w2');
select is(tests.outcome('w2'), 'queued/template', 'CG14-11 with the opt-in and the window closed it goes out as an approved template');
update app.whatsapp_templates set status = 'rejected' where id = tests.id('wa_template_a');
select tests.enqueue('whatsapp', 'contact_w', 'w3');
select is(tests.outcome('w3'), 'suppressed/no_approved_template', 'CG14-11 without an approved template nothing is sent outside the window');
update app.guest_contacts set whatsapp_window_until = now() + interval '1 hour' where id = tests.id('contact_w');
select tests.enqueue('whatsapp', 'contact_w', 'w4');
select is(tests.outcome('w4'), 'queued/session', 'CG14-11 inside the 24 h window a session message is allowed');

------------------------------------------------------------------------------------------------
-- CG14-12 promotional email: unsubscribe link, postal address, immediate unsubscribe
------------------------------------------------------------------------------------------------
select ok((select bool_and(body like '%{unsubscribe_url}%') from app.notification_templates where org_id is null and channel = 'email'),
  'CG14-12 every default email template carries the unsubscribe link');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_e'), tests.id('org_a'), tests.id('guest_a'), 'email', 'lee@example.com', 'online');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.new_id('contact_e'), 'email', 'marketing', 'granted', 'online', 'v1', 'h');
update app.notification_templates set category = 'marketing' where org_id is null and trigger = 'broadcast' and channel = 'email';
select tests.enqueue('email', 'contact_e', 'e1', 'marketing', 'broadcast');
select is((select j.vars ->> 'org_postal_address' from api.claim_outbox(200, 60) j where j.id = (select id from app.notifications where dedupe_key = 'e1')),
  '1 Main St, Springfield', 'CG14-12 a marketing email carries the org''s postal address');
select tests.as_service();
select api.unsubscribe_outbox((select id from app.notifications where dedupe_key = 'e1'));
select tests.as_postgres();
select tests.enqueue('email', 'contact_e', 'e2', 'marketing', 'broadcast');
select is(tests.outcome('e2'), 'suppressed/no_marketing_consent', 'CG14-12 the very next marketing email is suppressed');

------------------------------------------------------------------------------------------------
-- CG14-13 cross-tenant: org B's actions never touch org A
------------------------------------------------------------------------------------------------
select tests.as_service();
select tests.inbound('org_b', 'sms', '+14155550123', 'STOP', 'XB1');
select tests.as_postgres();
select is(tests.suppressed('org_a', 'sms', '+14155550123'), 0, 'CG14-13 org B''s STOP from the same number does not suppress it for org A');
select tests.act_as('other_owner');
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a')), 0, 'CG14-13 org B cannot read org A''s suppressions');
select throws_ok($$ select api.staff_capture_consent(tests.id('sv'), 'sms', true, 1, gen_random_uuid()) $$, 'P0001', 'not_found',
  'CG14-13 org B cannot attest consent on an org A visit');

select * from finish();
rollback;
