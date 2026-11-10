-- 2B-J5 (#243): companions on a party.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;
select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_a'), null, n, null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['ann', 'bob']) n;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.vid(p_name text) returns uuid language sql as $$ select visit_id from tests.tokens where name = p_name $$;
create function tests.add(p_name text, p_first text, p_key uuid default gen_random_uuid()) returns api.visit_status
language sql as $$ select api.guest_add_companion((select token from tests.tokens where name = p_name), p_first, p_key) $$;
grant execute on all functions in schema tests to anon, authenticated;

-- AC1
select tests.as_anon();
select tests.add('ann', 'Maya', '00000000-0000-0000-0000-000000000001');
select tests.add('ann', 'Noah');
select tests.as_postgres();
select is((select party_size from app.visits where id = tests.vid('ann')), 3, 'AC1: two companions make a party of 3');
select is((select count(*)::int from app.visit_events where visit_id = tests.vid('ann') and type = 'party_changed'), 2,
  'AC1: a party_changed event per change');
select is((select count(*)::int from app.visit_events where visit_id = tests.vid('ann') and payload::text like '%Maya%'), 0,
  'event payloads carry no names');
select tests.as_anon();
select tests.add('ann', 'Maya', '00000000-0000-0000-0000-000000000001');
select tests.as_postgres();
select is((select count(*)::int from app.visit_companions where visit_id = tests.vid('ann')), 2, 'a repeated key adds nothing');
select tests.as_anon();
select is((select jsonb_array_length((api.get_visit_status((select token from tests.tokens where name = 'ann'))).companions)), 2,
  'the token holder sees the companions in the status');

-- AC2
select lives_ok($$ select tests.add('ann', 'P' || g) from generate_series(1, 7) g $$, 'adds up to nine companions');
select throws_ok($$ select tests.add('ann', 'Tenth') $$, 'P0001', 'party_limit', 'AC2: the 10th companion raises party_limit');
select throws_ok($$ select tests.add('ann', '   ') $$, 'P0001', 'invalid_input', 'a blank name is invalid');
select throws_ok($$ select tests.add('ann', repeat('x', 41)) $$, 'P0001', 'invalid_input', 'a 41-character name is invalid');

-- removing
select tests.as_postgres();
select is((select count(*)::int from app.visit_companions where visit_id = tests.vid('ann')), 9, 'nine companions stored');
create table tests.cids as select id from app.visit_companions where visit_id = tests.vid('ann');
grant select on tests.cids to anon;
create function tests.remove_all() returns void language plpgsql as $$
declare c uuid;
begin
  for c in select id from tests.cids loop
    perform api.guest_remove_companion((select token from tests.tokens where name = 'ann'), c);
    perform api.guest_remove_companion((select token from tests.tokens where name = 'ann'), c);
  end loop;
end $$;
grant execute on function tests.remove_all() to anon;
select tests.as_anon();
select tests.remove_all();
select tests.as_postgres();
select is((select party_size from app.visits where id = tests.vid('ann')), 1, 'removing everyone (twice each, a no-op) restores a party of 1');

-- AC3
select tests.as_anon();
select throws_ok($$ select api.guest_add_companion('nope', 'X', gen_random_uuid()) $$, 'P0001', 'not_found', 'AC3: unknown token is not_found');
select tests.as_postgres();
select private.set_actor('system', null, 'cancel');
update app.visits set status = 'cancelled', finished_at = now() - interval '13 hours' where id = tests.vid('bob');
select tests.as_anon();
select throws_ok($$ select tests.add('bob', 'X') $$, 'P0001', 'not_found', 'AC3: an expired token gives the same not_found');

-- staff + AC4
select tests.act_as('staff');
select is((select (api.staff_set_companions(tests.vid('ann'), array[' Kim ', '', 'Lee'],
  (select version from app.visits where id = tests.vid('ann')), gen_random_uuid())).party_size), 3,
  'staff replace the companions: blanks dropped, party of 3');
select tests.as_user(tests.id('other_owner'));
select throws_ok(format($$ select api.staff_set_companions(%L, array['X'], 1, gen_random_uuid()) $$, tests.vid('ann')),
  'P0001', 'not_found', 'AC4: staff of org B get not_found');

-- AC5
select tests.act_as('display');
select is((select count(*)::int from api.display_snapshot(tests.id('loc_a')) s where s::text like '%Kim%'), 0,
  'AC5: display_snapshot shows no companion names');
select tests.as_postgres();
select is(private.anonymize_visits(tests.id('org_a'), array[tests.vid('ann')]), 1, 'anonymizing the visit...');
select is((select count(*)::int from app.visit_companions where visit_id = tests.vid('ann')), 0, '...deletes its companions');

select * from finish();
rollback;
