-- M4 (#1291): the "Anyone available" pool. A provider's call_next serves their own line first, then the pool
-- their line pulls from; the pool's ETA counts its providers; a scoped provider reaches the pool; other tenants
-- never do. Concurrent callers are covered in tests/concurrency/pool_call_next.test.ts (pgTAP is one session).
begin;
\ir ../helpers/_setup.psql
select plan(30);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix, kind) values
  (tests.new_id('pool'), tests.id('org_a'), tests.id('loc_a'), 'Anyone available', 'P', 'pool'),
  (tests.new_id('pool_empty'), tests.id('org_a'), tests.id('loc_a'), 'Empty pool', 'E', 'pool'),
  (tests.new_id('prov2'), tests.id('org_a'), tests.id('loc_a'), 'Second provider', 'B', 'general'),
  (tests.new_id('solo'), tests.id('org_a'), tests.id('loc_a'), 'Solo', 'S', 'general'),
  (tests.new_id('pool_b'), tests.id('org_b'), tests.id('loc_b'), 'Pool B', 'P', 'pool');
select tests.create_user('scoped');
select tests.create_user('scoped2');
select tests.new_id(k) from unnest(array['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12', 'k13', 'k14', 'k15']) k;

create function tests.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then return sqlerrm;
end $$;
create function tests.cn(p_queue text, p_key text) returns uuid language sql as $$
  select (api.call_next(tests.id(p_queue), null, tests.id(p_key))).id
$$;
create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
grant execute on function tests.err(text), tests.cn(text, text), tests.ver(text) to authenticated;

-- Schema rules.
select throws_ok($$ update app.queues set pulls_from = tests.id('pool') where id = tests.id('queue_a') $$,
  '23514', null, 'only a provider line may pull from a pool');
update app.queues set kind = 'provider' where id = tests.id('queue_a');
select throws_ok($$ update app.queues set pulls_from = tests.id('solo') where id = tests.id('queue_a') $$,
  'P0001', 'invalid_input', 'a provider can only pull from a pool');
select throws_ok($$ update app.queues set pulls_from = tests.id('pool_b') where id = tests.id('queue_a') $$,
  '23503', null, 'a pool of another organization is rejected');
update app.queues set pulls_from = tests.id('pool') where id = tests.id('queue_a');
update app.queues set kind = 'provider', pulls_from = tests.id('pool') where id = tests.id('prov2');
select throws_ok($$ update app.queues set kind = 'general' where id = tests.id('pool') $$,
  'P0001', 'invalid_input', 'a pool with providers cannot stop being a pool');

-- ETA servers: the pool counts its providers; a pool without providers is unstaffed.
select is(private.eta_servers(tests.id('pool')), 2, 'pool servers = the providers'' servers_on_duty');
select is(private.eta_servers(tests.id('queue_a')), 1, 'a provider line still counts its own servers');
select is(private.eta_servers(tests.id('pool_empty')), 0, 'a pool with no providers has no servers');
select is((private.eta_at(tests.id('pool_empty'), null)).eta_state::text, 'unstaffed', 'and its ETA says unstaffed');
select is((private.eta_at(tests.id('pool'), null)).eta_state::text, 'next', 'a staffed empty pool quotes next');

-- Pool visits join first, then own-line visits: own line still wins.
select tests.new_visit(n, 'pool') from unnest(array['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7', 'z8', 'z9']) n;
select tests.new_visit(n, 'prov2') from unnest(array['b1']) n;
select tests.new_visit(n, 'solo') from unnest(array['s1']) n;

insert into app.memberships (org_id, user_id, role, queue_ids) values
  (tests.id('org_a'), tests.id('scoped'), 'staff', array[tests.id('queue_a')]),
  (tests.id('org_a'), tests.id('scoped2'), 'staff', array[tests.id('solo')]);
select tests.act_as('staff');
select is(tests.cn('queue_a', 'k1'), tests.id('visit_a'), 'provider call_next takes their own line first');
select is(tests.cn('queue_a', 'k1'), tests.id('visit_a'), 'replaying the key returns the same visit');
select is((select queue_id from app.visits where id = tests.cn('queue_a', 'k2')), tests.id('pool'),
  'then falls back to the pool');
select is(tests.cn('prov2', 'k3'), tests.id('b1'), 'the other provider also takes their own line first');
select is(tests.cn('prov2', 'k4'), tests.id('z2'), 'and then the next pool guest, never the one already called');
select is((select count(distinct id) from app.visits where status = 'called'), 4::bigint, 'four different guests are called');
select is(tests.cn('solo', 'k5'), tests.id('s1'), 'a line that pulls from nothing serves itself');
select is(tests.cn('solo', 'k6'), null, 'and ignores the pool when empty');
select is((select version > 0 from app.queues where id = tests.id('pool')), true, 'the pool''s version moved when it lost a guest');

select tests.as_postgres();
update app.queues set archived_at = now() where id = tests.id('pool');
select tests.act_as('staff');
select is(tests.cn('queue_a', 'k7'), null, 'an archived pool is not pulled from');
select tests.as_postgres();
update app.queues set archived_at = null where id = tests.id('pool');
select tests.act_as('staff');

select is((api.transfer_visit(tests.id('z9'), tests.id('prov2'), null, tests.ver('z9'), tests.id('k8'))).queue_id,
  tests.id('prov2'), 'a pool guest transfers to a provider line');

-- Queue scope (M1/M2): a scoped provider reaches the pool their line pulls from, nothing else.
select tests.act_as('admin');
update app.organizations set scope_staff_to_lines = true where id = tests.id('org_a');
select tests.as_user(tests.id('scoped'));
select is((select queue_id from app.visits where id = tests.cn('queue_a', 'k9')), tests.id('pool'),
  'scoped provider''s call_next falls back to the pool');
select is((api.transition_visit(tests.id('z5'), 'call', tests.ver('z5'), tests.id('k10'))).status::text, 'called',
  'scoped provider acts on a pool guest');
select is((api.transfer_visit(tests.id('z6'), tests.id('queue_a'), null, tests.ver('z6'), tests.id('k11'))).queue_id,
  tests.id('queue_a'), 'scoped provider transfers a pool guest into their line');
select is(tests.err($$ select api.transfer_visit(tests.id('z7'), tests.id('prov2'), null, tests.ver('z7'), tests.id('k12')) $$),
  'not_found', 'but not into a line outside their scope');
select is(tests.err($$ select tests.cn('prov2', 'k13') $$), 'not_found', 'nor call from another provider''s line');
select is(tests.err($$ select tests.cn('pool', 'k14') $$), 'ok', 'scoped provider calls the pool directly');

select tests.as_user(tests.id('scoped2'));
select is(tests.err($$ select api.transition_visit(tests.id('z8'), 'call', tests.ver('z8'), tests.id('k15')) $$), 'not_found',
  'staff scoped to a line that pulls from nothing cannot act on pool guests');
select is(tests.err($$ select tests.cn('pool', 'k15') $$), 'not_found', 'nor call the pool');

-- Cross tenant.
select tests.act_as('other_owner');
select is(tests.err($$ select tests.cn('pool', 'k15') $$), 'not_found', 'another organization cannot call the pool');
select is(tests.err($$ select tests.cn('queue_a', 'k15') $$), 'not_found', 'nor a provider line that pulls from it');

select * from finish();
rollback;
