-- V2 (#31): api.call_next and api.transition_visit.
begin;
\ir ../helpers/_setup.psql
select plan(57);
select tests.create_world();

-- Fixtures: queue_t with three waiting visits, an empty queue, a second org A location with its
-- own staff member, and an org B counter.
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_t'), tests.id('org_a'), tests.id('loc_a'), 'Transitions', 'T'),
  (tests.new_id('queue_empty'), tests.id('org_a'), tests.id('loc_a'), 'Empty', 'E');
select tests.new_visit('t1', 'queue_t', 'Tia');
select tests.new_visit('t2', 'queue_t', 'Tom');
select tests.new_visit('t3', 'queue_t', 'Tess');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'America/New_York');
insert into app.memberships (org_id, user_id, role, location_ids)
values (tests.id('org_a'), tests.create_user('staff_a2'), 'staff', array[tests.id('loc_a2')]);
insert into tests.actors values ('staff_a2', 'authenticated',
  jsonb_build_object('sub', tests.id('staff_a2'), 'role', 'authenticated', 'aud', 'authenticated'));
insert into app.counters (id, org_id, location_id, label) values
  (tests.new_id('counter_a2'), tests.id('org_a'), tests.id('loc_a'), 'Chair 2'),
  (tests.new_id('counter_b'), tests.id('org_b'), tests.id('loc_b'), 'Desk B');
select tests.new_id(k) from unnest(array['k_empty', 'k_c1', 'k_c2', 'k_stale', 'k_start', 'k_complete']) k;
create table tests.rows (name text primary key, r api.visit_row);
create table tests.marks (name text primary key, n bigint);
insert into tests.marks
  select 'queue_version', version from app.queues where id = tests.id('queue_t');
insert into tests.marks
  select 'audit', count(*) from app.audit_log where table_name = 'queues';
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.rows to authenticated;

------------------------------------------------------------------------------------------------
-- AC3: empty queue
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select is(api.call_next(tests.id('queue_empty'), tests.id('counter_a'), tests.id('k_empty')), null,
  'AC3: call_next on an empty queue returns null');
select tests.as_postgres();
select tests.new_visit('e1', 'queue_empty');
select tests.act_as('staff');
select is(api.call_next(tests.id('queue_empty'), tests.id('counter_a'), tests.id('k_empty')), null,
  'repeating the key of an empty call returns null even after someone joined');
select is((api.call_next(tests.id('queue_empty'), null, gen_random_uuid())).id, tests.id('e1'),
  'a new key calls the guest who joined; the counter is optional');

------------------------------------------------------------------------------------------------
-- call_next: order, fields, idempotency, events, queue version
------------------------------------------------------------------------------------------------
insert into tests.rows values
  ('c1', api.call_next(tests.id('queue_t'), tests.id('counter_a'), tests.id('k_c1')));
insert into tests.rows values
  ('c1_again', api.call_next(tests.id('queue_t'), tests.id('counter_a'), tests.id('k_c1')));
insert into tests.rows values
  ('c2', api.call_next(tests.id('queue_t'), tests.id('counter_a2'), tests.id('k_c2')));
select tests.as_postgres();

select is((select (r).id from tests.rows where name = 'c1'), tests.id('t1'),
  'call_next calls the first waiting visit by sort_key');
select results_eq($$ select (r).status::text, (r).call_count, (r).counter_label, (r).called_at is not null,
                            (r).position, (r).version from tests.rows where name = 'c1' $$,
  $$ values ('called', 1, 'Chair 1', true, null::int, 1) $$,
  'the called row: status called, call_count 1, counter label, called_at set, no position, version 1');
select is((select (r).allowed_actions from tests.rows where name = 'c1'),
  private.allowed_actions('called'), 'the row carries allowed_actions for its status');
select is((select (r).last_event_id from tests.rows where name = 'c1'),
  (select max(id) from app.visit_events where visit_id = tests.id('t1')),
  'last_event_id is the call event');
