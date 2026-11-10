-- #682: anonymizing appointments clears typed contact data and push subscriptions.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();
-- The default is now 365 days (C3); these cases are written for a 30-day business.
update app.organizations set retention_days = 30 where id in (tests.id('org_a'), tests.id('org_b'));

select private.set_actor('system', null, 'test', 'test');
insert into app.appointments (id, org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date,
                              guest_name, guest_email, guest_phone_e164, source, idempotency_key)
values (tests.new_id('old_appt'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() - interval '200 days', now() - interval '200 days' + interval '20 minutes', current_date - 200,
        'Rae', 'rae@example.com', '+15551230001', 'guest', gen_random_uuid()),
       (tests.new_id('keep_appt'), tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '2 days', now() + interval '2 days' + interval '20 minutes', current_date + 2,
        'Kim', 'kim@example.com', null, 'guest', gen_random_uuid());
update app.appointments set status = 'completed' where id = tests.id('old_appt');
insert into app.push_subscriptions (org_id, appointment_id, endpoint, p256dh, auth)
values (tests.id('org_a'), tests.id('old_appt'), 'https://push.example/old', 'k', 'a'),
       (tests.id('org_a'), tests.id('keep_appt'), 'https://push.example/keep', 'k', 'a');
insert into app.notifications (org_id, appointment_id, channel, recipient_ref, template_key, template_version, dedupe_key, recipient_hash)
values (tests.id('org_a'), tests.id('old_appt'), 'email', tests.id('old_appt'), 'appointment_reminder', 1, 'ret-1', 'abc');

select ops.retention_tick();
select is((select guest_email from app.appointments where id = tests.id('old_appt')), null, 'the typed email is cleared');
select is((select guest_phone_e164 from app.appointments where id = tests.id('old_appt')), null, 'the typed phone is cleared');
select is((select count(*)::int from app.push_subscriptions where appointment_id = tests.id('old_appt')), 0, 'its push subscriptions are deleted');
select is((select recipient_hash from app.notifications where dedupe_key = 'ret-1'), null, 'the address hash on its notification is cleared');
select is((select guest_email from app.appointments where id = tests.id('keep_appt')), 'kim@example.com', 'an upcoming appointment keeps its email');
select is((select count(*)::int from app.push_subscriptions where appointment_id = tests.id('keep_appt')), 1, 'and its push subscription');

select * from finish();
rollback;
