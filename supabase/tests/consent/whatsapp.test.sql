-- 3-WA2 (#359): whatsapp needs whatsapp consent; outside the 24 h window only an approved template.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();

-- contact_a has sms consent only (fixture). contact_w also has whatsapp transactional consent.
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('contact_w'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550125', 'online');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_w'), 'whatsapp', 'transactional', 'granted', 'online', 'v1', 'h');

insert into app.notification_templates (id, org_id, trigger, channel, category, body)
values (tests.new_id('tpl_wm'), null, 'broadcast', 'whatsapp', 'marketing', 'Sale {{message}}');

create function tests.enqueue(p_contact text, p_key text, p_category app.message_category default 'transactional',
                              p_trigger text default 'called')
returns void language sql as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
  values (tests.id('org_a'), tests.id('visit_a'), 'whatsapp', tests.id(p_contact), p_trigger, 1, p_category, p_key)
$$;
create function tests.outcome(p_key text) returns text language sql as $$
  select concat_ws('/', status::text, error_code, wa_mode) from app.notifications where dedupe_key = p_key
$$;

-- AC1: sms consent only.
select tests.enqueue('contact_a', 'w1');
select is(tests.outcome('w1'), 'suppressed/no_consent', 'AC1: sms consent does not cover whatsapp');

-- Consent, window closed, approved mapping (fixture): a template send.
select tests.enqueue('contact_w', 'w2');
select is(tests.outcome('w2'), 'queued/template', 'consent + approved template queues in template mode');

-- #930: the dispatcher asks how to send this row: the approved template, window closed.
select tests.as_service();
select results_eq($$ select mode, wa_name = (select w.wa_name from app.whatsapp_templates w where w.id = tests.id('wa_template_a')), window_open
                     from api.get_whatsapp_send((select id from app.notifications where dedupe_key = 'w2')) $$,
  $$ values ('template', true, false) $$, 'get_whatsapp_send: template mode names the approved template');
select tests.as_postgres();

-- AC2: no mapping approved.
update app.whatsapp_templates set status = 'paused' where id = tests.id('wa_template_a');
select tests.enqueue('contact_w', 'w3');
select is(tests.outcome('w3'), 'suppressed/no_approved_template', 'AC2: a paused mapping is not usable');
update app.whatsapp_templates set status = 'approved', wa_category = 'utility' where id = tests.id('wa_template_a');

-- AC3: open window allows session text for transactional, even with no approved mapping.
update app.whatsapp_templates set status = 'rejected' where id = tests.id('wa_template_a');
update app.guest_contacts set whatsapp_window_until = now() + interval '1 hour' where id = tests.id('contact_w');
select tests.enqueue('contact_w', 'w4');
select is(tests.outcome('w4'), 'queued/session', 'AC3: open window -> session');
select tests.as_service();
select results_eq($$ select mode, wa_name is null, window_open from api.get_whatsapp_send((select id from app.notifications where dedupe_key = 'w4')) $$,
  $$ values ('session', true, true) $$, 'get_whatsapp_send: an open window sends session text, no template needed');
select is((select count(*)::int from api.get_whatsapp_send((select id from app.notifications where dedupe_key = 'w1'))), 1,
  'get_whatsapp_send answers for a suppressed row too (mode null)');
select is((select mode from api.get_whatsapp_send((select id from app.notifications where dedupe_key = 'w1'))), null, 'with no mode');
select tests.as_postgres();
select tests.act_as('staff');
select throws_ok($$ select * from api.get_whatsapp_send(gen_random_uuid()) $$, '42501', null, 'get_whatsapp_send is closed to signed-in users');
select tests.as_postgres();
update app.guest_contacts set whatsapp_window_until = now() - interval '1 second' where id = tests.id('contact_w');
select tests.enqueue('contact_w', 'w5');
select is(tests.outcome('w5'), 'suppressed/no_approved_template', 'a closed window falls back to templates');
update app.whatsapp_templates set status = 'approved' where id = tests.id('wa_template_a');

-- Marketing needs its own consent, and never rides the session window (it needs an approved template).
select tests.enqueue('contact_w', 'w6', 'marketing', 'broadcast');
select is(tests.outcome('w6'), 'suppressed/no_marketing_consent', 'marketing without marketing consent is suppressed');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_w'), 'whatsapp', 'marketing', 'granted', 'online', 'v1', 'h');
select tests.enqueue('contact_w', 'w7', 'marketing', 'broadcast');
select is(tests.outcome('w7'), 'suppressed/no_approved_template', 'marketing ignores the open window');

-- Send-time re-check (the dispatcher calls api.outbox_still_relevant before sending). A called
-- message is relevant only while the visit is called, so make the visit so first.
alter table app.visits disable trigger user;
update app.visits set status = 'called' where id = tests.id('visit_a');
alter table app.visits enable trigger user;
select ok(api.outbox_still_relevant((select id from app.notifications where dedupe_key = 'w2')), 'still relevant while allowed');
update app.consents set status = 'revoked', revoked_at = now() where contact_id = tests.id('contact_w');
select ok(not api.outbox_still_relevant((select id from app.notifications where dedupe_key = 'w2')), 'revoked consent stops the send');

-- AC4: a marketing-category WA template cannot map a transactional template.
select throws_ok($$ insert into app.whatsapp_templates (org_id, template_id, wa_name, wa_language, wa_category)
  values (tests.id('org_a'), tests.id('template_wa'), 'promo', 'en_US', 'marketing') $$, 'P0001', 'category_mismatch',
  'AC4: marketing mapping of a transactional template is rejected');
select throws_ok($$ update app.whatsapp_templates set wa_category = 'marketing' where id = tests.id('wa_template_a') $$,
  'P0001', 'category_mismatch', 'AC4: nor can an existing mapping be flipped');
select throws_ok($$ insert into app.whatsapp_templates (org_id, template_id, wa_name, wa_language, wa_category)
  values (tests.id('org_a'), tests.id('template_a'), 'push_one', 'en_US', 'utility') $$, 'P0001', 'invalid_template',
  'only whatsapp templates can be mapped');

-- AC5: org B sees no mappings and cannot write them.
select tests.act_as('other_owner');
select is((select count(*)::int from app.whatsapp_templates), 0, 'AC5: org B reads zero rows');
select throws_ok($$ insert into app.whatsapp_templates (org_id, template_id, wa_name, wa_language, wa_category)
  values (tests.id('org_a'), tests.id('template_wa'), 'evil', 'en_US', 'utility') $$, '42501', null,
  'AC5: org B cannot write org A mappings');
select tests.act_as('staff');
select is((select count(*)::int from app.whatsapp_templates), 1, 'staff can read mappings (read-only page)');
update app.whatsapp_templates set status = 'rejected';
select is((select status from app.whatsapp_templates), 'approved', 'staff cannot change mappings');

select * from finish();
rollback;