select is((select to_jsonb(r) from tests.rows where name = 'c1_again'),
  (select to_jsonb(r) from tests.rows where name = 'c1'),
  'repeating a call_next key returns the first result');
select is((select (r).id from tests.rows where name = 'c2'), tests.id('t2'),
  'a second call_next with a new key calls the next visit');
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_t') and status = 'called'), 2,
  'the repeated key called nobody else');
select results_eq($$ select type, from_status::text, to_status::text, actor_kind::text, actor_id, payload
                     from app.visit_events where visit_id = tests.id('t1') order by id $$,
  $$ values ('joined', null, 'waiting', 'system', null::uuid, '{}'::jsonb),
            ('call', 'waiting', 'called', 'staff', tests.id('staff'),
             jsonb_build_object('counter_id', tests.id('counter_a'))) $$,
  'call_next writes one call event with the staff actor and counter');
select is((select version from app.queues where id = tests.id('queue_t')),
  (select n + 2 from tests.marks where name = 'queue_version'),
  'each call bumps queues.version once; the replay does not');
select is((select count(*) from app.audit_log where table_name = 'queues'),
  (select n from tests.marks where name = 'audit'),
  'version bumps do not write queue audit rows');
update app.queues set name = 'Transitions!' where id = tests.id('queue_t');
select is((select count(*) from app.audit_log where table_name = 'queues'),
  (select n + 1 from tests.marks where name = 'audit'),
  'a real queue config change is still audited');
select is((private.visit_row(tests.id('t3'))).position, 1,
  'the remaining waiting visit is position 1');

------------------------------------------------------------------------------------------------
-- AC1: other tenants, other locations and devices get not_found
------------------------------------------------------------------------------------------------
select tests.act_as('other_owner');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 0, gen_random_uuid()) $$, tests.id('t3')),
  'P0001', 'not_found', 'AC1: org B staff transitioning an org A visit get not_found');
select throws_ok($$ select api.transition_visit(gen_random_uuid(), 'call', 0, gen_random_uuid()) $$,
  'P0001', 'not_found', 'AC1: the same error as for a visit that does not exist');
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_t')),
  'P0001', 'not_found', 'AC1: org B staff calling next in an org A queue get not_found');
select tests.act_as('staff_a2');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 0, gen_random_uuid()) $$, tests.id('t3')),
  'P0001', 'not_found', 'staff limited to another location get not_found for the visit');
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_t')),
  'P0001', 'not_found', 'staff limited to another location get not_found for the queue');
select tests.act_as('display');
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_t')),
  'P0001', 'not_found', 'a paired display cannot call next');
select tests.act_as('kiosk');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 0, gen_random_uuid()) $$, tests.id('t3')),
  'P0001', 'not_found', 'a paired kiosk cannot transition visits');
select tests.act_as('staff');
select throws_ok(format($$ select api.call_next(%L, %L, gen_random_uuid()) $$, tests.id('queue_t'), tests.id('counter_b')),
  'P0001', 'not_found', 'call_next to another org''s counter is not_found');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 0, gen_random_uuid(), %L) $$, tests.id('t3'), tests.id('counter_b')),
  'P0001', 'not_found', 'transition_visit to another org''s counter is not_found');
select tests.as_anon();
select throws_ok(format($$ select api.call_next(%L, null, gen_random_uuid()) $$, tests.id('queue_t')),
  '42501', null, 'anon cannot execute call_next');
select tests.as_postgres();
select is((select status::text from app.visits where id = tests.id('t3')), 'waiting',
  'none of the denied calls changed the visit');

------------------------------------------------------------------------------------------------
-- AC2: stale version; AC4: remove needs a reason
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 99, %L) $$, tests.id('t3'), tests.id('k_stale')),
  'P0001', 'stale_visit', 'AC2: a stale expected_version raises stale_visit');
select tests.as_postgres();
select results_eq($$ select status::text, version, call_count from app.visits where id = tests.id('t3') $$,
  $$ values ('waiting', 0, 0) $$, 'AC2: the stale call changed nothing');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('t3')), 1,
  'AC2: the stale call wrote no event');
