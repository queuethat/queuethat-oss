-- 2B-I3 (#308): api_v1 read endpoints, authenticated by the X-API-Key header.
begin;
\ir ../helpers/_setup.psql
select plan(16);

select tests.create_world();

create function tests.error_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function tests.error_of(text) to anon;

-- A key with a known plaintext, plus a second location and an org B queue and visit.
create function tests.mk_key(p_name text, p_org text, p_scopes text[], p_locs uuid[] default null)
returns text language plpgsql as $$
declare plain text := 'qk_live_' || substr(md5(p_name), 1, 8) || '_' || md5(p_name || 'x');
begin
  insert into app.api_keys (org_id, name, prefix, secret_hash, scopes, location_ids)
  values (tests.id(p_org), p_name, substr(md5(p_name), 1, 8), extensions.digest(plain, 'sha256'), p_scopes, p_locs);
  return plain;
end $$;

select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Second', 'test-location-a2', 'America/New_York');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_a2'), tests.id('org_a'), tests.id('loc_a2'), 'Other site', 'B'),
       (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B queue', 'C');
select tests.new_visit('v_a', 'queue_a', 'Alice Secret');
select tests.new_visit('v_b', 'queue_b', 'Bob');
create table tests.k (name text primary key, plain text);
grant select on tests.k to anon;
insert into tests.k values
  ('all', tests.mk_key('all', 'org_a', array['queues:read', 'visits:read'])),
  ('qonly', tests.mk_key('qonly', 'org_a', array['queues:read'])),
  ('loc', tests.mk_key('loc', 'org_a', array['queues:read', 'visits:read'], array[tests.id('loc_a2')])),
  ('rl', tests.mk_key('rl', 'org_a', array['queues:read']));

/** Calls as anon the way PostgREST does: an X-API-Key header and no session. */
create function tests.with_key(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-api-key', coalesce(p_key, ''))::text, true);
end $$;
grant execute on function tests.with_key(text) to anon;

select tests.as_anon();
select tests.with_key((select plain from tests.k where name = 'all'));
select is((select count(*)::int from api_v1.list_queues()), 2, 'a key lists the org queues');
select is((select (api_v1.get_queue(tests.id('queue_a'))).waiting_count), 2, 'get_queue reports the waiting count');
select is((select count(*)::int from api_v1.list_visits(tests.id('queue_a'))), 2, 'list_visits returns the visits');
select is((select count(*)::int from api_v1.list_visits(tests.id('queue_a'), array['served'])), 0, 'status filter applies');
select is((select count(*)::int from api_v1.list_visits(tests.id('queue_a'), null, now() + interval '1 hour')), 0,
  'updated_after applies');
select is((select bool_or(row_to_json(v)::text like '%Alice%') from api_v1.list_visits(tests.id('queue_a')) v), false,
  'guest names never appear');
select is((select (api_v1.get_visit(tests.id('v_a'))).status), 'waiting', 'get_visit returns the visit');

-- AC1 cross tenant
select is(tests.error_of(format('select * from api_v1.list_visits(%L)', tests.id('queue_b'))), 'P0001 not_found',
  'AC1: org A key, org B queue => not_found');
select is(tests.error_of(format('select * from api_v1.get_visit(%L)', tests.id('v_b'))), 'P0001 not_found',
  'AC1: org A key, org B visit => not_found');

-- AC2
select tests.with_key((select plain from tests.k where name = 'qonly'));
select is(tests.error_of(format('select * from api_v1.list_visits(%L)', tests.id('queue_a'))), 'P0001 insufficient_scope',
  'AC2: a key without visits:read');

-- AC3
select tests.with_key(null);
select is(tests.error_of('select * from api_v1.list_queues()'), 'P0001 unauthorized', 'AC3: no header');
select tests.with_key('qk_live_00000000_00000000000000000000000000000000');
select is(tests.error_of('select * from api_v1.list_queues()'), 'P0001 unauthorized', 'AC3: invalid key');

-- AC5
select tests.with_key((select plain from tests.k where name = 'loc'));
select is((select array_agg(name) from api_v1.list_queues()), array['Other site'], 'AC5: a location-restricted key sees only its queues');
select is(tests.error_of(format('select * from api_v1.get_queue(%L)', tests.id('queue_a'))), 'P0001 not_found',
  'AC5: and gets not_found for another location');

-- AC4
select tests.with_key((select plain from tests.k where name = 'rl'));
select tests.as_postgres();
insert into private.rate_buckets (key, window_start, count)
select 'apikey:' || id, date_trunc('minute', now()), 600 from app.api_keys where name = 'rl';
select tests.as_anon();
select tests.with_key((select plain from tests.k where name = 'rl'));
select is(tests.error_of('select * from api_v1.list_queues()'), 'P0001 rate_limited', 'AC4: the 601st request in a minute');

-- AC6
select throws_ok($$ select * from app.queues $$, '42501', null, 'AC6: anon still cannot select app tables');

select * from finish();
rollback;
