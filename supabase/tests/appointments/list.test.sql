-- 2P-APT9 (#165): api.list_appointments is a staff-only read, empty across tenants.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

select private.set_actor('system', null);
insert into app.appointments (org_id, location_id, service_id, queue_id, starts_at, ends_at, local_date, guest_name, source, idempotency_key)
values (tests.id('org_a'), tests.id('loc_a'), tests.id('service_a'), tests.id('queue_a'),
        now() + interval '2 days', now() + interval '2 days 30 minutes', (now() + interval '2 days')::date, 'Anita', 'guest', gen_random_uuid());

select tests.act_as('staff');
select is((select count(*)::int from api.list_appointments(tests.id('loc_a'), current_date, current_date + 5)), 1, 'staff of the location see its appointment');
select is((select guest_name from api.list_appointments(tests.id('loc_a'), current_date, current_date + 5)), 'Anita', 'with the guest name for the front desk');
select is((select count(*)::int from api.list_appointments(tests.id('loc_a'), current_date + 4, current_date + 5)), 0, 'outside the range: none');
select throws_ok(format($$ select * from api.list_appointments(%L, current_date, current_date + 40) $$, tests.id('loc_a')), 'P0001', 'range_too_large', 'a window over 31 days is refused');

select tests.act_as('other_owner');
select is((select count(*)::int from api.list_appointments(tests.id('loc_a'), current_date, current_date + 5)), 0, 'AC1: org B staff get zero rows for an org A location');

select tests.as_anon();
select throws_ok(format($$ select * from api.list_appointments(%L, current_date, current_date + 5) $$, tests.id('loc_a')), '42501', null, 'anon cannot execute it');

select * from finish();
rollback;
