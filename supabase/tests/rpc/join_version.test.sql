-- Follow-up to V4 (#432): every join through private.join_core bumps queues.version once.
-- Races (no deadlocks, exact counts under load) are in tests/concurrency/queue_version.test.ts.
begin;
\ir ../helpers/_setup.psql
select plan(6);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['k_anon', 'k_kiosk', 'k_paused']) k;
create table tests.marks (name text primary key, n bigint);
create function tests.version() returns bigint
language sql as $$ select version from app.queues where id = tests.id('queue_a') $$;
create function tests.bumps_since(p_mark text) returns bigint
language sql as $$ select tests.version() - n from tests.marks where name = p_mark $$;

insert into tests.marks values ('start', tests.version());
select tests.as_anon();
select api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, null, tests.id('k_anon'));
select tests.as_postgres();
select is(tests.bumps_since('start'), 1::bigint, 'an online join bumps the queue version once');

select tests.as_anon();
select api.join_queue(tests.id('queue_a'), null, 'Ann', null, null, 1, null, tests.id('k_anon'));
select tests.as_postgres();
select is(tests.bumps_since('start'), 1::bigint, 'repeating the key changes nothing');

select tests.act_as('kiosk');
select api.join_queue(tests.id('queue_a'), null, 'Kim', null, null, 1, null, tests.id('k_kiosk'));
select tests.as_postgres();
select is(tests.bumps_since('start'), 2::bigint, 'a kiosk join bumps it too');

select tests.act_as('staff');
select api.staff_add_visit(tests.id('queue_a'), null, 'Sam', null, 1, gen_random_uuid());
select tests.as_postgres();
select is(tests.bumps_since('start'), 3::bigint, 'a staff add still bumps exactly once');

update app.queues set manual_state = 'paused' where id = tests.id('queue_a');
insert into tests.marks values ('paused', tests.version());
select tests.as_anon();
select throws_ok(
  format('select api.join_queue(%L, null, %L, null, null, 1, null, %L)',
         tests.id('queue_a'), 'Pat', tests.id('k_paused')),
  'queue_not_accepting');
select tests.as_postgres();
select is(tests.bumps_since('paused'), 0::bigint, 'a rejected join does not bump it');

select * from finish();
rollback;
