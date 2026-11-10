-- #474 (20261025004600_join_device_key.sql): one visit per phone per queue, the token on every
-- replay without storing it, and per-device limits so one Wi-Fi does not share a cap.
begin;
\ir ../helpers/_setup.psql
select plan(24);
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

/** A well-formed device key (the web app sends 16 random bytes, base64url). */
create function tests.device(p_n int) returns text
language sql immutable as $$ select 'test-device-key-' || lpad(p_n::text, 8, '0') $$;
grant execute on function tests.device(int) to anon, authenticated;

/** Every row in our schemas whose JSON form contains p_needle, as schema.table. */
create function tests.rows_containing(p_needle text) returns setof text
language plpgsql as $$
declare t record; n bigint;
begin
  for t in select format('%I.%I', c.relnamespace::regnamespace::text, c.relname) as rel
           from pg_class c
           where c.relkind in ('r', 'p') and c.relnamespace::regnamespace::text = any(tests.own_schemas())
  loop
    execute format('select count(*) from %s x where to_jsonb(x)::text like %L', t.rel,
                   '%' || p_needle || '%') into n;
    if n > 0 then
      return next t.rel;
    end if;
  end loop;
end $$;

delete from app.business_hours where location_id in (tests.id('loc_a'), tests.id('loc_b'));
delete from app.hours_exceptions where location_id in (tests.id('loc_a'), tests.id('loc_b'));
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_wifi'), tests.id('org_a'), tests.id('loc_a'), 'Wi-Fi', 'W'),
  (tests.new_id('queue_b2'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B');
select tests.new_id('key_staff');
select tests.new_id('key_lost');
create table tests.results (name text primary key, r api.join_result);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.results to anon, authenticated;

------------------------------------------------------------------------------------------------
-- One visit per phone per queue
------------------------------------------------------------------------------------------------
select tests.as_anon();
select tests.from_ip('198.51.100.1');
insert into tests.results values
  ('first', api.join_queue(tests.id('queue_a'), null, 'Dee', null, null, 1, null, gen_random_uuid(), tests.device(1)));
insert into tests.results values
  ('rejoin', api.join_queue(tests.id('queue_a'), null, 'Dee again', null, null, 1, null, gen_random_uuid(), tests.device(1)));
insert into tests.results values
  ('other_phone', api.join_queue(tests.id('queue_a'), null, 'Eve', null, null, 1, null, gen_random_uuid(), tests.device(2)));
insert into tests.results values
  ('other_org', api.join_queue(tests.id('queue_b2'), null, 'Dee', null, null, 1, null, gen_random_uuid(), tests.device(1)));
select tests.as_postgres();
select is((select (r).display_ticket from tests.results where name = 'rejoin'),
          (select (r).display_ticket from tests.results where name = 'first'),
  'a second join from the same phone, with a fresh idempotency key, returns its existing ticket');
select is((select (r).token from tests.results where name = 'rejoin'),
          (select (r).token from tests.results where name = 'first'),
  'and the same status link, so the guest lands on their visit again');
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_a')
             and device_key_hash = private.device_key_hash(tests.id('queue_a'), tests.device(1))), 1,
  'the rejoin creates no second visit');
select isnt((select (r).display_ticket from tests.results where name = 'other_phone'),
            (select (r).display_ticket from tests.results where name = 'first'),
  'another phone on the same network gets its own visit');
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_b2')
             and device_key_hash = private.device_key_hash(tests.id('queue_b2'), tests.device(1))), 1,
  'cross-tenant: the same phone joining another org''s queue gets a new visit there, not this one');

select tests.as_anon();
select api.guest_act((select (r).token from tests.results where name = 'first'), 'leave', gen_random_uuid());
insert into tests.results values
  ('after_leave', api.join_queue(tests.id('queue_a'), null, 'Dee', null, null, 1, null, gen_random_uuid(), tests.device(1)));
select tests.as_postgres();
select isnt((select (r).display_ticket from tests.results where name = 'after_leave'),
            (select (r).display_ticket from tests.results where name = 'first'),
  'once the visit has ended the phone can join again');

update app.queues set manual_state = 'paused' where id = tests.id('queue_a');
select tests.as_anon();
insert into tests.results values
  ('paused', api.join_queue(tests.id('queue_a'), null, 'Dee', null, null, 1, null, gen_random_uuid(), tests.device(1)));
select tests.as_postgres();
select is((select (r).token from tests.results where name = 'paused'),
          (select (r).token from tests.results where name = 'after_leave'),
  'a rejoin returns the active visit even while the queue is paused (rule 4: no error)');
update app.queues set manual_state = 'open' where id = tests.id('queue_a');

------------------------------------------------------------------------------------------------
-- Tokens: re-derived, never stored; only to the source that joined
------------------------------------------------------------------------------------------------
select is_empty(format($$ select * from tests.rows_containing(%L) $$, (select (r).token from tests.results where name = 'first')),
  'I-7: no row holds the plaintext token');
select is_empty(format($$ select * from tests.rows_containing(%L) $$, tests.device(1)),
  'no row holds the plaintext device key');
select ok((select bool_and(length(device_key_hash) = 32) from app.visits where device_key_hash is not null),
  'visits keep a 32-byte HMAC of the device key');

select ok((select count(distinct device_key_hash) = 2 from app.visits
           where queue_id in (tests.id('queue_a'), tests.id('queue_b2')) and guest_name like 'Dee%'),
  'cross-tenant: one phone has unrelated hashes on two orgs'' queues, so they cannot link it');

