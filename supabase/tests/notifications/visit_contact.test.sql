-- #458: an online join keeps the email/phone on the visit; enqueue and claim_outbox use it.
begin;
\ir ../helpers/_setup.psql
select plan(7);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_v'), tests.id('org_a'), tests.id('loc_a'), 'Visit contact', 'V');
select tests.new_visit(n, 'queue_v') from unnest(array['email_v', 'phone_v', 'typed_v']) n;
alter table app.visit_events disable trigger enqueue_notifications;
select private.set_actor('system', null);
update app.visits set guest_email = 'lee@example.com' where id = tests.id('email_v');
update app.visits set guest_phone_e164 = '+14155550177', source = 'sms' where id = tests.id('phone_v');
update app.visits set guest_phone_e164 = '+14155550188' where id = tests.id('typed_v');
alter table app.visit_events enable trigger enqueue_notifications;
-- An SMS template exists, so the phone row is enqueued too and consent decides.
insert into app.notification_templates (org_id, trigger, channel, body)
values (tests.id('org_a'), 'called', 'sms', 'Your turn {ticket}');
insert into app.suppressions (org_id, channel, value, reason)
values (tests.id('org_a'), 'sms', '+14155550177', 'stop');

select private.set_actor('staff', tests.id('staff'), 'call');
update app.visits set status = 'called' where id in (tests.id('email_v'), tests.id('phone_v'), tests.id('typed_v'));

select results_eq($$ select visit_id, channel::text, recipient_ref from app.notifications
                     where template_key = 'called' and visit_id in (tests.id('email_v'), tests.id('phone_v'))
                     order by channel $$,
  $$ values (tests.id('email_v'), 'email', tests.id('email_v')), (tests.id('phone_v'), 'sms', tests.id('phone_v')) $$,
  'a visit without a contact row is enqueued to its own email and phone, with the visit as recipient');

select is((select count(*) from app.notifications where visit_id = tests.id('typed_v')), 0::bigint,
  'a phone typed at the online join form is not texted until its contact is verified');

create table tests.jobs of api.outbox_job;
insert into tests.jobs select * from api.claim_outbox(50, 60);

select is((select recipient from tests.jobs where visit_id = tests.id('email_v')),
  '{"kind": "address", "value": "lee@example.com"}'::jsonb, 'claim_outbox resolves the visit''s email');
select is((select has_consent from tests.jobs where visit_id = tests.id('email_v')), true,
  'decision 20: the email typed at join consents to transactional mail about that visit');
select is((select recipient ->> 'value' from tests.jobs where visit_id = tests.id('phone_v')), '+14155550177',
  'claim_outbox resolves the visit''s phone');
select results_eq($$ select has_consent, is_suppressed from tests.jobs where visit_id = tests.id('phone_v') $$,
  $$ values (false, true) $$, 'a phone typed at join is not SMS consent, and suppression applies to it');

-- Marketing never rides on the join email.
update app.notifications set category = 'marketing', status = 'queued', next_attempt_at = now()
where visit_id = tests.id('email_v');
select is((select has_consent from api.claim_outbox(50, 60) where visit_id = tests.id('email_v')), false,
  'the join email is not marketing consent');

select * from finish();
rollback;
