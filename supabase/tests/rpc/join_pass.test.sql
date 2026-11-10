-- Turnstile on online joins (join_pass migration): with a site key configured, an online join
-- needs a single-use pass that only the join-pass Edge Function (service role) can issue.
begin;
\ir ../helpers/_setup.psql
select plan(21);
select tests.create_world();

delete from app.business_hours where location_id in (tests.id('loc_a'), tests.id('loc_b'));
delete from app.hours_exceptions where location_id in (tests.id('loc_a'), tests.id('loc_b'));
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a'), 'Second', 'S'),
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');

/** An online join of queue_a with `pass` and idempotency key `k`; returns the ticket. */
create function tests.join_with(pass text, k uuid, queue text default 'queue_a') returns text
language sql as $$
  select (api.join_queue(tests.id(queue), null, 'Guest', null, null, 1, null, k,
                         'pass-device-' || replace(k::text, '-', ''), pass)).display_ticket
$$;
grant execute on function tests.join_with(text, uuid, text) to anon, authenticated;

-- Off by default: self-hosters without Turnstile join as before.
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.20"}', true);
select is((api.get_location_public('test-location-a')).captcha_site_key, null,
  'no site key by default, so the join page shows no widget');
select isnt(tests.join_with(null, gen_random_uuid()), null, 'and an online join needs no pass');
select tests.as_postgres();

update private.deployment_settings set turnstile_site_key = '1x00000000000000000000AA',
                                       turnstile_hostnames = '{localhost}';

select tests.as_anon();
select is((api.get_location_public('test-location-a')).captcha_site_key, '1x00000000000000000000AA',
  'with a site key, the join page gets it');
select throws_ok($$ select tests.join_with(null, gen_random_uuid()) $$, 'P0001', 'captcha_required',
  'an online join without a pass is refused');
select throws_ok($$ select tests.join_with('made-up-pass-made-up-pass-made-up', gen_random_uuid()) $$,
  'P0001', 'captcha_required', 'so is one with a pass nobody issued');
select throws_ok($$ select api.issue_join_pass('localhost') $$, '42501', null, 'anon cannot issue passes');
select tests.act_as('owner');
select throws_ok($$ select api.issue_join_pass('localhost') $$, '42501', null, 'nor can a signed-in user');

select tests.as_service();
create temp table passes as select api.issue_join_pass('localhost') as p from generate_series(1, 3);
grant select on passes to anon;
select is((select count(distinct p) from passes where length(p) = 43), 3::bigint,
  'the service role issues distinct 32-byte base64url passes');
select tests.as_postgres();
select is((select count(*) from private.join_passes p
           where p.pass_hash = any (select extensions.digest(x.p, 'sha256') from passes x)), 3::bigint,
  'only their sha256 is stored');
select is((select count(*) from private.join_passes p
           where convert_to((select min(x.p) from passes x), 'UTF8') = p.pass_hash), 0::bigint,
  'never the pass itself');

select tests.as_anon();
create temp table k1 as select gen_random_uuid() as k;
grant select on k1 to anon;
select isnt(tests.join_with((select min(p) from passes), (select k from k1)), null,
  'a fresh pass lets the guest join');
select is(tests.join_with((select min(p) from passes), (select k from k1)),
  tests.join_with((select min(p) from passes), (select k from k1)),
  'replaying that join with its key and pass is a no-op, not an error (rule 4)');
select throws_ok($$ select tests.join_with((select min(p) from passes), gen_random_uuid()) $$,
  'P0001', 'captcha_required', 'but the pass cannot buy a second join');
-- Security review of #560: join_core dedupes per (queue, key), so a replay must be on the
-- same queue, or one pass and key would buy a visit on every queue.
select throws_ok($$ select tests.join_with((select min(p) from passes), (select k from k1), 'queue_a2') $$,
  'P0001', 'captcha_required', 'nor a join on another queue with the same key');
select throws_ok($$ select tests.join_with((select min(p) from passes), (select k from k1), 'queue_b') $$,
  'P0001', 'captcha_required', 'nor on another org''s queue');
select tests.as_postgres();

-- Replays stay no-ops after the pass expires, for a day; after that the join can't be replayed.
update private.join_passes set expires_at = now() - interval '23 hours'
where pass_hash = (select extensions.digest(min(p), 'sha256') from passes);
select tests.as_anon();
select isnt(tests.join_with((select min(p) from passes), (select k from k1)), null,
  'a replay a day later still returns the visit');
select tests.as_postgres();
update private.join_passes set expires_at = now() - interval '25 hours'
where pass_hash = (select extensions.digest(min(p), 'sha256') from passes);
select tests.as_anon();
select throws_ok($$ select tests.join_with((select min(p) from passes), (select k from k1)) $$,
  'P0001', 'captcha_required', 'but not after that');
select tests.as_postgres();

-- A join the database refuses leaves the pass unspent, so the guest can fix the form and retry.
select tests.as_anon();
select throws_ok($$ select (api.join_queue(tests.id('queue_a'), null, 'Guest', 'not-a-phone', null, 1, null,
  gen_random_uuid(), 'pass-device-invalid-name-01', (select max(p) from passes))).display_ticket $$,
  'P0001', 'invalid_input', 'a refused join raises its own error');
select isnt(tests.join_with((select max(p) from passes), gen_random_uuid()), null,
  'and its pass still works');
select tests.as_postgres();

-- Expired passes are refused.
update private.join_passes set expires_at = now() - interval '1 second'
where pass_hash = (select extensions.digest(p, 'sha256') from passes
                   where p not in (select min(p) from passes union select max(p) from passes));
select tests.as_anon();
select throws_ok($$ select tests.join_with((select p from passes
  where p not in (select min(p) from passes union select max(p) from passes)), gen_random_uuid()) $$,
  'P0001', 'captcha_required', 'an expired pass is refused');
select tests.as_postgres();

-- Kiosk joins never need a pass.
select tests.act_as('kiosk');
select isnt((api.join_queue(tests.id('queue_a'), null, 'Walk-in', null, null, 1, null,
  gen_random_uuid())).display_ticket, null, 'a kiosk joins without a pass');
select tests.as_postgres();

select * from finish();
rollback;
