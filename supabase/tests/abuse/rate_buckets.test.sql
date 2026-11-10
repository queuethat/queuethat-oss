-- 2A-JN2 (#112): api.hit_rate_limit, and the service-role changes public-join relies on.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();

-- AC5: only the service role may call it
select tests.as_anon();
select throws_ok($$ select api.hit_rate_limit('k', 1, 60) $$, '42501', null, 'AC5: anon cannot call api.hit_rate_limit');
select tests.act_as('owner');
select throws_ok($$ select api.hit_rate_limit('k', 1, 60) $$, '42501', null, 'AC5: nor can authenticated');
select throws_ok($$ select count(*) from private.rate_buckets $$, '42501', null, 'and nobody reads the buckets');

-- Limits (AC1 at the database level: 10 allowed, the 11th is not)
select tests.as_service();
create temp table hits (n int, ok boolean);
grant all on hits to service_role;
insert into hits select i, api.hit_rate_limit('ip:abc', 10, 600) from generate_series(1, 11) i;
select is((select count(*)::int from hits where ok), 10, 'ten hits within the limit are allowed');
select is((select ok from hits where n = 11), false, 'AC1: the eleventh is refused');
select is(api.hit_rate_limit('ip:other', 10, 600), true, 'another key has its own bucket');
select is(api.hit_rate_limit('ip:abc', 10, 600, false), false, 'peeking at an exhausted key says no without counting');
select tests.as_postgres();
select is((select count from private.rate_buckets where key = 'ip:abc'), 11, 'and a peek adds nothing');
select tests.as_service();
select is(api.hit_rate_limit('ip:fresh', 2, 600, false), true, 'a peek at an untouched key says yes');
select throws_ok($$ select api.hit_rate_limit('', 1, 60) $$, 'P0001', 'invalid_input', 'a bad key is rejected');

-- The service role joins without a Turnstile pass, anon still needs one
select tests.as_postgres();
update private.deployment_settings set turnstile_site_key = 'test-site-key-1234567';
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
select tests.new_id(k) from unnest(array['j1', 'j2']) k;
select tests.as_anon();
select throws_ok(format($$ select api.join_queue(%L, null, 'G', null, null, 1, null, %L) $$,
  tests.id('queue_a'), tests.id('j1')), 'P0001', 'captcha_required', 'anon without a pass is refused when Turnstile is on');
select tests.as_service();
select set_config('request.headers', '{"x-real-ip": "10.0.0.1", "x-qm-client-ip": "203.0.113.9"}', true);
select lives_ok(format($$ select api.join_queue(%L, null, 'G', null, null, 1, null, %L) $$,
  tests.id('queue_a'), tests.id('j2')), 'the service role joins without a pass');
select tests.as_postgres();
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select is(host(private.client_ip()), '203.0.113.9', 'and its forwarded address is the client address');
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is(host(private.client_ip()), '10.0.0.1', 'while anyone else''s x-qm-client-ip is ignored');

-- IPv4-mapped IPv6 clients are their IPv4 address; other IPv6 clients are their /64.
select set_config('request.headers', '{"x-real-ip": "::ffff:198.51.100.7"}', true);
select is(host(private.client_ip()), '198.51.100.7', 'a mapped address is the IPv4 client');
select set_config('request.headers', '{"x-real-ip": "::ffff:198.51.100.8"}', true);
select is(host(private.client_ip()), '198.51.100.8', 'and another mapped client is not the same bucket');
select set_config('request.headers', '{"x-real-ip": "2001:db8:1:2:aaaa::9"}', true);
select is(host(private.client_ip()), '2001:db8:1:2::', 'a native IPv6 client is its /64');
select set_config('request.headers', '{"x-real-ip": "::1"}', true);
select is(host(private.client_ip()), '::', 'and the loopback is not mistaken for a mapped address');

select * from finish();
rollback;
