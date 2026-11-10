-- The promised SMS alerts (almost up, your turn) have default templates that name the sender and
-- carry the STOP line, and an unproven typed number is not texted by them.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();

select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and queue_id is null and locale = 'en'
             and trigger in ('almost_up', 'called')), 2,
  'almost_up and called each have a default English SMS template');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and trigger in ('almost_up', 'called')
             and category <> 'transactional'), 0, 'both are transactional');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and trigger in ('almost_up', 'called')
             and (body like '{location_name}%' or body like '%STOP%')), 0, 'defaults hold the bare body: the frame adds the name and the opt-out line');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and trigger in ('almost_up', 'called')
             and length(private.sms_compose(body, 'en')) > 160), 0, 'each fits one segment once framed');
select is(private.sms_compose('Hi.', 'en'), '{location_name}: Hi. Reply STOP to opt out, HELP for help.', 'the frame names the business and ends with the opt-out and help line');
select is(private.sms_compose('Hola.', 'es'), '{location_name}: Hola. Responde STOP para cancelar, AYUDA para ayuda.', 'in Spanish too');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and trigger in ('almost_up', 'called')
             and length(body) > 160), 0, 'each fits one SMS segment before names are filled in');

select is((select body from private.resolve_template(tests.id('org_a'), null, 'called', 'sms', 'en')),
  'It''s your turn: {ticket}. [Please go to {counter}.]',
  'resolve_template now offers the sms channel for called');
select isnt_empty($$ select 1 from private.resolve_template(tests.id('org_a'), null, 'almost_up', 'sms', 'es') $$,
  'a Spanish guest falls back to the English almost_up text');
select is_empty($$ select 1 from private.resolve_template(tests.id('org_a'), null, 'joined', 'sms', 'en') $$,
  'there is no joined text (reply_join already confirms a text-to-join guest)');
select is_empty($$ select 1 from private.resolve_template(tests.id('org_a'), null, 'served', 'sms', 'en') $$,
  'triggers outside those two still send no SMS');

select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and trigger in ('almost_up', 'called', 'reply_verify', 'reply_join', 'reply_confirm_number')
             and locale = 'es'), 5, 'Spanish defaults exist for every framed text');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and body ~ '[^\x01-\x7e]'), 0, 'defaults stay in GSM-7 (no accented a, i, o, u or curly quotes)');
select is((select count(*)::int from app.notification_templates
           where channel = 'sms' and org_id is null and body like 'QueueThat:%'), 0, 'no default text is sent in the platform name');

-- The claim composes the frame: name first, footer last, in the template's language.
select private.set_actor('system', null);
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key) values
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'called', 1, 'transactional', 'f1'),
  (tests.id('org_a'), tests.id('visit_a'), 'sms', tests.id('contact_a'), 'help', 1, 'transactional', 'f2');
create temp table claimed as select * from api.claim_outbox(200, 60);
select is((select body from claimed where template_key = 'called' and id = (select id from app.notifications where dedupe_key = 'f1')),
  '{location_name}: It''s your turn: {ticket}. [Please go to {counter}.] Reply STOP to opt out, HELP for help.', 'the claimed text is framed');
select is((select count(*)::int from claimed where template_key = 'help' and body like '{location_name}:%'), 0, 'the HELP reply keeps its own text');

-- Recipients: a number typed online is only the guest's word until the code is entered.
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_t'), tests.id('org_a'), tests.id('loc_a'), 'Texts', 'T');
select tests.new_visit('t1', 'queue_t');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source) values
  (tests.new_id('phone_t1'), tests.id('org_a'), tests.id('guest_a'), 'phone', '+14155550188', 'online');
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set contact_id = tests.id('phone_t1'), guest_id = tests.id('guest_a') where id = tests.id('t1');
alter table app.visit_events enable trigger enqueue_notifications;

select is_empty($$ select 1 from private.visit_recipients(
    (select v from app.visits v where v.id = tests.id('t1')), 'almost_up') r where r.channel = 'sms' $$,
  'an online phone that was never verified is not a recipient');
update app.guest_contacts set verified_at = now() where id = tests.id('phone_t1');
select results_eq($$ select r.channel::text from private.visit_recipients(
    (select v from app.visits v where v.id = tests.id('t1')), 'called') r $$,
  $$ values ('sms') $$, 'once verified it is');
update app.guest_contacts set verified_at = null, created_source = 'staff' where id = tests.id('phone_t1');
select results_eq($$ select r.channel::text from private.visit_recipients(
    (select v from app.visits v where v.id = tests.id('t1')), 'called') r $$,
  $$ values ('sms') $$, 'a staff-entered number is not a typed-in one');
select tests.new_visit('t2', 'queue_t');
select is((select count(*)::int from private.visit_recipients(
    (select v from app.visits v where v.id = tests.id('t2')), 'called') r where r.channel = 'sms'), 0,
  'a visit with no contact has no sms recipient');
select is((select count(*)::int from app.guest_contacts where org_id = tests.id('org_b') and value = '+14155550188'), 0,
  'nothing leaks to another org');

select * from finish();
rollback;
