-- 3-PAY8: a guest booking of a service with a payment policy stays pending until the card step succeeds.
begin;
\ir ../helpers/_setup.psql
select plan(41);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60
where service_id = tests.id('service_a');
delete from app.payment_jobs;
delete from app.payments;

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00') at time zone 'America/New_York') as slot;
grant select on ctx to public;
create function pg_temp.book(p_name text, p_phone text, p_offset int default 0) returns text
language sql as $$
  select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + p_offset * interval '30 minutes',
          p_name, p_phone, null, 1, null, gen_random_uuid())).status
$$;
grant execute on function pg_temp.book(text, text, int) to public;

-- A policy applies: the guest booking is pending and holds the slot.
select tests.as_anon();
select is(pg_temp.book('Pia', '+15551230001'), 'pending_payment', 'AC1: a guest booking under a payment policy is pending_payment');
select tests.as_postgres();
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx)), 1,
  'AC2: the pending booking holds its slot');
select ok((select payment_due_at between now() + interval '14 minutes' and now() + interval '16 minutes'
           from app.appointments where guest_name = 'Pia'), 'AC3: it is due in the policy window (15 minutes by default)');
select is((select count(*)::int from app.appointments where guest_name = 'Pia' and visit_id is not null), 0, 'a pending booking is not an expected visit');
select is((select count(*)::int from app.appointment_events e join app.appointments a on a.id = e.appointment_id
           where a.guest_name = 'Pia' and e.to_status::text = 'pending_payment'), 1, 'the pending state is recorded as an event');

-- Skipping the card step cannot keep the booking: it expires and the slot is free again.
select is(ops.expire_unpaid_appointments(), 0, 'nothing expires before its due time');
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_name = 'Pia';
select is(ops.expire_unpaid_appointments(), 1, 'AC4: a pending booking past its due time expires');
select is((select status::text || ':' || cancelled_reason from app.appointments where guest_name = 'Pia'), 'cancelled:payment_expired', 'with a reason that says why');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx)), 0,
  'AC5: its slot is free again');
select ok((select payment_due_at is null from app.appointments where guest_name = 'Pia'), 'and it is no longer due');
select is(ops.expire_unpaid_appointments(), 0, 'expiring again is a no-op');

-- Paying confirms it.
select tests.as_anon();
select is(pg_temp.book('Bo', '+15551230002'), 'pending_payment', 'a second guest books');
select tests.as_postgres();
insert into app.payments (org_id, location_id, appointment_id, provider, intent_id, kind, amount_minor, currency, idempotency_key)
select org_id, location_id, id, 'fake', 'pi_bea', 'hold', 500, 'usd', 'bea-key' from app.appointments where guest_name = 'Bo';
select tests.as_service();
select is((select api.apply_payment_event(tests.id('org_a'), 'fake', 'authorized', 'pi_bea', null, 500, null, null)), 'applied', 'the hold is authorized');
select tests.as_postgres();
select is((select status::text from app.appointments where guest_name = 'Bo'), 'booked', 'AC6: an authorized hold confirms the booking');
select ok((select payment_due_at is null from app.appointments where guest_name = 'Bo'), 'and clears its due time');
select is(ops.expire_unpaid_appointments(), 0, 'a confirmed booking never expires');

-- Paid just as the clock ran out: confirmed, not cancelled.
select tests.as_anon();
select is(pg_temp.book('Cyd', '+15551230003', 1), 'pending_payment', 'a third guest books another slot');
select tests.as_postgres();
insert into app.payments (org_id, location_id, appointment_id, provider, intent_id, kind, status, amount_minor, currency, idempotency_key)
select org_id, location_id, id, 'fake', 'pi_cy', 'hold', 'authorized', 500, 'usd', 'cy-key' from app.appointments where guest_name = 'Cyd';
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_name = 'Cyd';
select is(ops.expire_unpaid_appointments(), 0, 'AC7: a booking that was paid is confirmed by the sweep, not expired');
select is((select status::text from app.appointments where guest_name = 'Cyd'), 'booked', 'and stays booked');

