-- 2B-A1 (#276): slot waitlist. A freed slot is held for the oldest matching guest, expires to the next, and can be claimed once.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
-- Payment policies are covered by payments/require_card.test.sql; this suite is about the waitlist.
update app.payment_policies set mode = 'none';
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60
where service_id = tests.id('service_a');

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '10:00') at time zone 'America/New_York') as slot;
grant select on ctx to public;

-- Bob holds the only 10:00 seat; Wes then Wen wait for that day
select tests.as_anon();
create temp table tok as
select (select token from api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx), 'Bob', '+15551230002', 'bob@example.com', 1, null, gen_random_uuid())) as bob,
       (select api.guest_join_waitlist((select slug from ctx), tests.id('service_a'), ((select slot from ctx) at time zone 'America/New_York')::date, null, null, 'Wes', null, 'wes@example.com', gen_random_uuid())) as wes;
grant select on tok to public;
select tests.as_postgres();
update app.slot_waitlist set created_at = now() - interval '1 minute' where name = 'Wes'; -- one transaction, so now() ties
select tests.as_anon();
create temp table tok2 as
select (select api.guest_join_waitlist((select slug from ctx), tests.id('service_a'), ((select slot from ctx) at time zone 'America/New_York')::date, null, null, 'Wen', '+15551230009', 'wen@example.com', gen_random_uuid())) as wen;
grant select on tok2 to public;

select is((select count(*)::int from api.get_available_slots((select slug from ctx), tests.id('service_a'), ((select slot from ctx) at time zone 'America/New_York')::date, ((select slot from ctx) at time zone 'America/New_York')::date) where slot_start = (select slot from ctx)), 0, 'the 10:00 slot is full');
select throws_ok(format($$ select api.guest_join_waitlist(%L, %L, current_date + 5, null, null, 'X', null, null, gen_random_uuid()) $$, (select slug from ctx), tests.id('service_a')),
  'P0001', 'invalid_input', 'an email is required');
select throws_ok(format($$ select api.guest_join_waitlist(%L, %L, current_date - 3, null, null, 'X', null, 'x@example.com', gen_random_uuid()) $$, (select slug from ctx), tests.id('service_a')),
  'P0001', 'invalid_input', 'a past day is refused');

-- AC1: Bob cancels; only the first waiting guest is offered the slot, and it shows held
select api.guest_cancel_appointment((select bob from tok), gen_random_uuid());
select tests.as_postgres();
select is((select status::text from app.slot_waitlist where name = 'Wes'), 'offered', 'AC1: the first waiting guest is offered the freed slot');
select is((select status::text from app.slot_waitlist where name = 'Wen'), 'waiting', 'AC1: the second is not');
select is((select count(*)::int from app.notifications where template_key = 'slot_offer'), 1, 'AC1: exactly one slot_offer message is queued');
select is((select count from app.appointment_slot_counts where service_id = tests.id('service_a') and slot_start = (select slot from ctx)), 1, 'AC1: the slot is held (capacity still taken)');
select is((select count(*)::int from app.appointments where service_id = tests.id('service_a') and starts_at = (select slot from ctx) and status::text = 'offered'), 1, 'the hold is an appointment in status offered');

create temp table wes_id as select id from app.slot_waitlist where name = 'Wes';
-- AC2: the offer expires unclaimed; the tick offers the second guest
update app.slot_waitlist set offer_expires_at = now() - interval '1 minute' where name = 'Wes';
select tests.as_anon();
select throws_ok(format($$ select api.guest_claim_offer(%L, gen_random_uuid()) $$, (select wes from tok)), 'P0001', 'offer_expired', 'an expired offer cannot be claimed');
select tests.as_postgres();
select is(ops.waitlist_tick(), 1, 'the tick expires one offer');
select is((select status::text from app.slot_waitlist where id = (select id from wes_id)), 'expired', 'AC2: the first guest''s offer expired');
select is((select status::text from app.slot_waitlist where name = 'Wen'), 'offered', 'AC2: and the second guest is offered the slot');
select is((select guest_email from app.slot_waitlist where id = (select id from wes_id)), null, 'contact data is scrubbed once an entry ends');

-- AC3: the claim books the held seat once; a repeat is the same booking, and no second appointment exists
select tests.as_anon();
select is((select status from api.guest_claim_offer((select wen from tok2), gen_random_uuid())), 'booked', 'the second guest claims the slot');
select is((select status from api.guest_claim_offer((select wen from tok2), gen_random_uuid())), 'booked', 'claiming again returns the same booking');
select tests.as_postgres();
select is((select count(*)::int from app.appointments where service_id = tests.id('service_a') and starts_at = (select slot from ctx) and status::text in ('booked', 'offered')), 1, 'AC3: exactly one live appointment holds the seat');
select tests.as_anon();
select throws_ok(format($$ select api.guest_claim_offer(%L, gen_random_uuid()) $$, 'no-such-token'), 'P0001', 'not_found', 'an unknown token is not_found');
select lives_ok(format($$ select api.guest_leave_waitlist(%L) $$, 'no-such-token'), 'leaving with an unknown token is a no-op');

-- AC4
select tests.act_as('other_owner');
select is((select count(*)::int from app.slot_waitlist), 0, 'AC4: org B staff select zero org A waitlist rows');

select * from finish();
rollback;
