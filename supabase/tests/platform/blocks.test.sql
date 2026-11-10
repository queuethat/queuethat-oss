-- PLT8 (#414): a platform block stops a phone or email joining any org's queue with the generic
-- rate_limited code, expired blocks don't, and nothing stores the contact in plaintext.
begin;
\ir ../helpers/_setup.psql
select plan(32);
select tests.create_world();

-- Open queues in both orgs (no opening hours means always open).
delete from app.business_hours;
delete from app.hours_exceptions;
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
grant select on all tables in schema tests to anon, authenticated;

/** Joins p_queue as a guest (anon) with the given contact; returns the error code or 'ok'. */
create function tests.try_join(p_queue text, p_phone text, p_email text) returns text
language plpgsql as $$
begin
  perform tests.as_anon();
  perform api.join_queue(tests.id(p_queue), null, 'Guest', p_phone, p_email, 1, 'en', gen_random_uuid());
  perform tests.as_postgres();
  return 'ok';
exception when others then
  perform tests.as_postgres();
  return sqlerrm;
end $$;

select is(tests.try_join('queue_a', '+15550001111', null), 'ok', 'an unblocked phone joins');

-- Operators block a phone and an email.
select tests.act_as('platform');
select lives_ok($$ select api.platform_block_contact('+1 (555) 000-2222', 'phone', 'spam across shops', null) $$,
  'an operator blocks a phone, given in any common format');
select lives_ok($$ select api.platform_block_contact('  Spammer@Example.com ', 'email', 'spam', null) $$,
  'an operator blocks an email');
select lives_ok($$ select api.platform_block_contact('+15550002222', 'phone', 'still spam', null) $$,
  'blocking the same contact again is safe');
select tests.as_postgres();

-- AC1: blocked in every org, with the generic code and no visit.
select is(tests.try_join('queue_a', '+15550002222', null), 'rate_limited', 'AC1: a blocked phone gets rate_limited in org A');
select is(tests.try_join('queue_b', '+15550002222', null), 'rate_limited', 'AC1: and in org B');
select is(tests.try_join('queue_b', null, 'spammer@example.com'), 'rate_limited', 'AC1: a blocked email gets rate_limited');
select is(tests.try_join('queue_a', '+15550009999', 'SPAMMER@example.com'), 'rate_limited',
  'a blocked email blocks the join even with a clean phone');
select is((select count(*)::int from app.visits v where v.guest_phone_e164 = '+15550002222'), 0,
  'AC1: no visit is created for the blocked phone');

-- Staff adds are exempt.
select tests.act_as('staff');
select lives_ok($$ select api.staff_add_visit(tests.id('queue_a'), null, 'Walk-in', '+15550002222', 1, gen_random_uuid()) $$,
  'staff can still add a blocked contact in person');
select tests.as_postgres();

-- AC2: an expired block no longer applies.
select tests.act_as('platform');
select api.platform_block_contact('+15550003333', 'phone', 'cool-off', now() + interval '1 hour');
select tests.as_postgres();
select is(tests.try_join('queue_a', '+15550003333', null), 'rate_limited', 'a block before its expiry applies');
update app.platform_blocks set expires_at = now() - interval '1 second'
where contact_hash = private.contact_block_hash('phone', '+15550003333');
select is(tests.try_join('queue_a', '+15550003333', null), 'ok', 'AC2: after the block expires, the join succeeds');

-- Unblocking.
select tests.act_as('platform');
select api.platform_unblock_contact('spammer@example.com', 'email');
select lives_ok($$ select api.platform_unblock_contact('spammer@example.com', 'email') $$, 'unblocking twice is safe');
select tests.as_postgres();
select is(tests.try_join('queue_a', null, 'spammer@example.com'), 'ok', 'an unblocked email joins again');

-- Address variants that reach the same inbox share the block (security review on #459).
select tests.act_as('platform');
select api.platform_block_contact('dodger@example.com', 'email', 'abuse', null);
select api.platform_block_contact('Some.Body@gmail.com', 'email', 'abuse', null);
select tests.as_postgres();
select is(tests.try_join('queue_a', null, 'dodger+1@example.com'), 'rate_limited', 'a +tag does not dodge an email block');
select is(tests.try_join('queue_a', null, 'Dodger+shop.b@Example.COM'), 'rate_limited', 'nor a +tag in another case');
select is(tests.try_join('queue_a', null, 'dodger@example.com.'), 'invalid_input',
  'nor a trailing dot on the domain: join refuses it before the block check (20261025093000)');
select is(tests.try_join('queue_a', null, 's.o.m.e.b.o.d.y@gmail.com'), 'rate_limited', 'nor moved dots in a gmail address');
select is(tests.try_join('queue_a', null, 'somebody+x@googlemail.com'), 'rate_limited', 'nor the googlemail.com alias');
select is(tests.try_join('queue_a', null, 'do.dger@example.com'), 'ok', 'dots still matter outside gmail');
select is(tests.try_join('queue_a', null, 'dodger@example.co'), 'ok', 'a different domain is not blocked');
select is(tests.try_join('queue_a', null, 'dodger@example.com'),
          'rate_limited', 'the address as blocked is still blocked');
select tests.act_as('platform');
select api.platform_unblock_contact('dodger+anything@example.com.', 'email');
select tests.as_postgres();
select is(tests.try_join('queue_a', null, 'dodger@example.com'), 'ok', 'unblocking any variant lifts the block');

-- The free-text reason must not carry the contact.
select tests.act_as('platform');
select throws_ok($$ select api.platform_block_contact('+15550005555', 'phone', 'spam from 555-0005555', null) $$,
  'P0001', 'invalid_input', 'a reason containing the phone is rejected');
select throws_ok($$ select api.platform_block_contact('troll@example.com', 'email', 'Troll keeps joining', null) $$,
  'P0001', 'invalid_input', 'a reason containing the email local part is rejected');
select tests.as_postgres();

-- AC3: no plaintext contact in the table or the audit.
select is((select count(*)::int from app.platform_blocks
           where to_jsonb(platform_blocks)::text ~* '5550002222|spammer'), 0,
  'AC3: platform_blocks stores no plaintext phone or email');
select is((select count(*)::int from app.platform_audit
           where action like 'contact_block.%' and to_jsonb(platform_audit)::text ~* '5550002222|spammer'), 0,
  'the audit rows hold no plaintext contact');
select is((select array_agg(action order by id) from app.platform_audit where action like 'contact_block.%'),
  array['contact_block.add', 'contact_block.add', 'contact_block.add', 'contact_block.add', 'contact_block.remove',
        'contact_block.add', 'contact_block.add', 'contact_block.remove'],
  'every block is audited, and the one real unblock');

-- Validation and access.
select tests.act_as('platform');
select throws_ok($$ select api.platform_block_contact('not-a-phone', 'phone', 'x', null) $$, 'P0001', 'invalid_input',
  'an invalid phone is invalid_input');
select throws_ok($$ select api.platform_block_contact('+15550004444', 'fax', 'x', null) $$, 'P0001', 'invalid_input',
  'an unknown kind is invalid_input');
select tests.act_as('owner');
select throws_ok($$ select api.platform_block_contact('+15550004444', 'phone', 'x', null) $$, '42501', 'permission_denied',
  'an org owner cannot block contacts');
select tests.as_postgres();
select ok(not has_function_privilege('anon', 'private.is_blocked(uuid, text, text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.contact_block_hash(app.contact_channel, text)', 'EXECUTE'),
  'API roles cannot call the block helpers directly');

select * from finish();
rollback;
