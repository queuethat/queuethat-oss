-- 2B-I4 (#309): api_v1 write endpoints.
begin;
\ir ../helpers/_setup.psql
select plan(13);

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

create function tests.mk_key(p_name text, p_org text, p_scopes text[]) returns text language plpgsql as $$
declare plain text := 'qk_live_' || substr(md5(p_name), 1, 8) || '_' || md5(p_name || 'x');
begin
  insert into app.api_keys (org_id, name, prefix, secret_hash, scopes)
  values (tests.id(p_org), p_name, substr(md5(p_name), 1, 8), extensions.digest(plain, 'sha256'), p_scopes);
  return plain;
end $$;
create function tests.with_key(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-api-key', p_key)::text, true);
end $$;
grant execute on function tests.with_key(text) to anon;

select tests.as_postgres();
delete from app.business_hours where location_id in (tests.id('loc_a'), tests.id('loc_b'));
delete from app.hours_exceptions where location_id in (tests.id('loc_a'), tests.id('loc_b'));
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Org B queue', 'C');
select tests.new_visit('v_b', 'queue_b', 'Bob');
create table tests.k (name text primary key, plain text);
grant select on tests.k to anon;
insert into tests.k values
  ('w', tests.mk_key('w', 'org_a', array['visits:write', 'queues:write', 'visits:read'])),
  ('r', tests.mk_key('r', 'org_a', array['visits:read']));
create table tests.res (name text primary key, id uuid);
grant all on tests.res to anon;

select tests.as_anon();
select tests.with_key((select plain from tests.k where name = 'w'));
insert into tests.res select 'v1', (api_v1.create_visit(tests.id('queue_a'), null, 'Ann', '+15555550100', null, 1,
  '00000000-0000-0000-0000-0000000000b1')).id;
select is((select status from api_v1.get_visit((select id from tests.res where name = 'v1'))), 'waiting', 'create_visit adds a waiting visit');
-- AC2
select is((api_v1.create_visit(tests.id('queue_a'), null, 'Ann', '+15555550100', null, 1,
  '00000000-0000-0000-0000-0000000000b1')).id, (select id from tests.res where name = 'v1'), 'AC2: the same idempotency key returns the same visit');
select tests.as_postgres();
select is((select count(*)::int from app.visits where guest_name = 'Ann'), 1, 'AC2: one visit exists');
select is((select source from app.visits where guest_name = 'Ann'), 'api', 'the visit source is api');
select is((select e.actor_kind::text from app.visit_events e where e.visit_id = (select id from tests.res where name = 'v1') order by e.id limit 1),
  'api_key', 'the join event actor is the API key');

-- transition (AC3, AC4)
select tests.as_anon();
select tests.with_key((select plain from tests.k where name = 'w'));
select is((api_v1.transition_visit((select id from tests.res where name = 'v1'), 'call', 0,
  '00000000-0000-0000-0000-0000000000b2')).status, 'called', 'transition_visit calls the visit');
select is(tests.error_of(format($$select api_v1.transition_visit(%L, 'start', 0, gen_random_uuid())$$,
  (select id from tests.res where name = 'v1'))), 'P0001 stale_visit', 'AC3: a stale expected_version');
select tests.as_postgres();
select is((select e.actor_id from app.visit_events e where e.visit_id = (select id from tests.res where name = 'v1')
           and e.type = 'call' order by e.id desc limit 1),
  (select id from app.api_keys where name = 'w'), 'AC4: the event actor is the key id');
select is((select e.actor_kind::text from app.visit_events e where e.visit_id = (select id from tests.res where name = 'v1')
           and e.type = 'call' order by e.id desc limit 1), 'api_key', 'AC4: actor_kind api_key');

-- AC5, scopes, AC1
select tests.as_anon();
select tests.with_key((select plain from tests.k where name = 'w'));
select is(tests.error_of(format($$select api_v1.transition_visit(%L, 'call', 0, gen_random_uuid())$$, tests.id('v_b'))),
  'P0001 not_found', 'AC5: org A key, org B visit');
select tests.with_key((select plain from tests.k where name = 'r'));
select is(tests.error_of(format($$select api_v1.set_queue_state(%L, 'closed')$$, tests.id('queue_a'))),
  'P0001 insufficient_scope', 'a read key cannot change queue state');
select tests.with_key((select plain from tests.k where name = 'w'));
select is((api_v1.set_queue_state(tests.id('queue_a'), 'closed')).accepting, false, 'set_queue_state closes the queue');
select is(tests.error_of(format($$select api_v1.create_visit(%L, null, 'Zed', null, null, 1, gen_random_uuid())$$, tests.id('queue_a'))),
  'P0001 queue_not_accepting', 'AC1: a closed queue does not accept');

select * from finish();
rollback;
