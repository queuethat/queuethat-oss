-- 3-CG8 (#333): inbound keywords take effect in the call that carries them, per org and sender.
begin;
\ir ../helpers/_setup.psql
select plan(14);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
select tests.new_visit('typed', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('typed');
update app.organizations set legal_name = 'Acme Cuts Ltd', support_contact = 'help@acme.test' where id = tests.id('org_a');
insert into app.notification_templates (org_id, trigger, channel, body)
values (tests.id('org_b'), 'help', 'sms', 'x');
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.id('org_a'), tests.id('typed'), 'sms', tests.id('typed'), 'called', 1, 'pending-typed');

create function tests.inbound(p_org text, p_from text, p_body text, p_id text) returns text language sql as $$
  select (api.process_inbound_message(tests.id(p_org), 'sms', p_from, '+14155550000', p_body, 'twilio', p_id)).handled_as
$$;
grant execute on function tests.inbound(text, text, text, text) to service_role;

-- AC1: every opt-out keyword, mixed case, trailing punctuation.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', ' Stop All! ', 'm1'), 'stop', 'AC1: STOP ALL! is an opt-out');
select tests.as_postgres();
select is((select count(*) from app.suppressions where org_id = tests.id('org_a') and value = '+14155550177'), 1::bigint,
  'AC1: a suppression exists after the single call');
select tests.as_service();
select is((select is_suppressed from api.claim_outbox(10, 60) where id = (select id from app.notifications where dedupe_key = 'pending-typed')),
  true, 'AC1: the pending row for that number is suppressed');
select is(tests.inbound('org_a', '+14155550177', 'opt out', 'm2'), 'stop', 'OPT OUT is an opt-out');
select is(tests.inbound('org_a', '+14155550177', 'Revoke.', 'm3'), 'stop', 'REVOKE is an opt-out');

-- AC4: org B is untouched.
select tests.as_postgres();
select is((select count(*) from app.suppressions where org_id = tests.id('org_b')), 0::bigint, 'AC4: org B has no suppression');

-- AC2: START lifts it and records a consent for a known contact.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550123', 'STOP', 'm4'), 'stop', 'a known contact opts out');
select is(tests.inbound('org_a', '+14155550123', 'start', 'm5'), 'start', 'then START');
select tests.as_postgres();
select is((select count(*) from app.suppressions where org_id = tests.id('org_a') and value = '+14155550123'), 0::bigint,
  'AC2: START removes the suppression');
select is((select count(*) from app.consents where contact_id = tests.id('contact_a') and status = 'granted'
           and source = 'inbound' and consent_text_version = 'keyword-start-1'), 1::bigint, 'AC2: a keyword consent row exists');

-- AC3: HELP queues one reply with the legal name and support contact.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', 'help', 'm6'), 'help', 'HELP is recognised');
select tests.as_postgres();
select is((select vars->>'business_name' || '|' || (vars->>'support_contact') from app.notifications
           where template_key = 'help' and visit_id = tests.id('typed')), 'Acme Cuts Ltd|help@acme.test',
  'AC3: one help reply carrying the legal name and support contact');

-- Replays and plain text.
select tests.as_service();
select is(tests.inbound('org_a', '+14155550177', 'hello there', 'm7'), 'unhandled', 'plain text is unhandled');
select is((select count(*) from app.inbound_messages where provider_message_id = 'm1'), 1::bigint, 'one stored row per message');

select * from finish();
rollback;
