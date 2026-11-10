-- 2P-PRV5 (#192): per-org block list by phone, email and device.
begin;
\ir ../helpers/_setup.psql
select plan(19);
select tests.create_world();

delete from app.business_hours;
delete from app.hours_exceptions;
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
grant select on all tables in schema tests to anon, authenticated;

/** Joins p_queue as a guest (anon); returns the error code with its DETAIL, or 'ok'. */
create function tests.try_join(p_queue text, p_phone text, p_device text default null) returns text
language plpgsql as $$
declare d text;
begin
  perform tests.as_anon();
  perform api.join_queue(tests.id(p_queue), null, 'Guest', p_phone, null, 1, 'en', gen_random_uuid(),
                         p_device_key => p_device);
  perform tests.as_postgres();
  return 'ok';
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  perform tests.as_postgres();
  return sqlerrm || coalesce('/' || d, '');
end $$;

select is(tests.try_join('queue_a', '+15550001111'), 'ok', 'an unblocked phone joins');

-- A manager removes a fake joiner and blocks them.
select tests.as_postgres();
select tests.new_visit('fake', 'queue_a', 'Fake');
select private.set_actor('system', null);
update app.visits set guest_phone_e164 = '+15550004444', guest_email = 'fake@example.com',
  device_key_hash = '\xdeadbeef' where id = tests.id('fake');
select tests.act_as('staff');
select throws_ok($$ select api.block_from_visit(tests.id('fake'), 'fake joins', null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'staff cannot block');
select tests.act_as('manager');
select lives_ok($$ select api.block_from_visit(tests.id('fake'), 'fake joins', null, '00000000-0000-0000-0000-0000000000b1') $$,
  'a manager blocks from a visit');
select is(api.block_from_visit(tests.id('fake'), 'fake joins', null, '00000000-0000-0000-0000-0000000000b1'),
  api.block_from_visit(tests.id('fake'), 'fake joins', null, '00000000-0000-0000-0000-0000000000b1'),
  'the same idempotency key returns the same block');
select tests.as_postgres();
select is((select count(*) from app.blocked_identities where org_id = tests.id('org_a') and reason = 'fake joins'), 3::bigint,
  'phone, email and device are blocked');
select is((select count(*) from app.blocked_identities where value_hash::text like '%2b1555%' or reason like '%+1555%'), 0::bigint,
  'AC5: no plaintext phone is stored');

select is(tests.try_join('queue_a', '+15550004444'), 'queue_not_accepting/closed',
  'AC1: a blocked phone gets the answer a closed queue gives');
select is(tests.try_join('queue_a', '+15550001112'), 'ok', 'other phones still join');
select is(tests.try_join('queue_b', '+15550004444'), 'ok', 'AC3: the same phone joins org B');

select is(private.is_org_blocked(tests.id('org_a'), tests.id('queue_a'), null, null, '\xdeadbeef'), true,
  'the blocked device is refused on the queue it joined');
select is(private.is_org_blocked(tests.id('org_a'), gen_random_uuid(), null, null, '\xdeadbeef'), false,
  'a device block covers that queue only (device hashes are per queue)');

-- Staff adds are refused until the block is lifted.
select tests.act_as('staff');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_a'), null, 'Fake', '+15550004444', 1, gen_random_uuid()) $$,
  'P0001', 'guest_blocked', 'a staff add of a blocked phone raises guest_blocked');

-- AC2: an expired block lets them in.
select tests.as_postgres();
update app.blocked_identities set expires_at = now() - interval '1 minute' where org_id = tests.id('org_a');
select is(tests.try_join('queue_a', '+15550004444'), 'ok', 'AC2: an expired block no longer applies');
update app.blocked_identities set expires_at = null where org_id = tests.id('org_a');

-- AC4: org B manager cannot block from or read org A.
select tests.act_as('other_owner');
select throws_ok($$ select api.block_from_visit(tests.id('fake'), 'x', null, gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC4: org B cannot block from an org A visit');
select is((select count(*) from app.blocked_identities), 0::bigint, 'AC4: org B reads no org A blocks');
select lives_ok($$ select api.unblock(tests.id('block_a')) $$, 'org B unblocking an org A id does nothing');
select tests.as_postgres();
select is((select count(*) from app.blocked_identities where id = tests.id('block_a')), 1::bigint, 'and the block remains');
select tests.act_as('other_owner');

-- Unblock restores joins.
select tests.act_as('manager');
select lives_ok($$ select api.unblock(b.id) from app.blocked_identities b where b.reason = 'fake joins' $$, 'a manager unblocks');
select tests.as_postgres();
select is(tests.try_join('queue_a', '+15550004444'), 'ok', 'after unblock the phone can join again');

select * from finish();
rollback;
