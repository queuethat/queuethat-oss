-- 2B-A12 (#287): api.search_appointments finds appointments by name, phone suffix, email or reference; staff-only, tenant-scoped.
begin;
\ir ../helpers/_setup.psql
select plan(9);
select tests.create_world();

select private.set_actor('system', null);
insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name, guest_phone_e164, guest_email, source, idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '21 days', now() + interval '21 days 30 minutes', (now() + interval '21 days')::date,
        'Jordan Lee', '+15550100123', 'jordan@example.test', 'guest', gen_random_uuid()),
       (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '22 days', now() + interval '22 days 30 minutes', (now() + interval '22 days')::date,
        'Jordana Fox', '+15550100999', null, 'guest', gen_random_uuid());

select tests.act_as('staff');
select is((select count(*)::int from api.search_appointments(tests.id('loc_a'), 'jord', current_date, current_date + 60, null)), 2, 'AC1: a name prefix finds appointments weeks ahead');
select is((select guest_name from api.search_appointments(tests.id('loc_a'), '0123', current_date, current_date + 60, null)), 'Jordan Lee', 'AC2: the last four digits of the phone match');
select is((select count(*)::int from api.search_appointments(tests.id('loc_a'), '123', current_date, current_date + 60, null)), 0, 'under four digits is not a phone match');
select is((select count(*)::int from api.search_appointments(tests.id('loc_a'), 'JORDAN@example', current_date, current_date + 60, null)), 1, 'email substring, case-insensitive');
select is((select count(*)::int from api.search_appointments(tests.id('loc_a'), 'jord', current_date, current_date + 60, array['cancelled'])), 0, 'status filter');
select is((select id from api.search_appointments(tests.id('loc_a'), 'jord', current_date, current_date + 60, null, 1,
  (select id from api.search_appointments(tests.id('loc_a'), 'jord', current_date, current_date + 60, null, 1))) ),
  (select id from app.appointments where guest_name = 'Jordana Fox'), 'keyset page 2 starts after p_after');
select throws_ok(format($$ select * from api.search_appointments(%L, 'j', current_date, current_date + 5, null) $$, tests.id('loc_a')), 'P0001', 'invalid_input', 'a one-character query is refused');

select tests.act_as('other_owner');
select is((select count(*)::int from api.search_appointments(tests.id('loc_a'), 'jord', current_date, current_date + 60, null)), 0, 'AC3: org B staff get zero rows for an org A location');

select tests.as_anon();
select throws_ok(format($$ select * from api.search_appointments(%L, 'jord', current_date, current_date + 60, null) $$, tests.id('loc_a')), '42501', null, 'anon cannot execute it');

select * from finish();
rollback;