-- A card that succeeds after the booking expired is given back.
update app.appointments set status = 'cancelled', cancelled_reason = 'payment_expired' where guest_name = 'Pia';
insert into app.payments (org_id, location_id, appointment_id, provider, intent_id, kind, amount_minor, currency, idempotency_key)
select org_id, location_id, id, 'fake', 'pi_ann', 'hold', 500, 'usd', 'ann-key' from app.appointments where guest_name = 'Pia';
select tests.as_service();
select api.apply_payment_event(tests.id('org_a'), 'fake', 'authorized', 'pi_ann', null, 500, null, null);
select tests.as_postgres();
select is((select count(*)::int from app.payment_jobs j join app.payments p on p.id = j.payment_id
           where p.intent_id = 'pi_ann' and j.action = 'release'), 1, 'AC8: a hold placed after expiry is released');
select is((select status::text from app.appointments where guest_name = 'Pia'), 'cancelled', 'and the booking stays cancelled');

-- Per-contact cap on unpaid bookings, and staff bookings are exempt.
select tests.as_anon();
select pg_temp.book('Dan', '+15551230009', 2);
select pg_temp.book('Dan', '+15551230009', 3);
select pg_temp.book('Dan', '+15551230009', 4);
select throws_ok($$ select pg_temp.book('Dan', '+15551230009', 5) $$, 'P0001', 'rate_limited', 'AC9: a fourth unpaid booking of one contact is refused');
select tests.act_as('staff');
select is((api.staff_book_appointment(tests.id('loc_a'), tests.id('service_a'), (select slot from ctx) + 5 * interval '30 minutes', null, 'Eve',
           '+15551230010', null, 1, false, gen_random_uuid())).status, 'booked', 'AC10: a staff booking is confirmed at once');

-- A pending booking can be cancelled by the guest and by staff, and nobody can pay for a dead one.
select tests.as_postgres();
create temp table dan_tokens as
  select private.visit_token(a.id, a.idempotency_key) as token, a.id from app.appointments a where a.guest_name = 'Dan' order by a.starts_at;
grant select on dan_tokens to public;
select tests.as_anon();
select is((api.guest_cancel_appointment((select token from dan_tokens limit 1), gen_random_uuid())).status, 'cancelled', 'AC11: a guest cancels a pending booking');
select tests.act_as('staff');
select is((api.staff_cancel_appointment((select id from dan_tokens offset 1 limit 1),
           (select version from app.appointments where id = (select id from dan_tokens offset 1 limit 1)), 'test', gen_random_uuid())).status,
          'cancelled', 'AC12: staff cancel a pending booking');
select tests.as_service();
select throws_ok(format($$ select api.begin_payment(%L, 'fake', 'dead-key') $$, (select token from dan_tokens limit 1)), 'P0001', 'not_found',
  'AC13: a cancelled booking cannot start a payment');
select tests.as_postgres();
update app.appointments set payment_due_at = now() - interval '1 second' where id = (select id from dan_tokens offset 2 limit 1);
select tests.as_service();
select throws_ok(format($$ select api.begin_payment(%L, 'fake', 'late-key') $$, (select token from dan_tokens offset 2 limit 1)), 'P0001', 'not_found',
  'AC14: nor can one past its due time, even before the sweep runs');

-- A waitlist claim is a booking too: claiming a held seat of a paid service starts pending, not booked.
select tests.as_postgres();
select tests.as_anon();
create temp table wl_tok as
select (select token from api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + 2 * interval '30 minutes', 'Bob', '+15551230020', null, 1, null, gen_random_uuid())) as bob_token,
       (select api.guest_join_waitlist((select slug from ctx), tests.id('service_a'), ((select slot from ctx) at time zone 'America/New_York')::date, null, null, 'Wes', null, 'wes@example.com', gen_random_uuid())) as wes;
grant select on wl_tok to public;
select api.guest_cancel_appointment((select bob_token from wl_tok), gen_random_uuid());
select is((select status from api.guest_claim_offer((select wes from wl_tok), gen_random_uuid())), 'pending_payment', 'AC15: claiming a waitlist offer of a paid service is pending until the card step succeeds');
select tests.as_postgres();
select ok((select payment_due_at is not null from app.appointments where guest_name = 'Wes'), 'with a due time');

