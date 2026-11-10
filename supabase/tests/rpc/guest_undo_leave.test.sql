-- #528: a guest takes back a leave (api.guest_act undo_leave).
begin;
\ir ../helpers/_setup.psql
select plan(15);
select tests.create_world();

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_u'), tests.id('org_a'), tests.id('loc_a'), 'Undo', 'U');

create table tests.tokens (name text primary key, token text, visit_id uuid);
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.tokens to anon;
select set_config('request.headers', '{"x-real-ip": "198.51.100.77"}', true);

select tests.as_anon();
insert into tests.tokens (name, token)
  select n, (api.join_queue(tests.id('queue_u'), null, initcap(n), null, null, 1, 'en', gen_random_uuid())).token
  from unnest(array['ann', 'bob', 'cy', 'di']) n;
select tests.as_postgres();
update tests.tokens t set visit_id = v.id from app.visits v where v.guest_token_hash = private.token_hash(t.token);

create function tests.status(p_name text) returns api.visit_status
language sql as $$ select api.get_visit_status((select token from tests.tokens where name = p_name)) $$;
create function tests.act(p_name text, p_action api.guest_action)
returns api.visit_status
language sql as $$ select api.guest_act((select token from tests.tokens where name = p_name), p_action, gen_random_uuid()) $$;
create function tests.vid(p_name text) returns uuid
language sql as $$ select visit_id from tests.tokens where name = p_name $$;
grant execute on all functions in schema tests to anon;

select tests.as_anon();
select is((tests.status('bob')).position, 2, 'setup: Bob is second');
select is((tests.act('bob', 'leave')).status, 'cancelled', 'Bob leaves');
select ok('undo_leave' = any ((tests.status('bob')).guest_actions), 'the status offers undo_leave');
select is((tests.status('cy')).position, 2, 'Cy moved up to second');

-- Undo: back in the line at the old place
select is((tests.act('bob', 'undo_leave')).status, 'waiting', 'undo_leave puts Bob back in the line');
select is((tests.status('bob')).position, 2, 'at his old place, ahead of Cy');
select is((tests.status('cy')).position, 3, 'Cy moved back');
select ok(not ('undo_leave' = any ((tests.status('bob')).guest_actions)), 'no longer offered');
select is((tests.act('bob', 'undo_leave')).status, 'waiting', 'repeating it is a no-op');
select tests.as_postgres();
select is((select count(*)::int from app.visit_events where visit_id = tests.vid('bob') and type = 'undo'), 1,
  'one undo event, by the guest');

-- Closed by time
select tests.as_anon();
select tests.act('cy', 'leave');
select tests.as_postgres();
alter table app.visit_events disable trigger guard_visit_event;
update app.visit_events set occurred_at = now() - interval '11 minutes'
  where visit_id = tests.vid('cy') and type = 'cancel';
alter table app.visit_events enable trigger guard_visit_event;
select tests.as_anon();
select throws_ok($$ select tests.act('cy', 'undo_leave') $$, 'P0001', 'illegal_transition', 'after 10 minutes it is refused');

-- Staff removal is not the guest's to undo
select tests.as_postgres();
select tests.act_as('staff');
select api.transition_visit(v.id, 'remove', v.version, gen_random_uuid(), null, 'test')
  from app.visits v where v.id = (select visit_id from tests.tokens where name = 'di');
select tests.as_anon();
select throws_ok($$ select tests.act('di', 'undo_leave') $$, 'P0001', 'illegal_transition', 'a staff removal cannot be undone by the guest');

-- Once per visit
select tests.act('bob', 'leave');
select ok(not ('undo_leave' = any ((tests.status('bob')).guest_actions)), 'a second leave offers no second undo');
select throws_ok($$ select tests.act('bob', 'undo_leave') $$, 'P0001', 'illegal_transition', 'and refuses it');

-- Not available to someone still waiting
select throws_ok($$ select api.guest_act('x', 'undo_leave', gen_random_uuid()) $$, 'P0001', 'not_found',
  'an unknown token is not_found');

select * from finish();
rollback;
