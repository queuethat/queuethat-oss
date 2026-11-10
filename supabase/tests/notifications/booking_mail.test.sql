-- Confirmation and expiry mail for guest bookings.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes) values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60 where service_id = tests.id('service_a');
delete from app.payment_jobs;
delete from app.payments;
update app.payment_policies set mode = 'none' where service_id = tests.id('service_a');

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00') at time zone 'America/New_York') as slot;
grant select on ctx to public;
create function pg_temp.book(p_name text, p_phone text, p_email text, p_offset int default 0) returns text
language sql as $$
  select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + p_offset * interval '30 minutes',
          p_name, p_phone, p_email, 1, null, gen_random_uuid())).status
$$;
grant execute on function pg_temp.book(text, text, text, int) to public;
create function pg_temp.mail(p_name text, p_key text) returns int language sql as $$
  select count(*)::int from app.notifications n join app.appointments a on a.id = n.appointment_id
  where a.guest_name = p_name and n.template_key = p_key
$$;

-- no card due: confirmed at once, one email to the typed address
select tests.as_anon();
select is(pg_temp.book('Free Fay', null, 'fay@example.com'), 'booked', 'a free booking is booked');
select tests.as_postgres();
select is(pg_temp.mail('Free Fay', 'appointment_confirmed'), 1, 'it queues one confirmation');
select is((select channel::text from app.notifications n join app.appointments a on a.id = n.appointment_id where a.guest_name = 'Free Fay' and n.template_key = 'appointment_confirmed'), 'email', 'by email');
-- a typed phone alone is never texted; no email, no mail
select tests.as_anon();
select pg_temp.book('Phone Pat', '+15551230001', null, 1);
select tests.as_postgres();
select is(pg_temp.mail('Phone Pat', 'appointment_confirmed'), 0, 'a phone-only guest gets no mail');
-- the confirmation is relevant while the booking stands
select is(api.outbox_still_relevant((select n.id from app.notifications n join app.appointments a on a.id = n.appointment_id where a.guest_name = 'Free Fay' and n.template_key = 'appointment_confirmed')), true, 'relevant while booked');

-- a card is due: pending sends nothing, paying confirms, lapsing sends the expiry notice
update app.payment_policies set mode = 'hold' where service_id = tests.id('service_a');
insert into app.provider_settings (org_id, channel, provider, mode, enabled) values (tests.id('org_a'), 'payments', 'stripe', 'own', true) on conflict do nothing;
select tests.as_anon();
select is(pg_temp.book('Pay Pia', null, 'pia@example.com', 2), 'pending_payment', 'a held booking is pending');
select is(pg_temp.book('Late Lou', null, 'lou@example.com', 3), 'pending_payment', 'another pending booking');
select tests.as_postgres();
select is(pg_temp.mail('Pay Pia', 'appointment_confirmed'), 0, 'pending: no confirmation yet');
select private.set_actor('system', null, 'test', 'test');
update app.appointments set status = 'booked', payment_due_at = null where guest_name = 'Pay Pia';
select is(pg_temp.mail('Pay Pia', 'appointment_confirmed'), 1, 'paid: the confirmation goes');
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_name = 'Late Lou';
select ops.expire_unpaid_appointments();
select is(pg_temp.mail('Late Lou', 'appointment_expired'), 1, 'lapsed unpaid: one expiry notice');
select is(pg_temp.mail('Late Lou', 'appointment_confirmed'), 0, 'and no confirmation');
select is(api.outbox_still_relevant((select n.id from app.notifications n join app.appointments a on a.id = n.appointment_id where a.guest_name = 'Late Lou' and n.template_key = 'appointment_expired')), true, 'the expiry notice is relevant while the booking is cancelled unpaid');
-- staff-made bookings send nothing
insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name, guest_email, source, idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'), now() + interval '2 days', now() + interval '2 days 20 minutes', current_date, 'Desk Dee', 'dee@example.com', 'staff', gen_random_uuid());
select is(pg_temp.mail('Desk Dee', 'appointment_confirmed'), 0, 'a staff booking sends no confirmation');
select * from finish();
rollback;
