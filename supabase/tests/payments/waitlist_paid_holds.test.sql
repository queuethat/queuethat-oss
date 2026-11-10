-- The waitlist cannot be used to hold paid slots around the pass and the cap.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.capacity_rules where service_id = tests.id('service_a');
delete from app.availability_rules;
insert into app.business_hours (org_id, location_id, weekday, opens, closes)
values (tests.id('org_a'), tests.id('loc_a'), 1, '09:00', '12:00');
insert into app.capacity_rules (org_id, location_id, service_id, scope, capacity)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), 'slot', 100);
update app.booking_policies set slot_minutes = 30, slot_offset_minutes = 0, min_notice_minutes = 60
where service_id = tests.id('service_a');
delete from app.payment_jobs;
delete from app.payments;

create temp table ctx as
select (select slug from app.locations where id = tests.id('loc_a')) as slug,
       ((current_date + 7 + ((1 - extract(dow from current_date)::int + 7) % 7) + time '09:00') at time zone 'America/New_York') as slot;
grant select on ctx to public;

update private.deployment_settings set turnstile_site_key = '1x00000000000000000000AA', turnstile_hostnames = '{localhost}';
select tests.as_service();
create temp table passes as select row_number() over () as n, api.issue_join_pass('localhost') as p from generate_series(1, 26);
grant select on passes to anon;
select tests.as_anon();
create function pg_temp.pass(n int) returns text language sql as $$ select p from passes where passes.n = $1 $$;
create function pg_temp.book(p_phone text, p_pass int, p_offset int default 0) returns text
language sql as $$
  select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + p_offset * interval '30 minutes',
          'Guest', p_phone, null, 1, null, gen_random_uuid(), pg_temp.pass(p_pass))).status
$$;
create function pg_temp.wait(p_email text, p_key uuid, p_pass text) returns text language sql as $$
  select api.guest_join_waitlist((select slug from ctx), tests.id('service_a'), ((select slot from ctx) at time zone 'America/New_York')::date,
         null, null, 'Wes', null, p_email, p_key, p_pass)
$$;
grant execute on function pg_temp.pass(int), pg_temp.book(text, int, int), pg_temp.wait(text, uuid, text) to public;

-- Joining the waitlist for a paid service needs a pass.
select throws_ok($$ select pg_temp.wait('a@example.com', gen_random_uuid(), null) $$, 'P0001', 'captcha_required',
  'a waitlist entry for a paid service without a pass is refused');
select throws_ok($$ select pg_temp.wait('a@example.com', gen_random_uuid(), 'made-up-pass-made-up-pass-made-up') $$, 'P0001', 'captcha_required',
  'so is one with a pass nobody issued');
create temp table k1 as select gen_random_uuid() as k;
grant select on k1 to anon;
create temp table w1 as select pg_temp.wait('wes@example.com', (select k from k1), pg_temp.pass(1)) as tok;
grant select on w1 to anon;
select ok((select tok from w1) is not null, 'a valid pass joins the waitlist');
select is(pg_temp.wait('wes@example.com', (select k from k1), null), (select tok from w1), 'a replay of the same entry needs no pass');
select throws_ok($$ select pg_temp.wait('b@example.com', gen_random_uuid(), pg_temp.pass(1)) $$, 'P0001', 'captcha_required',
  'a spent pass cannot buy a different entry');

-- Bob holds 09:00; when he cancels, Wes is offered it.
create temp table bob as select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx),
  'Bob', '+15551230002', null, 1, null, gen_random_uuid(), pg_temp.pass(2))).token as t;
grant select on bob to anon;
select api.guest_cancel_appointment((select t from bob), gen_random_uuid());
select tests.as_postgres();
select is((select status::text from app.slot_waitlist where guest_email = 'wes@example.com'), 'offered', 'Wes is offered the freed slot');

-- The open offer holds a seat, so it counts toward the cap: 19 holds fill it, and the 20th booking is refused.
select tests.as_anon();
select lives_ok($$ select pg_temp.book('+1555123' || lpad((g + 10)::text, 4, '0'), g + 2, 1) from generate_series(1, 19) g $$,
  'nineteen holds fit beside the open offer');
select throws_ok($$ select pg_temp.book('+15551239999', 22, 1) $$, 'P0001', 'rate_limited', 'the offer counted, so a 20th hold is refused');

-- A claim converts a seat that is already counted, so a full cap never burns a real guest's offer.
select is((select status from api.guest_claim_offer((select tok from w1), gen_random_uuid())), 'pending_payment',
  'the claim goes through with the cap full and is held pending the card');

-- No new offer is made while the cap is full; the entry keeps waiting for the next freed slot.
create temp table z as select pg_temp.wait('zed@example.com', gen_random_uuid(), pg_temp.pass(23)) as tok;
select tests.as_postgres();
select private.offer_freed_slot(a) from app.appointments a where guest_name = 'Bob';
select is((select status::text from app.slot_waitlist where guest_email = 'zed@example.com'), 'waiting', 'a full cap makes no offer');
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_phone_e164 = '+15551230011';
select private.offer_freed_slot(a) from app.appointments a where guest_name = 'Bob';
select is((select status::text from app.slot_waitlist where guest_email = 'zed@example.com'), 'offered', 'once a hold expires the entry is offered the slot');

-- One solve cannot buy both a booking and a waitlist entry.
select tests.as_anon();
create temp table k2 as select gen_random_uuid() as k;
grant select on k2 to anon;
select is((api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '7 days',
           'Cy', '+15551238888', null, 1, null, (select k from k2), pg_temp.pass(24))).status, 'pending_payment', 'a pass buys a booking');
select throws_ok($$ select pg_temp.wait('cy@example.com', (select k from k2), pg_temp.pass(24)) $$, 'P0001', 'captcha_required',
  'the same pass and key cannot also buy a waitlist entry');

select * from finish();
rollback;
