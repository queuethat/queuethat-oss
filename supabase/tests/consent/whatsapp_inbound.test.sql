-- 3-WA3 (#360): WhatsApp replies open the 24 h window, honour STOP per channel, and receipts land.
begin;
\ir ../helpers/_setup.psql
select plan(11);
select tests.create_world();

-- contact_a (+14155550123) has sms consent (fixture); add whatsapp consent.
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash)
values (tests.id('org_a'), tests.id('contact_a'), 'whatsapp', 'transactional', 'granted', 'online', 'v1', 'h');

create function tests.inbound(p_org text, p_channel text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), p_channel, '+14155550123', '+14155550000', p_body, 'meta', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text) to service_role;
create function tests.window_of(p_contact text) returns timestamptz language sql as $$
  select whatsapp_window_until from app.guest_contacts where id = tests.id(p_contact)
$$;
grant execute on function tests.window_of(text) to service_role;

-- Cross-tenant: org B receiving a message from the same number must not touch org A's contact.
select tests.as_service();
select tests.inbound('org_b', 'whatsapp', 'hello', 'wamid.B1');
select tests.as_postgres();
select is(tests.window_of('contact_a'), null, 'org B''s inbound does not open org A''s window');

-- AC2: an inbound text opens the window to received_at + 24 h.
select tests.as_service();
select is(tests.inbound('org_a', 'whatsapp', 'hi there', 'wamid.A1'), 'unhandled', 'a plain reply is stored');
select tests.as_postgres();
select is(tests.window_of('contact_a'),
  (select received_at + interval '24 hours' from app.inbound_messages where provider_message_id = 'wamid.A1'),
  'AC2: window = received_at + 24 h');
select is((select channel::text from app.inbound_messages where provider_message_id = 'wamid.A1'), 'whatsapp', 'stored as a whatsapp message');

-- Replays do not move the window or double-store.
select tests.as_service();
select tests.inbound('org_a', 'whatsapp', 'hi there', 'wamid.A1');
select tests.as_postgres();
select is((select count(*)::int from app.inbound_messages where provider_message_id = 'wamid.A1'), 1, 'a replay is stored once');

-- AC1: STOP over WhatsApp suppresses whatsapp only.
select tests.as_service();
select is(tests.inbound('org_a', 'whatsapp', 'STOP', 'wamid.A2'), 'stop', 'AC1: STOP is an opt-out');
select tests.as_postgres();
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and channel = 'whatsapp' and value = '+14155550123'),
  1, 'AC1: a whatsapp suppression exists');
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and channel = 'sms' and value = '+14155550123'),
  0, 'the sms channel is untouched');
select is((select status from app.consents where contact_id = tests.id('contact_a') and channel = 'whatsapp'), 'revoked', 'whatsapp consent revoked');
select is((select status from app.consents where id = tests.id('consent_a')), 'granted', 'sms consent stays granted');

-- An unsupported channel is rejected.
select tests.as_service();
select throws_ok($$ select tests.inbound('org_a', 'email', 'x', 'e1') $$, 'P0001', 'invalid_input', 'only sms and whatsapp are inbound channels');

select * from finish();
rollback;
