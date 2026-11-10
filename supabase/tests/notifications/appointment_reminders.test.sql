-- 2P-APT10 (#166): appointment reminders through the outbox.
begin;
\ir ../helpers/_setup.psql
select plan(28);
select tests.create_world();
-- This suite is about reminders; the confirmation mail has its own (booking_mail.test.sql).
alter table app.appointments disable trigger enqueue_booking_mail;
-- Payment policies are covered by payments/require_card.test.sql; this suite books without a card step.
update app.payment_policies set mode = 'none';

-- A time zone where it is 12:00 now (outside quiet hours) and one where it is 02:00 (inside).
create function pg_temp.zone_at(p_hour int) returns text language sql as $$
  select case when o = 0 then 'Etc/GMT' when o > 0 then 'Etc/GMT-' || o else 'Etc/GMT+' || -o end
  from (select (((p_hour - extract(hour from now() at time zone 'UTC')::int + 36) % 24) - 12) as o) s
$$;

select is(private.quiet_hours_end('2026-03-10 23:30+00', 'UTC'), '2026-03-11 08:00+00'::timestamptz, 'late evening waits for the next 08:00');
select is(private.quiet_hours_end('2026-03-10 03:00+00', 'UTC'), '2026-03-10 08:00+00'::timestamptz, 'the small hours wait for 08:00 the same day');
select is(private.quiet_hours_end('2026-03-10 12:00+00', 'UTC'), '2026-03-10 12:00+00'::timestamptz, 'daytime is not held');

update app.locations set tz = pg_temp.zone_at(12) where id = tests.id('loc_a');
select private.set_actor('system', null, 'test', 'test');
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, guest_email, guest_phone_e164, locale, source, idempotency_key, guest_token_hash)
select tests.new_id(n), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
       now() + s, now() + s + interval '20 minutes', current_date, 'Rae', e, p, 'en', 'guest', gen_random_uuid(),
       private.token_hash('tok-' || n)
from (values ('appt_1h', interval '58 minutes', 'rae@example.com', '+15551230001'),
             ('appt_24h', interval '1438 minutes', null, null),
             ('appt_far', interval '5 days', 'far@example.com', null)) t (n, s, e, p);

-- AC5: a typed email gets a reminder, a typed phone never gets an SMS
select is(ops.enqueue_appointment_reminders(), 1, 'the tick queues the 1 h email only: no phone text, nothing for the far or contactless ones');
select is((select count(*)::int from app.notifications where appointment_id = tests.id('appt_1h') and channel = 'email'), 1, 'typed email: one row');
select is((select count(*)::int from app.notifications where appointment_id = tests.id('appt_1h') and channel = 'sms'), 0, 'AC5: typed phone: no SMS row');
select is((select count(*)::int from app.notifications where appointment_id = tests.id('appt_far')), 0, 'a far-off appointment gets nothing yet');
select is((select count(*)::int from app.notifications where appointment_id = tests.id('appt_24h')), 0, 'no contact, no push: no row');

-- AC1: push, and the next tick adds nothing
select tests.as_anon();
select api.guest_register_appointment_push('tok-appt_24h', 'https://fcm.googleapis.com/fcm/send/abc',
  repeat('B', 87), repeat('a', 22));
select api.guest_register_appointment_push('tok-appt_24h', 'https://fcm.googleapis.com/fcm/send/abc',
  repeat('B', 87), repeat('a', 22));
select tests.as_postgres();
select is((select count(*)::int from app.push_subscriptions where appointment_id = tests.id('appt_24h')), 1, 'registering twice keeps one subscription');
select is(ops.enqueue_appointment_reminders(), 1, 'the 24 h reminder is queued for the subscribed browser');
select is(ops.enqueue_appointment_reminders(), 0, 'AC1: a second tick queues nothing');
select is((select count(*)::int from app.notifications where appointment_id = tests.id('appt_24h') and template_key = 'appointment_reminder'), 1, 'AC1: exactly one 24 h reminder row');
select is(api.outbox_still_relevant((select id from app.notifications where appointment_id = tests.id('appt_24h'))), true, 'a booked appointment''s reminder is relevant');

-- the dispatcher's view of the typed-email row
select tests.as_service();
create temp table job as select * from api.claim_outbox(50, 60) j where j.channel = 'email';
select tests.as_postgres();
select results_eq($$ select (recipient ->> 'value'), has_consent, location_tz from job where visit_id is null limit 1 $$,
  $$ values ('rae@example.com'::text, true, (select tz from app.locations where id = tests.id('loc_a'))) $$,
  'claim: typed email is the recipient, counts as transactional consent and carries the location zone');

