-- 2P-APT3 (#159): booking RPCs. The 20-way race is in tests/concurrency/booking.test.ts.
begin;
\ir ../helpers/_setup.psql
select plan(20);
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
select 'loc-a-slug'::text as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00') at time zone 'America/New_York') as slot;
update ctx set slug = (select slug from app.locations where id = tests.id('loc_a'));
grant select on ctx to public;
create temp table keys as select gen_random_uuid() k1, gen_random_uuid() k2, gen_random_uuid() k3;
grant select on keys to public;

select tests.as_anon();
select is((select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx), 'Anita', '+15551230001', null, 1, null, (select k1 from keys))).status),
  'booked', 'anon books a slot');
select tests.as_postgres();
create temp table first_token as
  select token from api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx), 'Anita', '+15551230001', null, 1, null, (select k1 from keys));

select is((select count(*)::int from app.appointments where guest_name = 'Anita'), 1, 'AC2: the same key twice leaves one appointment');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx)), 1, 'AC2: and consumes one seat');
select ok((select token from first_token) is not null and length((select token from first_token)) > 20, 'AC2: a repeat returns the same token');
select is((select source from app.appointments where guest_name = 'Anita'), 'guest', 'AC4: source comes from the server');
select is((select staff_user_id from app.appointments where guest_name = 'Anita'), null, 'AC4: no staff chosen by a guest');
select is((select count(*)::int from app.appointments a where a::text like '%' || (select token from first_token) || '%'), 0,
  'AC6: no column holds the plaintext token');
select is((select encode(guest_token_hash, 'hex') from app.appointments where guest_name = 'Anita'), encode(extensions.digest((select token from first_token), 'sha256'), 'hex'),
  'AC6: only its sha256 is stored');

create temp table ann as select id from app.appointments where guest_name = 'Anita';
grant select on ann to public;
select tests.as_anon();
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Bob', '+15551230002', null, 1, null, %L) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx), (select k2 from keys)),
  'P0001', 'slot_full', 'a second guest for a capacity-1 slot gets slot_full');
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Bob', '+15551230002', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '7 minutes'),
  'P0001', 'slot_unavailable', 'AC3: an off-grid slot is slot_unavailable');
select throws_ok(format($$ select api.book_appointment(%L, %L, now() - interval '1 day', 'Bob', '+15551230002', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a')),
  'P0001', 'slot_unavailable', 'AC3: a past slot is slot_unavailable');
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Bob', 'not-a-phone', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '30 minutes'),
  'P0001', 'invalid_input', 'a bad phone number is invalid_input');

-- one phone cannot hold more than 3 upcoming bookings
select tests.as_postgres();
select private.set_actor('system', null);
insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name, guest_phone_e164, source, idempotency_key)
select tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'), (select slot from ctx) + g * interval '1 day',
       (select slot from ctx) + g * interval '1 day' + interval '20 minutes', current_date + 8 + g, 'Dup', '+15551239999', 'guest', gen_random_uuid()
from generate_series(1, 3) g;
select tests.as_anon();
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Dup', '+15551239999', null, 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '1 hour'),
  'P0001', 'rate_limited', 'a fourth upcoming booking for one phone is rate_limited');
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Bob', '+15551230003', null, 1, 'not a locale!', gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '1 hour'),
  'P0001', 'invalid_input', 'a malformed locale is invalid_input');

-- staff
select tests.act_as('other_owner');
select throws_ok(format($$ select api.staff_cancel_appointment(%L, 0, 'x', gen_random_uuid()) $$,
  (select id from ann)),
  'P0001', 'not_found', 'AC5: org B staff cannot cancel an org A appointment');
select tests.act_as('staff');
select throws_ok($$ select idempotency_key from app.appointments $$, '42501', null, 'staff cannot read the idempotency key');
select throws_ok(format($$ select api.staff_book_appointment(%L, %L, %L, null, 'Cy', null, null, 1, true, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('service_a'), (select slot from ctx)),
  '42501', null, 'only manager and up may override capacity');
select tests.act_as('manager');
select is((select (api.staff_book_appointment(tests.id('loc_a'), tests.id('service_a'), (select slot from ctx), null, 'Cy', null, null, 1, true, gen_random_uuid())).status),
  'booked', 'a manager may book a full slot with the override');
select tests.as_postgres();
select is((select count(*)::int from app.audit_log where table_name = 'appointments' and after ->> 'override_capacity' = 'true'), 1,
  'the override is audited');
select tests.act_as('manager');
select is((select (api.staff_cancel_appointment((select id from app.appointments where guest_name = 'Cy'), 0, 'changed mind', gen_random_uuid())).status),
  'cancelled', 'staff cancel releases the booking');

select * from finish();
rollback;
