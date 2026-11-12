-- 2P-APT4 (#160): guest view, reschedule and cancel by link token.
begin;
\ir ../helpers/_setup.psql
select plan(16);
select tests.create_world();
-- Payment policies are covered by payments/require_card.test.sql; this suite books without a card step.
update app.payment_policies set mode = 'none';

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60
where service_id = tests.id('service_a');

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00') at time zone 'America/New_York') as slot;
grant select on ctx to public;

-- Ann books 09:00, Bob books 10:00 (so 10:00 is full), Cy is a bystander
select tests.as_anon();
create temp table tok as
select (select token from api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx), 'Anita', '+15551230001', 'ann@example.com', 1, null, gen_random_uuid())) as ann,
       (select token from api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '1 hour', 'Bob', '+15551230002', null, 1, null, gen_random_uuid())) as bob;
grant select on tok to public;

-- AC1
select is((select (to_jsonb(api.get_appointment((select ann from tok))) - 'starts_at' - 'ends_at' - 'as_of') - 'status' - 'service_name' - 'location_name' - 'location_slug' - 'can_reschedule' - 'can_cancel' - 'provider_name'),
  '{}'::jsonb, 'AC1: the response holds no field beyond times, status, names (service, location, provider line) and flags');
select is((select (api.get_appointment((select ann from tok))).can_reschedule), true, 'a booking a week out can be moved');

-- AC3: a full target changes nothing
select throws_ok(format($$ select api.guest_reschedule_appointment(%L, %L, gen_random_uuid()) $$, (select ann from tok), (select slot from ctx) + interval '1 hour'),
  'P0001', 'slot_full', 'AC3: moving to a full slot is slot_full');
select is((select (api.get_appointment((select ann from tok))).starts_at), (select slot from ctx), 'AC3: the original booking is unchanged');
select throws_ok(format($$ select api.guest_reschedule_appointment(%L, now() + interval '10 minutes', gen_random_uuid()) $$, (select ann from tok)),
  'P0001', 'too_late_to_change', 'a target inside min_notice is too_late_to_change');

-- a free slot works and keeps the token
select is((select (api.guest_reschedule_appointment((select ann from tok), (select slot from ctx) + interval '30 minutes', gen_random_uuid())).starts_at),
  (select slot from ctx) + interval '30 minutes', 'reschedule moves the appointment');
select is((select (api.get_appointment((select ann from tok))).status), 'booked', 'the same token still works');
select tests.as_postgres();
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx)), 0, 'the old seat is released');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx) + interval '30 minutes'), 1, 'the new seat is taken');
select is((select count(*)::int from app.appointment_events e join app.appointments a on a.id = e.appointment_id where a.guest_name = 'Anita' and e.type = 'rescheduled'), 1, 'a rescheduled event is written');

select throws_ok(format($$ select api.guest_reschedule_appointment(%L, 'infinity', gen_random_uuid()) $$, (select ann from tok)),
  'P0001', 'invalid_input', 'a non-finite target is invalid_input');

-- AC4: cancel twice
select tests.as_anon();
select is((select (api.guest_cancel_appointment((select ann from tok), gen_random_uuid())).status), 'cancelled', 'cancel works');
select is((select (api.guest_cancel_appointment((select ann from tok), gen_random_uuid())).status), 'cancelled', 'AC4: cancelling twice is a no-op');
select tests.as_postgres();
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx) + interval '30 minutes'), 0, 'AC4: the seat is released once');

-- AC2 / AC5: unknown and expired tokens are alike
select tests.as_anon();
select throws_ok($$ select api.get_appointment('no-such-token') $$, 'P0001', 'not_found', 'AC2/AC5: an unknown token is not_found');

select tests.as_postgres();
select private.set_actor('system', null);
update app.appointments set starts_at = now() - interval '14 hours', ends_at = now() - interval '13 hours' where guest_name = 'Bob';
select tests.as_anon();
select throws_ok(format($$ select api.get_appointment(%L) $$, (select bob from tok)), 'P0001', 'not_found',
  'AC2: a token 13 h after the appointment ended gives the same not_found');

select * from finish();
rollback;