-- A policy switched off while the guest was deciding confirms instead of expiring.
select tests.as_postgres();
update app.payment_policies set mode = 'none' where service_id = tests.id('service_a');
update app.appointments set payment_due_at = now() - interval '1 second' where guest_name = 'Wes';
select is(ops.expire_unpaid_appointments(), 0, 'AC17: a booking whose service no longer asks for payment does not expire');
select is((select status::text from app.appointments where guest_name = 'Wes'), 'booked', 'it is confirmed');

-- A paid booking needs a contact to count against.
select tests.as_postgres();
update app.payment_policies set mode = 'hold' where service_id = tests.id('service_a');
select tests.as_anon();
select throws_ok(format($$ select api.book_appointment(%L, %L, %L, 'Nil', '', '', 1, null, gen_random_uuid()) $$,
  (select slug from ctx), tests.id('service_a'), (select slot from ctx) + 3 * interval '30 minutes'), 'P0001', null, 'AC18: a booking with no phone or email is refused');

select tests.as_postgres();
insert into app.capacity_rules (org_id, service_id, scope, capacity) values (tests.id('org_a'), tests.id('service_a'), 'slot', 5);
-- Without a connected processor a policy cannot be switched on, and no pending holds are made.
select tests.as_postgres();
update app.payment_policies set mode = 'hold' where service_id = tests.id('service_a');
update app.provider_settings set enabled = false where org_id = tests.id('org_a') and channel = 'payments';
select tests.as_anon();
select is(pg_temp.book('Odo', '+15551230031', 3), 'booked', 'AC19: with the processor disconnected a booking is not held pending');
select tests.as_postgres();
update app.payment_policies set mode = 'none' where service_id = tests.id('service_a');
select throws_ok($$ update app.payment_policies set mode = 'deposit' where service_id = tests.id('service_a') $$,
  'P0001', 'payments_not_connected', 'AC20: a policy cannot be switched on without a connected processor');
update app.provider_settings set enabled = true where org_id = tests.id('org_a') and channel = 'payments';
select lives_ok($$ update app.payment_policies set mode = 'hold' where service_id = tests.id('service_a') $$,
  'and can once it is connected');
-- Disconnecting while a booking is pending confirms it instead of expiring on a guest who could not pay.
select tests.as_anon();
select is(pg_temp.book('Pat', '+15551230032', 4), 'pending_payment', 'a booking is pending again once connected');
select tests.as_postgres();
update app.provider_settings set enabled = false where org_id = tests.id('org_a') and channel = 'payments';
update app.appointments set payment_due_at = now() - interval '1 second' where guest_name = 'Pat';
select is(ops.expire_unpaid_appointments(), 0, 'AC21: a pending booking does not expire if the processor disconnected');
select is((select status::text from app.appointments where guest_name = 'Pat'), 'booked', 'it is confirmed');
update app.provider_settings set enabled = true where org_id = tests.id('org_a') and channel = 'payments';

-- Bulk blocks release pending holds in the range, and leave booked ones for the manager.
select tests.as_postgres();
create temp table blk as
  select tests.id('counter_a') as counter, a.id as appt, a.starts_at, a.ends_at
  from app.appointments a where a.guest_name = 'Pat';
grant select on blk to public;
update app.appointments set status = 'pending_payment', payment_due_at = now() + interval '10 minutes' where guest_name = 'Pat';
select tests.act_as('owner');
select api.block_time_bulk(tests.id('loc_a'), array[(select counter from blk)], array[tstzrange((select starts_at from blk) - interval '1 minute', (select ends_at from blk) + interval '1 minute')], 'x', gen_random_uuid());
select tests.as_postgres();
select is((select status::text || ':' || coalesce(cancelled_reason, '') from app.appointments where guest_name = 'Pat'), 'cancelled:blocked', 'AC22: a bulk block cancels a pending hold in its range');
select ok((select payment_due_at is null from app.appointments where guest_name = 'Pat'), 'and it is no longer due');

-- Cross-tenant: another organisation cannot cancel (or learn of) a pending booking.
select tests.act_as('other_owner');
select throws_ok(format($$ select api.staff_cancel_appointment(%L, 0, 'x', gen_random_uuid()) $$, (select id from dan_tokens offset 2 limit 1)),
  'P0001', 'not_found', 'AC16: another tenant cannot cancel a pending booking');

select * from finish();
rollback;