-- AC2: a reschedule makes the old row irrelevant and queues a new one (email and the browser's push)
select tests.as_anon();
select api.guest_register_appointment_push('tok-appt_1h', 'https://fcm.googleapis.com/fcm/send/def', repeat('C', 87), repeat('b', 22));
select tests.as_postgres();
select private.set_actor('guest', null, 'reschedule', 'guest');
update app.appointments set starts_at = now() + interval '59 minutes', ends_at = now() + interval '79 minutes' where id = tests.id('appt_1h');
select is(api.outbox_still_relevant((select id from app.notifications where appointment_id = tests.id('appt_1h') and channel = 'email')), false,
  'AC2: a reminder for the old time is dropped');
select is(ops.enqueue_appointment_reminders(), 2, 'AC2: the new time gets fresh reminders');

-- AC3: cancelled
select private.set_actor('guest', null, 'cancel', 'guest');
update app.appointments set status = 'cancelled' where id = tests.id('appt_24h');
select is(api.outbox_still_relevant((select id from app.notifications where appointment_id = tests.id('appt_24h'))), false, 'AC3: a cancelled appointment''s reminder is not relevant');

-- AC4: at 02:00 local the email would wait for 08:00, after the start: dropped. Push is not held. At 12:00 it stays.
create temp table fresh as
select n.id, n.channel from app.notifications n join app.appointments a on a.id = n.appointment_id
where a.id = tests.id('appt_1h') and (n.vars ->> 'starts_epoch')::bigint = floor(extract(epoch from a.starts_at))::bigint;
select is((select count(*)::int from fresh), 2, 'two rows carry the current start');
select is(api.outbox_still_relevant((select id from fresh where channel = 'email')), true, 'daytime: the 1 h email stays');
update app.locations set tz = pg_temp.zone_at(2) where id = tests.id('loc_a');
select is(api.outbox_still_relevant((select id from fresh where channel = 'email')), false, 'AC4: quiet hours would hold the email past the start, so it is dropped');
select is(api.outbox_still_relevant((select id from fresh where channel = 'push')), true, 'AC4: web push is not held by quiet hours');

-- A guest who is not consenting through a staff-linked contact gets nothing queued (AC5)
update app.locations set tz = pg_temp.zone_at(12) where id = tests.id('loc_a');
insert into app.guests (id, org_id, first_name) values (tests.new_id('g1'), tests.id('org_a'), 'Linked');
insert into app.guest_contacts (id, org_id, guest_id, channel, value, created_source)
values (tests.new_id('c1'), tests.id('org_a'), tests.id('g1'), 'email', 'linked@example.com', 'staff');
select private.set_actor('system', null, 'test', 'test');
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, contact_id, locale, source, idempotency_key)
values (tests.new_id('appt_c'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '58 minutes', now() + interval '78 minutes', current_date, 'Linked', tests.id('c1'), 'en', 'staff', gen_random_uuid());
select is(ops.enqueue_appointment_reminders(), 0, 'AC5: a linked contact without consent gets no row');
insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version, consent_text_hash,
                          attested_at, attestation_text_version)
values (tests.id('org_a'), tests.id('c1'), 'email', 'transactional', 'granted', 'staff', 'v1', 'h', now(), 1);
select is(ops.enqueue_appointment_reminders(), 1, 'AC5: with consent the linked contact is queued');

-- Typed email is stoppable: unsubscribing the row suppresses the address
select api.unsubscribe_outbox((select id from fresh where channel = 'email'));
select is((select count(*)::int from app.suppressions where org_id = tests.id('org_a') and value = 'rae@example.com' and reason = 'stop'), 1,
  'unsubscribing an appointment email stops the address');

-- AC6: another org's staff see none of these rows
select tests.act_as('other_owner');
select is((select count(*)::int from app.notifications where appointment_id is not null), 0, 'AC6: org B staff select zero appointment rows');
select throws_ok($$ select api.guest_register_appointment_push('tok-appt_1h', 'http://evil.example/x', repeat('C', 87), repeat('b', 22)) $$,
  null, null, 'a non-push endpoint is rejected (as authenticated)');
select tests.as_anon();
select throws_ok($$ select api.guest_register_appointment_push('no-such-token', 'https://fcm.googleapis.com/fcm/send/z', repeat('C', 87), repeat('b', 22)) $$,
  'P0001', 'not_found', 'an unknown token is not_found');
select throws_ok($$ select api.guest_register_appointment_push('tok-appt_1h', 'http://evil.example/x', repeat('C', 87), repeat('b', 22)) $$,
  'P0001', 'invalid_input', 'a non-push endpoint is invalid_input');

select * from finish();
rollback;