select tests.act_as('staff');
select is((api.transition_visit(tests.id('t3'), 'call', 0, tests.id('k_stale'))).status::text, 'called',
  'a key whose call failed can be retried with the current version');

select throws_ok(format($$ select api.transition_visit(%L, 'remove', 1, gen_random_uuid()) $$, tests.id('t3')),
  'P0001', 'invalid_input', 'AC4: remove without a reason is rejected');
select throws_ok(format($$ select api.transition_visit(%L, 'remove', 1, gen_random_uuid(), null, '   ') $$, tests.id('t3')),
  'P0001', 'invalid_input', 'AC4: a blank reason counts as none');
select throws_ok(format($$ select api.transition_visit(%L, 'no_show', 1, gen_random_uuid(), null, repeat('x', 501)) $$, tests.id('t3')),
  'P0001', 'invalid_input', 'a reason over 500 characters is rejected');
select is((select status::text from app.visits where id = tests.id('t3')), 'called',
  'AC4: the rejected removes changed nothing');
select results_eq($$ select (r).status::text, (r).finished_at is not null, (r).allowed_actions
                     from (select api.transition_visit(tests.id('t3'), 'remove', 1, gen_random_uuid(), null, ' Rude to staff ') r) x $$,
  $$ values ('removed', true, '{}'::api.visit_action[]) $$,
  'remove with a reason removes the visit, sets finished_at and leaves no actions');
select tests.as_postgres();
select results_eq($$ select type, reason from app.visit_events where visit_id = tests.id('t3') order by id desc limit 1 $$,
  $$ values ('remove', 'Rude to staff') $$, 'the trimmed reason is on the remove event');

------------------------------------------------------------------------------------------------
-- The rest of the state machine
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select throws_ok(format($$ select api.transition_visit(%L, 'complete', 1, gen_random_uuid()) $$, tests.id('t2')),
  'P0001', 'illegal_transition', 'complete from called is an illegal_transition');
select throws_ok(format($$ select api.transition_visit(%L, 'expire', 1, gen_random_uuid()) $$, tests.id('t2')),
  'P0001', 'illegal_transition', 'staff cannot expire a visit (rollover only)');
select throws_ok(format($$ select api.transition_visit(%L, 'call', 1, null) $$, tests.id('t2')),
  'P0001', 'invalid_input', 'a transition needs an idempotency key');

-- t1: recall to another counter, requeue, call again, start, complete.
insert into tests.rows values ('recall',
  api.transition_visit(tests.id('t1'), 'recall', 1, gen_random_uuid(), tests.id('counter_a2')));
select results_eq($$ select (r).status::text, (r).call_count, (r).counter_label, (r).called_at
                     from tests.rows where name = 'recall' $$,
  $$ select 'called', 2, 'Chair 2', (r).called_at from tests.rows where name = 'c1' $$,
  'recall adds to call_count, moves the counter and keeps the first called_at');
insert into tests.rows values ('requeue', api.transition_visit(tests.id('t1'), 'requeue', 2, gen_random_uuid()));
select results_eq($$ select (r).status::text, (r).sort_key, (r).counter_id, (r).position from tests.rows where name = 'requeue' $$,
  $$ select 'waiting', (r).sort_key, null::uuid, 1 from tests.rows where name = 'c1' $$,
  'requeue goes back to waiting in the same place, at no counter');
select is((api.call_next(tests.id('queue_t'), tests.id('counter_a'), gen_random_uuid())).id, tests.id('t1'),
  'a requeued visit is called next again');
insert into tests.rows values ('start', api.transition_visit(tests.id('t1'), 'start', 4, tests.id('k_start')));
select results_eq($$ select (r).status::text, (r).serving_at is not null, (r).counter_label, (r).call_count
                     from tests.rows where name = 'start' $$,
  $$ values ('serving', true, 'Chair 1', 3) $$, 'start moves to serving and keeps the counter');
