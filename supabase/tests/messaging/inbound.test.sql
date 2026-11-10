-- 2P-NTF10 (#182): simulated SMS replies are stored, scoped to the org, and STOP/HELP are applied.
begin;
\ir ../helpers/_setup.psql
select plan(19);
delete from vault.secrets where name in ('dispatcher_url', 'dispatcher_key');
select tests.create_world();
select tests.new_visit('typed', 'queue_a');
select tests.new_visit('known', 'queue_a');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+14155550177' where id = tests.id('typed');
update app.visits set contact_id = tests.id('contact_a'), guest_id = tests.id('guest_a')
where id = tests.id('known');
-- An org opts into SMS by having an SMS template; the system defaults stay push, email and console.
insert into app.notification_templates (org_id, trigger, channel, body)
values (tests.id('org_a'), 'called', 'sms', 'Your turn {ticket}');
create function tests.reply(p_org text, p_actor text, p_from text, p_body text) returns text language sql as $$
  select api.dev_record_inbound(tests.id(p_org), tests.id(p_actor), p_from, p_body)
$$;
grant execute on function tests.reply(text, text, text, text) to service_role;

-- A queued SMS to the typed number, claimed after STOP (AC1).
select tests.as_service();
select is(tests.reply('org_a', 'staff', '+14155550177', 'hello there'), 'stored', 'a plain reply is only stored');
select is((select count(*) from app.suppressions where value = '+14155550177'), 0::bigint, 'and suppresses nothing');
select is(tests.reply('org_a', 'staff', '+14155550177', ' stop. '), 'stop', 'STOP is recognised whatever its case or punctuation');
select is(tests.reply('org_a', 'staff', '+14155550177', 'STOP'), 'stop', 'a repeated STOP is not an error');
select is((select count(*) from app.suppressions where org_id = tests.id('org_a') and channel = 'sms'
           and value = '+14155550177' and reason = 'stop'), 1::bigint, 'the number is suppressed for the org''s SMS, once');

select tests.as_postgres();
select private.set_actor('system', null);
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, dedupe_key)
values (tests.id('org_a'), tests.id('typed'), 'sms', tests.id('typed'), 'called', 1, 'sms-typed');
select tests.as_service();
select is((select is_suppressed from api.claim_outbox(10, 60) where id = (select id from app.notifications where dedupe_key = 'sms-typed')),
  true, 'AC1: the next SMS to that number is claimed as suppressed');

-- A guest contact: STOP revokes its consent (AC1).
select is(tests.reply('org_a', 'staff', '+14155550123', 'UNSUBSCRIBE'), 'stop', 'UNSUBSCRIBE is STOP');
select is((select status || ':' || revoked_via from app.consents where id = tests.id('consent_a')), 'revoked:sms_stop',
  'the matched contact''s consent is revoked via sms_stop');
select is((select matched_contact_id from app.inbound_messages where body = 'UNSUBSCRIBE'), tests.id('contact_a'),
  'the reply is matched to the contact by number');

-- HELP queues the help template (SMS) to the sender's latest visit.
select is(tests.reply('org_a', 'staff', '+14155550177', 'Help'), 'help', 'HELP queues a reply');
select is((select count(*) from app.notifications where template_key = 'help' and channel = 'sms'
           and visit_id = tests.id('typed') and dedupe_key like 'help:%'), 1::bigint, 'one help reply, to the typed number''s visit');
select is(tests.reply('org_a', 'staff', '+14155550177', 'HELP'), 'help', 'a second HELP is accepted');
select is((select count(*) from app.notifications where template_key = 'help'), 1::bigint,
  'but queues no second help reply within the hour');
select is(api.outbox_still_relevant((select id from app.notifications where template_key = 'help')), true,
  'a help reply stays relevant');
select is(tests.reply('org_a', 'staff', '+14155550166', 'HELP'), 'stored', 'HELP from a number with no visit is only stored');

-- Validation and tenancy (AC3).
select throws_ok($$ select tests.reply('org_a', 'staff', '0415', 'x') $$, 'P0001', 'invalid_input', 'a non-E.164 sender is refused');
select throws_ok($$ select tests.reply('org_a', 'staff', '+14155550177', '   ') $$, 'P0001', 'invalid_input', 'an empty body is refused');
select throws_ok($$ select tests.reply('org_a', 'other_owner', '+14155550177', 'STOP') $$, 'P0001', 'not_found',
  'AC3: staff of org B cannot post an inbound for org A');
select tests.as_postgres();
select is((select count(*) from app.inbound_messages where org_id = tests.id('org_a')), 8::bigint, 'only the accepted replies (and the fixture row) were written');

select * from finish();
rollback;
