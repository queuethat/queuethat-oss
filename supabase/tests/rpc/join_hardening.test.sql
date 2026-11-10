-- Security review fixes (20261025004110_join_hardening.sql): per-client rate limits, no contact
-- squatting by unauthenticated joins, and token-taking guest functions refused over GET.
begin;
\ir ../helpers/_setup.psql
select plan(26);
select tests.create_world();

/** The DETAIL of the error p_sql raises, or null when it succeeds. */
create function tests.error_detail(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics d = pg_exception_detail;
  return d;
end $$;
grant execute on function tests.error_detail(text) to anon, authenticated;

/** Sets the request headers PostgREST would pass for a client at p_ip (Kong sets x-real-ip). */
create function tests.from_ip(p_ip text) returns void
language sql as $$
  select set_config('request.headers', jsonb_build_object('x-real-ip', p_ip)::text, true)
$$;
grant execute on function tests.from_ip(text) to anon, authenticated;

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min) values
  (tests.new_id('queue_flood'), tests.id('org_a'), tests.id('loc_a'), 'Flood', 'F', 15);
select tests.new_id('key_victim');
select tests.new_id('key_mallory');
select tests.new_id('key_staff');
grant select on tests.ids to anon, authenticated;

------------------------------------------------------------------------------------------------
-- Per-client limit (review finding 1)
------------------------------------------------------------------------------------------------
select tests.as_anon();
select tests.from_ip('203.0.113.66');
select api.join_queue(tests.id('queue_flood'), null, 'Bot' || i, null, null, 1, null, gen_random_uuid())
from generate_series(1, 10) i;
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_flood'), null, 'Bot11', null, null, 1, null, gen_random_uuid()) $$),
  'client', 'one client gets 10 joins per queue in 10 minutes, then rate_limited (client)');
select tests.from_ip('198.51.100.7');
select is((api.join_queue(tests.id('queue_flood'), null, 'Legit guest', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'a flooding client does not lock other guests out');
select set_config('request.headers',
  '{"x-real-ip": "203.0.113.66", "x-forwarded-for": "198.51.100.99", "cf-connecting-ip": "198.51.100.98"}', true);
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_flood'), null, 'Bot12', null, null, 1, null, gen_random_uuid()) $$),
  'client', 'forged x-forwarded-for and cf-connecting-ip do not reset the limit (x-real-ip by default)');

-- Pressure backstop: 15 online joins a minute; 11 so far. Four more clients fill it.
select tests.from_ip('192.0.2.101');
select api.join_queue(tests.id('queue_flood'), null, 'Many1', null, null, 1, null, gen_random_uuid());
select tests.from_ip('192.0.2.102');
select api.join_queue(tests.id('queue_flood'), null, 'Many2', null, null, 1, null, gen_random_uuid());
select tests.from_ip('192.0.2.103');
select api.join_queue(tests.id('queue_flood'), null, 'Many3', null, null, 1, null, gen_random_uuid());
select tests.from_ip('192.0.2.104');
select api.join_queue(tests.id('queue_flood'), null, 'Many4', null, null, 1, null, gen_random_uuid());
select tests.from_ip('192.0.2.101');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_flood'), null, 'Many1b', null, null, 1, null, gen_random_uuid()) $$),
  'queue', 'under pressure a client that already joined waits (rate_limited queue)');
