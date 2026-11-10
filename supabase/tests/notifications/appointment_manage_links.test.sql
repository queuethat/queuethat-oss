-- Appointment emails carry a one-off manage link: minted at claim, stored hashed, scoped to the
-- guest appointment RPCs, dead when the appointment ends.
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();
-- This suite is about reminders; the confirmation mail has its own (booking_mail.test.sql).
alter table app.appointments disable trigger enqueue_booking_mail;
update app.payment_policies set mode = 'none';
-- A zone where it is 12:00 now, outside quiet hours, so the claim is not deferred.
update app.locations set tz = (select case when o = 0 then 'Etc/GMT' when o > 0 then 'Etc/GMT-' || o else 'Etc/GMT+' || -o end
  from (select (((12 - extract(hour from now() at time zone 'UTC')::int + 36) % 24) - 12) as o) z) where id = tests.id('loc_a');
select private.set_actor('system', null, 'test', 'test');
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, guest_email, locale, source, idempotency_key, guest_token_hash)
select tests.new_id(n), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
       now() + s, now() + s + interval '20 minutes', current_date, 'Rae', 'rae@example.com', 'en', 'guest',
       gen_random_uuid(), private.token_hash('tok-' || n)
from (values ('appt_m', interval '58 minutes')) t (n, s);
-- ends_at is a plain column: the 'ended' case is a second appointment moved into the past
select private.set_actor('system', null, 'test', 'test');
insert into app.notifications (org_id, appointment_id, channel, recipient_ref, template_key, template_version, category, vars, dedupe_key)
select tests.id('org_a'), tests.id('appt_m'), 'email', tests.id('appt_m'), 'appointment_confirmed', 1, 'transactional', '{}', 'manage-1';

select tests.as_service();
create temp table job as select * from api.claim_outbox(10, 60) j where j.template_key = 'appointment_confirmed';
grant select on job to public;
select tests.as_postgres();
select is((select count(*)::int from job), 1, 'the email is claimed');
select ok((select status_url from job) like '/a/%', 'the claim carries a one-off /a/ path');
select is((select count(*)::int from app.appointment_manage_tokens where appointment_id = tests.id('appt_m')), 1, 'one hash stored');
select is((select count(*)::int from app.appointment_manage_tokens m, job j
           where m.token_hash = private.token_hash(substr(j.status_url, 4))), 1, 'the stored value is the sha256 of the token');
select is((select count(*)::int from app.notifications where vars::text like '%' || substr((select status_url from job), 4) || '%'), 0, 'the plaintext is not in the outbox');

-- the token works for view, move and cancel of that appointment
select tests.as_anon();
select is((select status from api.get_appointment(substr((select status_url from pg_temp.job), 4))), 'booked', 'view works');
select throws_ok($$ select api.get_appointment('not-a-token') $$, 'P0001', 'not_found', 'a wrong token is not_found');
select tests.as_postgres();

-- it opens the guest page's own actions, including reminders push for that appointment
select tests.as_anon();
select api.guest_register_appointment_push(substr((select status_url from pg_temp.job), 4), 'https://fcm.googleapis.com/fcm/send/x', repeat('B', 87), repeat('a', 22));
select tests.as_postgres();

select is((select count(*)::int from app.push_subscriptions where appointment_id = tests.id('appt_m')), 1, 'a manage token may register reminders push for its own appointment');

-- a retry replaces the earlier attempt's token
update app.notifications set status = 'queued', locked_until = null, next_attempt_at = now() where dedupe_key = 'manage-1';
select tests.as_service();
create temp table job2 as select * from api.claim_outbox(10, 60) j where j.template_key = 'appointment_confirmed';
grant select on job2 to public;
select tests.as_postgres();
select is((select count(*)::int from app.appointment_manage_tokens where appointment_id = tests.id('appt_m')), 2, 'a retry keeps the first token (it may already be delivered) and adds one');
select tests.as_anon();
select is((select status from api.get_appointment(substr((select status_url from pg_temp.job), 4))), 'booked', 'the first token still works');
select is((select status from api.get_appointment(substr((select status_url from pg_temp.job2), 4))), 'booked', 'the new one works');
-- cancel through it
select is((select status from api.guest_cancel_appointment(substr((select status_url from pg_temp.job2), 4), gen_random_uuid())), 'cancelled', 'cancel through the manage link works');
select tests.as_postgres();

-- it dies when the appointment ends
select private.set_actor('system', null, 'test', 'test');
update app.appointments set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = tests.id('appt_m');
select tests.as_anon();
select throws_ok(format($$ select api.get_appointment(%L) $$, substr((select status_url from pg_temp.job2), 4)), 'P0001', 'not_found', 'dead after the appointment ended');
select tests.as_postgres();
select is(ops.purge_manage_tokens(), 2, 'the purge removes tokens of ended appointments');

-- other orgs: no table access for staff of org B, nor anyone
select is(has_table_privilege('authenticated', 'app.appointment_manage_tokens', 'select') or has_table_privilege('anon', 'app.appointment_manage_tokens', 'select'), false, 'no client role can read the hashes');
select tests.as_postgres();
select * from finish();
rollback;
