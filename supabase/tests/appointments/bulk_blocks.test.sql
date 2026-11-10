-- 2B-A9 (#284): api.block_time_bulk and api.delete_time_blocks.
begin;
\ir ../helpers/_setup.psql
select plan(13);
select tests.create_world();

insert into app.counters (id, org_id, location_id, label)
values (tests.new_id('counter_b'), tests.id('org_b'), tests.id('loc_b'), 'B chair');

select tests.act_as('manager');
create temp table res as
select * from api.block_time_bulk(
  tests.id('loc_a'),
  array[tests.id('counter_a'), tests.id('counter_pair'), tests.id('counter_a')],
  array[tstzrange('2026-12-21 15:10Z', '2026-12-21 16:00Z'), tstzrange('2026-12-22 09:00Z', '2026-12-22 10:00Z')],
  'Staff meeting', '00000000-0000-0000-0000-0000000000a1');
grant all on res to public;

select is(cardinality((select block_ids from res)), 4, 'AC1: 2 distinct resources x 2 ranges = 4 blocks');
select is((select conflicts from res), array[tests.id('appointment_a')], 'AC1: the overlapping booking is listed');
select is((select status::text from app.appointments where id = tests.id('appointment_a')), 'booked', 'AC1: the conflicting booking stays booked');
select is((select (api.block_time_bulk(tests.id('loc_a'), array[tests.id('counter_a')],
  array[tstzrange('2026-12-21 15:10Z', '2026-12-21 16:00Z')], 'Staff meeting', '00000000-0000-0000-0000-0000000000a1')).block_ids),
  (select block_ids from res), 'a repeat with the same key returns the first result and creates nothing');
select is((select count(*)::int from app.time_blocks where reason = 'Staff meeting'), 4, 'the repeat created no blocks');

select throws_ok(format($$ select api.block_time_bulk(%L, array[%L::uuid], array[tstzrange('2026-12-23 09:00Z','2026-12-23 10:00Z')], null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('counter_b')), 'P0001', 'invalid_resource', 'AC2: a resource of org B is refused');
select is((select count(*)::int from app.time_blocks where lower(during) = '2026-12-23 09:00Z'), 0, 'AC2: nothing was created');
select throws_ok(format($$ select api.block_time_bulk(%L, array[%L::uuid], array[tstzrange('2026-12-23 09:00Z','2026-12-23 09:00Z')], null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('counter_a')), 'P0001', 'invalid_input', 'an empty range is refused');
select throws_ok(format($$ select api.block_time_bulk(%L, array[%L::uuid], array[tstzrange('2026-12-23 09:00Z', null)], null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('counter_a')), 'P0001', 'invalid_input', 'an unbounded range is refused');

select tests.act_as('staff');
select throws_ok(format($$ select api.block_time_bulk(%L, array[%L::uuid], array[tstzrange('2026-12-23 09:00Z','2026-12-23 10:00Z')], null, gen_random_uuid()) $$,
  tests.id('loc_a'), tests.id('counter_a')), '42501', null, 'staff cannot block time');

select tests.act_as('other_owner');
select throws_ok(format($$ select api.delete_time_blocks(array[%L::uuid], gen_random_uuid()) $$, tests.id('time_block_a')),
  'P0001', 'not_found', 'org B cannot delete an org A block (cross-tenant)');

select tests.act_as('manager');
select is(api.delete_time_blocks((select block_ids from res), '00000000-0000-0000-0000-0000000000a2'), 4, 'the batch is deleted');
select is(api.delete_time_blocks((select block_ids from res), '00000000-0000-0000-0000-0000000000a2'), 4, 'a repeat of the delete answers the same way');

select * from finish();
rollback;
