-- 4-BOT1 (#381): messaging a queue's keyword on WhatsApp joins it, and the updates ride WhatsApp.
begin;
\ir ../helpers/_setup.psql
select plan(21);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
update app.queues set sms_keyword = 'CUTS' where id = tests.id('queue_a');

create function tests.wa(p_org text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), 'whatsapp', p_from, '+14155550000', p_body, 'meta', p_id)).handled_as
$$;
grant execute on function tests.wa(text, text, text, text) to service_role;

-- AC1: a new number joins.
select tests.as_service();
select is(tests.wa('org_a', '+14155550321', 'cuts', 'w1'), 'join', 'AC1: the keyword joins');
select tests.as_postgres();
select is((select count(*) from app.visits where queue_id = tests.id('queue_a') and source = 'whatsapp'
           and guest_phone_e164 = '+14155550321'), 1::bigint, 'AC1: one visit with source whatsapp');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550321' and c.channel = 'whatsapp' and c.status = 'granted' and c.source = 'wa_keyword'),
  1::bigint, 'AC1: one whatsapp consent from the keyword');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550321' and c.channel = 'sms'), 0::bigint, 'no sms consent is implied');
select ok((select gc.whatsapp_window_until > now() + interval '23 hours' from app.guest_contacts gc
           where gc.value = '+14155550321'), 'the message opened the 24 h window');
select is((select n.status::text || '/' || n.wa_mode from app.notifications n where n.template_key = 'reply_join'),
  'queued/session', 'the ticket reply goes out as a session message');
select is((select vars ? 'ticket' and vars ? 'position' from app.notifications where template_key = 'reply_join'), true,
  'the reply carries the ticket and position');
select is((select count(*) from app.notifications where channel <> 'whatsapp' and visit_id in
           (select id from app.visits where source = 'whatsapp')), 0::bigint, 'nothing is sent over other channels');

-- Updates default to WhatsApp.
select tests.act_as('staff');
select api.transition_visit(v.id, 'call', v.version, gen_random_uuid()) from app.visits v where v.source = 'whatsapp';
select tests.as_postgres();
select is((select channel::text from app.notifications where template_key = 'called' and visit_id in
           (select id from app.visits where source = 'whatsapp')), 'whatsapp', 'the call goes to WhatsApp');

-- Texting again while in line: no second visit.
select tests.as_service();
select is(tests.wa('org_a', '+14155550321', ' CUTS! ', 'w2'), 'join', 'texting again is accepted');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550321'), 1::bigint, 'no second visit');

-- AC2: a closed queue answers closed, without a visit.
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_service();
select is(tests.wa('org_a', '+14155550322', 'CUTS', 'w3'), 'join_closed', 'AC2: a closed queue answers closed');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550322'), 0::bigint, 'AC2: no visit');
select is((select n.status::text || '/' || n.wa_mode from app.notifications n
           where n.template_key = 'reply_join_closed' and n.channel = 'whatsapp'), 'queued/session',
  'AC2: the closed reply is a session message');
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550322'), 0::bigint, 'AC2: a closed reply records no consent');

-- AC3: org A's keyword on org B's number does nothing.
update app.queues set manual_state = 'open' where id = tests.id('queue_a');
select tests.as_service();
select is(tests.wa('org_b', '+14155550323', 'CUTS', 'w4'), 'unhandled', 'AC3: another org''s number does not join org A''s queue');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550323'), 0::bigint, 'AC3: no visit anywhere');

-- STOP on WhatsApp still wins over a keyword.
select tests.as_service();
select is(tests.wa('org_a', '+14155550321', 'STOP', 'w5'), 'stop', 'STOP suppresses WhatsApp');
select tests.as_postgres();
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550321' and c.channel = 'whatsapp' and c.status = 'granted' and c.revoked_at is null),
  0::bigint, 'the whatsapp consent is revoked');

-- Text joins are unchanged: SMS keeps its source and channel.
select tests.as_service();
select is((api.process_inbound_message(tests.id('org_a'), 'sms', '+14155550330', '+14155550000', 'CUTS', 'twilio', 's1')).handled_as,
  'join', 'an SMS keyword still joins');
select tests.as_postgres();
select is((select source from app.visits where guest_phone_e164 = '+14155550330'), 'sms', 'with source sms');

select * from finish();
rollback;