select tests.as_postgres();
select is((select assigned_staff_id from app.visits where id = tests.id('t1')), tests.id('staff'),
  'start assigns the visit to the calling staff member');
select tests.act_as('staff');
insert into tests.rows values ('complete', api.transition_visit(tests.id('t1'), 'complete', 5, tests.id('k_complete')));
select results_eq($$ select (r).status::text, (r).finished_at is not null, (r).version from tests.rows where name = 'complete' $$,
  $$ values ('served', true, 6) $$, 'complete moves to served and sets finished_at');
select is(to_jsonb(api.transition_visit(tests.id('t1'), 'complete', 5, tests.id('k_complete'))),
  (select to_jsonb(r) from tests.rows where name = 'complete'),
  'repeating a transition key returns the first result, not stale_visit');
select is(to_jsonb(api.transition_visit(tests.id('t1'), 'start', 4, tests.id('k_start'))),
  (select to_jsonb(r) from tests.rows where name = 'start'),
  'an older key still replays its own result');
select tests.as_postgres();
select is((select array_agg(type order by id) from app.visit_events where visit_id = tests.id('t1')),
  array['joined', 'call', 'recall', 'requeue', 'call', 'start', 'complete'],
  'every transition wrote exactly one event; replays wrote none');
select results_eq($$ select actor_kind::text, actor_id from app.visit_events
                     where visit_id = tests.id('t1') and type <> 'joined' group by 1, 2 $$,
  $$ values ('staff', tests.id('staff')) $$, 'every transition event names the staff actor');

-- t2: no_show then reinstate.
select tests.act_as('staff');
select results_eq($$ select (r).status::text, (r).finished_at is not null, (r).allowed_actions
                     from (select api.transition_visit(tests.id('t2'), 'no_show', 1, gen_random_uuid()) r) x $$,
  $$ values ('no_show', true, '{reinstate}'::api.visit_action[]) $$,
  'no_show finishes the visit; only reinstate is offered');
select results_eq($$ select (r).status::text, (r).finished_at, (r).counter_id, (r).position
                     from (select api.transition_visit(tests.id('t2'), 'reinstate', 2, gen_random_uuid()) r) x $$,
  $$ values ('waiting', null::timestamptz, null::uuid, 1) $$,
  'reinstate returns to waiting in the original place and clears finished_at');

-- cancel on the guest's behalf, from waiting.
select tests.as_postgres();
select tests.new_visit('t4', 'queue_t');
select tests.act_as('staff');
select results_eq($$ select (r).status::text, (r).finished_at is not null
                     from (select api.transition_visit(tests.id('t4'), 'cancel', 0, gen_random_uuid()) r) x $$,
  $$ values ('cancelled', true) $$, 'staff can cancel on the guest''s behalf');
select throws_ok(format($$ select api.transition_visit(%L, 'cancel', 1, gen_random_uuid()) $$, tests.id('t4')),
  'P0001', 'illegal_transition', 'a finished visit cannot be transitioned again');

-- Roles above staff can act; the service day bounds call_next.
select tests.act_as('manager');
select is((api.transition_visit(tests.id('t2'), 'call', 3, gen_random_uuid())).status::text, 'called',
  'a manager can transition visits');
select tests.as_postgres();
select tests.new_visit('old', 'queue_t');
select private.set_actor('system', null);
update app.visits set service_day = service_day - 1, sort_key = 1 where id = tests.id('old');
select tests.act_as('staff');
select is(api.call_next(tests.id('queue_t'), null, gen_random_uuid()), null,
  'call_next ignores a leftover visit from an earlier service day');
select tests.as_postgres();
select is((select status::text from app.visits where id = tests.id('old')), 'waiting',
  'the leftover visit is left for rollover');

select is((select count(*)::int from app.idempotency_keys where actor_id = tests.id('staff')
           and rpc in ('call_next', 'transition_visit')
           and key in (tests.id('k_c1'), tests.id('k_c2'), tests.id('k_empty'), tests.id('k_start'))), 4,
  'idempotency keys are stored per staff actor');

select * from finish();
rollback;
