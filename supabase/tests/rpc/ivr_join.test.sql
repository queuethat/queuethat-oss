-- 4-IVR1 (#383): joining a queue by keypad call; the text consent is recorded only on the keypress.
begin;
\ir ../helpers/_setup.psql
select plan(23);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B line', 'B');
insert into app.provider_settings (org_id, channel, provider, mode, enabled) values (tests.id('org_a'), 'sms', 'twilio', 'own', true);

create function tests.call(p_org text, p_sid text, p_from text, p_step text, p_digits text, p_visit uuid default null, p_verified boolean default true)
returns jsonb language sql as $$
  select api.process_voice_call(tests.id(p_org), p_sid, p_from, p_step, p_digits, p_visit, p_verified)
$$;
grant execute on function tests.call(text, text, text, text, text, uuid, boolean) to service_role;

-- The menu.
select tests.as_service();
select is((tests.call('org_a', 'CA00000001', '+14155550301', 'menu', '')) ->> 'handled', 'menu', 'the first request returns the menu');
select is((tests.call('org_a', 'CA00000001', '+14155550301', 'menu', '')) -> 'queues', '["Walk-ins"]'::jsonb, 'with the queue names in press order');
select is((tests.call('org_a', 'CA00000001', '+14155550301', 'menu', '')) ->> 'location', 'Location A', 'and the location name');
select is((tests.call('org_b', 'CA00000001', '+14155550301', 'menu', '')) -> 'queues' ->> 0, 'Org B line',
  'org B''s number reads org B''s queues, not org A''s');

-- AC1: Digits=1 joins.
select is((tests.call('org_a', 'CA00000002', '+14155550302', 'join', '1')) ->> 'handled', 'joined', 'AC1: pressing 1 joins');
select is((tests.call('org_a', 'CA00000002', '+14155550302', 'join', '1')) ->> 'handled', 'joined', 'a retried request is answered again');
select tests.as_postgres();
select is((select count(*) from app.visits where source = 'phone' and guest_phone_e164 = '+14155550302' and queue_id = tests.id('queue_a')),
  1::bigint, 'AC1: one visit with source phone, however often Twilio asks');
select is((select guest_name from app.visits where source = 'phone'), 'Caller', 'named Caller');

-- AC2: no keypress, no consent.
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id where gc.value = '+14155550302'),
  0::bigint, 'AC2: no consent before the keypress');
select set_config('t.vid', (select id::text from app.visits where source = 'phone'), false);
select tests.as_service();
select is((tests.call('org_a', 'CA00000002', '+14155550302', 'consent', '2', current_setting('t.vid')::uuid)) ->> 'handled', 'bye', 'another key is no consent');
select tests.as_postgres();
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id where gc.value = '+14155550302'),
  0::bigint, 'AC2: and records none');

-- Consent with 1, from the call's own number and a verified caller ID.
select tests.as_service();
select is((tests.call('org_a', 'CA00000002', '+14155550999', 'consent', '1', current_setting('t.vid')::uuid)) ->> 'handled', 'bye', 'another number cannot consent for this visit');
select is((tests.call('org_a', 'CA00000002', '+14155550302', 'consent', '1', current_setting('t.vid')::uuid, false)) ->> 'handled', 'bye', 'an unverified caller ID cannot consent');
select is((tests.call('org_a', 'CA00000002', '+14155550302', 'consent', '1', current_setting('t.vid')::uuid)) ->> 'handled', 'consent', 'pressing 1 consents');
select tests.as_postgres();
select is((select count(*) from app.consents c join app.guest_contacts gc on gc.id = c.contact_id
           where gc.value = '+14155550302' and c.channel = 'sms' and c.source = 'ivr' and c.consent_text_version = 'ivr-sms-1' and c.status = 'granted'),
  1::bigint, 'one sms consent with source ivr and the text version');

-- The text offer needs a verified caller ID.
select tests.as_service();
select is((tests.call('org_a', 'CA00000003', '+14155550303', 'join', '1', null, false)) ->> 'offer_text', 'false', 'an unverified caller ID is not offered texts');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550303') + (select count(*) from app.guest_contacts where value = '+14155550303'),
  0::bigint, 'and joins anonymously: no visit under that number, no contact for it');
select tests.as_service();
select is((tests.call('org_a', 'CA00000004', '+14155550304', 'join', '1')) ->> 'offer_text', 'true', 'a verified one is');

-- AC3: a call to org B's number joins org B's queue only.
select is((tests.call('org_b', 'CA00000007', '+14155550307', 'join', '1')) ->> 'handled', 'joined', 'AC3: org B''s number joins');
select tests.as_postgres();
select is((select org_id from app.visits where guest_phone_e164 = '+14155550307'), tests.id('org_b'), 'AC3: in org B, never org A');
select tests.as_service();

-- Invalid keys and closed queues.
select is((tests.call('org_a', 'CA00000005', '+14155550305', 'join', '7')) ->> 'handled', 'invalid', 'a key with no queue is invalid');
select tests.as_postgres();
update app.queues set manual_state = 'closed' where id = tests.id('queue_a');
select tests.as_service();
select is((tests.call('org_a', 'CA00000006', '+14155550306', 'join', '1')) ->> 'handled', 'closed', 'a closed queue gets the closed message');
select tests.as_postgres();
select is((select count(*) from app.visits where guest_phone_e164 = '+14155550306'), 0::bigint, 'and no visit');

select * from finish();
rollback;
