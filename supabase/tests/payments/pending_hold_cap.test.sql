-- Slot hogging in the card step: a location caps its unpaid holds, and a paid booking needs a Turnstile pass.
begin;
\ir ../helpers/_setup.psql
select plan(14);
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
create function pg_temp.book(p_phone text, p_key uuid default gen_random_uuid(), p_pass text default null) returns text
language sql as $$
  select (api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx),
          'Guest', p_phone, null, 1, null, p_key, p_pass)).status
$$;
grant execute on function pg_temp.book(text, uuid, text) to public;

-- 20 distinct contacts fill the location's unpaid holds; the 21st is refused whoever it is.
select tests.as_anon();
select lives_ok($$ select pg_temp.book('+1555123' || lpad(g::text, 4, '0')) from generate_series(1, 20) g $$,
  'twenty different contacts can each hold a slot');
select tests.as_postgres();
select is((select count(*)::int from app.appointments where payment_due_at is not null and location_id = tests.id('loc_a')), 20,
  'and all twenty are pending holds');
select tests.as_anon();
select throws_ok($$ select pg_temp.book('+15551239999') $$, 'P0001', 'rate_limited', 'a 21st unpaid hold is refused');
select throws_ok($$ select pg_temp.book('+15551239998') $$, 'P0001', 'rate_limited', 'even from a brand new contact');
select tests.as_postgres();
select is((select count(*)::int from app.appointments where location_id = tests.id('loc_a') and payment_due_at is not null), 20, 'a refused booking consumes nothing');

-- The cap is per service and day: the same slot a week later is unaffected.
select is((api.book_appointment((select slug from ctx), tests.id('service_a'), (select slot from ctx) + interval '7 days',
           'Guest', '+15551238888', null, 1, null, gen_random_uuid())).status, 'pending_payment',
  'twenty holds on one day do not block another day');

-- A hold past its due time stops counting before the sweep runs.
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_phone_e164 = '+15551230002';
select tests.as_anon();
select is(pg_temp.book('+15551239996'), 'pending_payment', 'an overdue hold no longer counts, swept or not');
select tests.as_postgres();

-- Paying or expiring a hold makes room straight away.
update app.appointments set payment_due_at = now() - interval '1 minute' where guest_phone_e164 = '+15551230001';
select is(ops.expire_unpaid_appointments(), 2, 'both overdue holds expire');
select tests.as_anon();
select is(pg_temp.book('+15551239997'), 'pending_payment', 'and a new booking fits again');
select tests.as_postgres();

-- Turnstile: with a site key, a paid-service booking needs a pass; it is spent like a join pass.
update app.appointments set payment_due_at = now() - interval '1 minute' where payment_due_at is not null;
select ops.expire_unpaid_appointments();
update private.deployment_settings set turnstile_site_key = '1x00000000000000000000AA', turnstile_hostnames = '{localhost}';
select tests.as_service();
create temp table passes as select api.issue_join_pass('localhost') as p from generate_series(1, 2);
grant select on passes to anon;
select tests.as_anon();
select throws_ok($$ select pg_temp.book('+15551230101') $$, 'P0001', 'captcha_required', 'a paid booking without a pass is refused');
select throws_ok($$ select pg_temp.book('+15551230101', gen_random_uuid(), 'made-up-pass-made-up-pass-made-up') $$,
  'P0001', 'captcha_required', 'so is one with a pass nobody issued');
create temp table k1 as select gen_random_uuid() as k;
grant select on k1 to anon;
select is(pg_temp.book('+15551230101', (select k from k1), (select min(p) from passes)), 'pending_payment', 'a valid pass books it');
select is(pg_temp.book('+15551230101', (select k from k1), (select min(p) from passes)), 'pending_payment',
  'and a replay of the same booking with the same pass is a no-op');
select throws_ok(format($$ select pg_temp.book('+15551230102', gen_random_uuid(), %L) $$, (select min(p) from passes)),
  'P0001', 'captcha_required', 'a spent pass cannot buy a different booking');

select * from finish();
rollback;