select tests.from_ip('198.51.100.200');
select is((api.join_queue(tests.id('queue_flood'), null, 'Newcomer', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'under pressure a guest who has not joined yet still gets in: many clients cannot lock a queue');
-- 16 online joins so far; newcomers get in up to 3 x 15 = 45 a minute, then everyone waits.
do $$
begin
  for i in 1..29 loop
    perform tests.from_ip('2001:db8:48:' || to_hex(i) || '::1');
    perform api.join_queue(tests.id('queue_flood'), null, 'V6-' || i, null, null, 1, null, gen_random_uuid());
  end loop;
end $$;
select tests.from_ip('2001:db8:48:ffff::1');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_flood'), null, 'V6-last', null, null, 1, null, gen_random_uuid()) $$),
  'queue', 'the newcomer exemption stops at three times the rate (fresh /64s are cheap)');

-- Kiosks have their own budget.
select tests.act_as('kiosk');
select is((api.join_queue(tests.id('queue_flood'), null, 'Walk-in', null, null, 1, null, gen_random_uuid())).status::text,
  'waiting', 'the in-store kiosk still joins while online joins are rate limited');
select tests.as_postgres();
select is((select count(*)::int from private.join_log where queue_id = tests.id('queue_flood')), 46,
  'every accepted non-staff join is logged once');
select ok((select bool_and(length(client_key) = 32) from private.join_log), 'the log holds 32-byte keys, not IPs');
select is_empty($$ select 1 from private.join_log
                   where client_key in (extensions.digest('ip:203.0.113.66', 'sha256'), '\x' || encode('ip:203.0.113.66', 'escape')::bytea) $$,
  'keys are an HMAC with a secret, not a hash anyone can reverse by trying every IPv4 address');

-- Client IP from the configured header; IPv6 by /64.
select tests.from_ip('2001:db8:1:1::1');
select is(private.client_ip(), '2001:db8:1:1::/64'::inet, 'an IPv6 client is keyed by its /64');
create temp table v6_keys (name text, k bytea);
insert into v6_keys select 'a', private.client_key();
select tests.from_ip('2001:db8:1:1:ffff::9');
insert into v6_keys select 'b', private.client_key();
select tests.from_ip('2001:db8:1:2::1');
insert into v6_keys select 'c', private.client_key();
select ok((select (select k from v6_keys where name = 'a') = (select k from v6_keys where name = 'b')
              and (select k from v6_keys where name = 'a') <> (select k from v6_keys where name = 'c')),
  'two addresses in one /64 share a key; another /64 gets its own');
select set_config('request.headers', '{"x-real-ip": "not an ip"}', true);
select is(private.client_ip(), null, 'a malformed header gives no client IP');
select set_config('request.headers', '{"x-real-ip": "10.0.0.1", "cf-connecting-ip": "203.0.113.5"}', true);
update private.deployment_settings set client_ip_header = 'cf-connecting-ip';
select is(private.client_ip(), '203.0.113.5'::inet,
  'a deployment behind Cloudflare only can switch to cf-connecting-ip');
update private.deployment_settings set client_ip_header = 'x-real-ip';
select is(private.client_ip(), '10.0.0.1'::inet, 'the default is the gateway''s x-real-ip');
select ok(not has_table_privilege('anon', 'private.deployment_settings', 'SELECT')
          and not has_table_privilege('authenticated', 'private.deployment_settings', 'SELECT'),
  'deployment settings (and the HMAC secret) are not readable through the API');
select ok(not has_table_privilege('anon', 'private.join_log', 'SELECT')
          and not has_table_privilege('authenticated', 'private.join_log', 'SELECT'),
  'the join log is not readable through the API');

------------------------------------------------------------------------------------------------
-- No squatting (review finding 3)
------------------------------------------------------------------------------------------------
select tests.as_anon();
select tests.from_ip('198.51.100.20');
select api.join_queue(tests.id('queue_a'), null, 'Mallory', '+12125550111', 'mallory@evil.test', 1, null, tests.id('key_mallory'));
select api.join_queue(tests.id('queue_a'), null, 'Victim', '+12125550111', 'victim@example.com', 1, null, tests.id('key_victim'));
select tests.as_postgres();
select is((select count(*)::int from app.guest_contacts
           where value in ('+12125550111', 'mallory@evil.test', 'victim@example.com')), 0,
  'the first guest to type a number does not own it: no contact rows from guest joins');
select results_eq($$ select guest_phone_e164, guest_email from app.visits where idempotency_key = tests.id('key_victim') $$,
  $$ values ('+12125550111', 'victim@example.com') $$,
  'the real owner''s visit keeps their own number and email for its messages');
select private.join_core(tests.id('queue_a'), null, 'Victim', '+12125550111', null, null, null,
  tests.id('key_staff'), 'staff', 'staff', tests.id('staff'));
select results_eq($$ select g.first_name, c.created_source from app.visits v
                     join app.guests g on g.id = v.guest_id join app.guest_contacts c on c.id = v.contact_id
                     where v.idempotency_key = tests.id('key_staff') $$,
  $$ values ('Victim', 'staff') $$,
  'a later staff add creates the contact under the person staff actually saw');

------------------------------------------------------------------------------------------------
-- Token functions refuse GET (review finding 4)
------------------------------------------------------------------------------------------------
select set_config('request.method', 'GET', true);
select set_config('request.path', '/rpc/get_visit_status', true);
select throws_ok('select public.pgrst_pre_request()', 'PT405', 'token_in_url',
  'GET on a function that takes p_token is refused (HTTP 405)');
select set_config('request.method', 'HEAD', true);
select throws_ok('select public.pgrst_pre_request()', 'PT405', 'token_in_url',
  'HEAD is refused too');
select set_config('request.method', 'GET', true);
select set_config('request.path', '/rpc/get_location_public', true);
select lives_ok('select public.pgrst_pre_request()', 'GET on a function without a token still works');
select set_config('request.method', 'POST', true);
select set_config('request.path', '/rpc/get_visit_status', true);
select lives_ok('select public.pgrst_pre_request()', 'POST with the token in the body works');
select ok(exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                  where r.rolname = 'authenticator'
                    and 'pgrst.db_pre_request=public.pgrst_pre_request' = any (s.setconfig)),
  'PostgREST is configured to run the hook before every request');
select set_eq($$ select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                                   and d.objid = p.oid and d.deptype = 'e') $$,
  array['pgrst_pre_request()'],
  'I-4: outside api, anon can execute only the pre-request hook (it runs as the request role)');

select * from finish();
rollback;