-- A lost response: the same key again from the same phone gets the link; the key alone does not
-- (staff can read idempotency keys from app.visits).
select tests.as_anon();
insert into tests.results values
  ('lost', api.join_queue(tests.id('queue_a'), null, 'Lou', null, null, 1, null, tests.id('key_lost'), tests.device(3)));
insert into tests.results values
  ('lost_retry', api.join_queue(tests.id('queue_a'), null, 'Lou', null, null, 1, null, tests.id('key_lost'), tests.device(3)));
insert into tests.results values
  ('key_only', api.join_queue(tests.id('queue_a'), null, 'Lou', null, null, 1, null, tests.id('key_lost')));
insert into tests.results values
  ('key_other_device', api.join_queue(tests.id('queue_a'), null, 'Lou', null, null, 1, null, tests.id('key_lost'), tests.device(4)));
select tests.as_postgres();
select is((select (r).token from tests.results where name = 'lost_retry'),
          (select (r).token from tests.results where name = 'lost'),
  'retrying a key from the phone that joined returns the visit''s link');
select ok((select (r).token is null and (r).display_ticket is not null from tests.results where name = 'key_only')
          and (select (r).token is null from tests.results where name = 'key_other_device'),
  'a replayed key without that phone''s device key returns the ticket but never the link');
select is((select count(*)::int from vault.secrets where name = 'guest_token_secret'), 1,
  'the token secret is in Vault');

select private.join_core(tests.id('queue_a'), null, 'Walk-in', null, null, null, null,
  tests.id('key_staff'), 'staff', 'staff', tests.id('staff'));
select tests.as_anon();
insert into tests.results values
  ('staff_key', api.join_queue(tests.id('queue_a'), null, 'Walk-in', null, null, 1, null, tests.id('key_staff')));
select tests.as_postgres();
select is((select (r).token from tests.results where name = 'staff_key'), null,
  'replaying a staff add''s key from the guest API never returns that visit''s token');

------------------------------------------------------------------------------------------------
-- Kiosks serve many guests; bad keys
------------------------------------------------------------------------------------------------
select tests.act_as('kiosk');
select api.join_queue(tests.id('queue_a'), null, 'Kiosk ' || i, null, null, 1, null, gen_random_uuid(), tests.device(9))
from generate_series(1, 2) i;
select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_a') and guest_name like 'Kiosk %'
             and device_key_hash is null), 2,
  'a kiosk''s device key is ignored: two guests at the kiosk get two visits');

select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'X', null, null, 1, null, gen_random_uuid(), 'short') $$,
  'P0001', 'invalid_input', 'a device key under 22 characters is invalid_input');
select throws_ok($$ select api.join_queue(tests.id('queue_a'), null, 'X', null, null, 1, null, gen_random_uuid(), repeat('a', 30) || '/') $$,
  'P0001', 'invalid_input', 'a device key outside base64url is invalid_input');
select is((api.join_queue(tests.id('queue_a'), null, 'Blank', null, null, 1, null, gen_random_uuid(), '  ')).status::text,
  'waiting', 'a blank device key counts as none');

------------------------------------------------------------------------------------------------
-- Limits: per phone on a network, then per network
------------------------------------------------------------------------------------------------
select tests.from_ip('203.0.113.9');
select api.join_queue(tests.id('queue_wifi'), null, 'Guest ' || i, null, null, 1, null, gen_random_uuid(), tests.device(100 + i))
from generate_series(1, 11) i;
select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_wifi')), 11,
  'eleven phones behind one Wi-Fi all get in (the IP-only cap was 10)');

select tests.as_anon();
do $$
declare t text;
begin
  -- One phone joining and leaving ten times uses up its own budget of 10 per 10 minutes.
  for i in 1..10 loop
    t := (api.join_queue(tests.id('queue_wifi'), null, 'Churn', null, null, 1, null, gen_random_uuid(), tests.device(1))).token;
    perform api.guest_act(t, 'leave', gen_random_uuid());
  end loop;
end $$;
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_wifi'), null, 'Churn', null, null, 1, null, gen_random_uuid(), tests.device(1)) $$),
  'client', 'one phone still gets at most 10 joins per queue in 10 minutes (rate_limited client)');

-- 21 joins from this network so far (11 phones, 10 churn); fresh device keys fill it to 60.
select api.join_queue(tests.id('queue_wifi'), null, 'More ' || i, null, null, 1, null, gen_random_uuid(), tests.device(200 + i))
from generate_series(1, 39) i;
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_wifi'), null, 'Mint', null, null, 1, null, gen_random_uuid(), tests.device(999)) $$),
  'network', 'minting device keys stops at 60 joins per network per queue (rate_limited network)');
select tests.as_postgres();
update private.deployment_settings set per_network_joins = 100;
select tests.as_anon();
select is((api.join_queue(tests.id('queue_wifi'), null, 'Big venue', null, null, 1, null, gen_random_uuid(), tests.device(998))).status::text,
  'waiting', 'a deployment can raise the per-network cap');
select tests.from_ip('192.0.2.50');
select is((api.join_queue(tests.id('queue_wifi'), null, 'Elsewhere', null, null, 1, null, gen_random_uuid(), tests.device(999))).status::text,
  'waiting', 'a guest on another network is not affected');

select * from finish();
rollback;
