-- V4 (#33): api.staff_add_visit and api.set_queue_state.
begin;
\ir ../helpers/_setup.psql
select plan(38);
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

-- Fixtures: loc_a open all day; queue_s for staff adds, queue_p for pausing with two waiting
-- visits, a capacity-1 queue, a rate-capped queue, a queue at another location and org B's queue.
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, capacity, join_rate_per_min) values
  (tests.new_id('queue_s'), tests.id('org_a'), tests.id('loc_a'), 'Staff adds', 'S', null, 1),
  (tests.new_id('queue_p'), tests.id('org_a'), tests.id('loc_a'), 'Pausable', 'P', 5, 60),
  (tests.new_id('queue_cap'), tests.id('org_a'), tests.id('loc_a'), 'Small', 'C', 1, 60),
  (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Other org', 'B', null, 60);
-- 2A-Q5: party size is a queue policy; the staff add below brings a party of 3.
update app.queues set party_size_enabled = true, party_size_max = 8 where id = tests.id('queue_s');
select tests.new_visit('p1', 'queue_p', 'Pia');
select tests.new_visit('p2', 'queue_p', 'Pat');
select tests.new_visit('cap1', 'queue_cap', 'Cy');
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'America/New_York');
insert into app.memberships (org_id, user_id, role, location_ids)
values (tests.id('org_a'), tests.create_user('staff_a2'), 'staff', array[tests.id('loc_a2')]);
insert into tests.actors values ('staff_a2', 'authenticated',
  jsonb_build_object('sub', tests.id('staff_a2'), 'role', 'authenticated', 'aud', 'authenticated'));
select tests.new_id(k) from unnest(array['k_add', 'k_known']) k;
create table tests.rows (name text primary key, r api.visit_row);
create table tests.qrows (name text primary key, r api.queue_row);
create table tests.marks (name text primary key, n bigint);
insert into tests.marks select 'version_s', version from app.queues where id = tests.id('queue_s');
insert into tests.marks select 'version_p', version from app.queues where id = tests.id('queue_p');
insert into tests.marks select 'audit_p', count(*) from app.audit_log where row_id = tests.id('queue_p')::text;
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.rows, tests.qrows to authenticated;
grant execute on function tests.error_detail(text) to anon, authenticated;

------------------------------------------------------------------------------------------------
-- staff_add_visit: the walk-in row, idempotency, signal
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows values
  ('add', api.staff_add_visit(tests.id('queue_s'), null, ' Wally ', null, 3, tests.id('k_add')));
insert into tests.rows values
  ('add_again', api.staff_add_visit(tests.id('queue_s'), null, 'Other', null, 1, tests.id('k_add')));
select tests.as_postgres();

select results_eq($$ select (r).status::text, (r).source, (r).guest_name, (r).party_size, (r).position,
                            (r).display_ticket, (r).allowed_actions = private.allowed_actions('waiting')
                     from tests.rows where name = 'add' $$,
  $$ values ('waiting', 'staff', 'Wally', 3, 1, 'S001', true) $$,
  'a staff add returns a waiting visit_row: source staff, position, ticket, allowed_actions');
select results_eq($$ select type, actor_kind::text, actor_id, payload ->> 'source'
                     from app.visit_events e join tests.rows r on e.id = (r.r).last_event_id
                     where r.name = 'add' $$,
  $$ values ('joined', 'staff', tests.id('staff'), 'staff') $$,
  'the joined event names the staff member as actor and staff as source');
select isnt((select guest_token_hash from app.visits v join tests.rows r on v.id = (r.r).id where r.name = 'add'),
  null, 'a token hash is stored, so a QR can be issued for the visit later');
select is((select to_jsonb(r) from tests.rows where name = 'add_again'),
  (select to_jsonb(r) from tests.rows where name = 'add'), 'repeating the key returns the same row');
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_s')), 1,
  'the repeated key added nobody');
select is((select version from app.queues where id = tests.id('queue_s')),
  (select n + 1 from tests.marks where name = 'version_s'), 'one add bumps the queue version once');

------------------------------------------------------------------------------------------------
-- AC1 and the rest of join_core's rules through the staff entry point
------------------------------------------------------------------------------------------------
update app.queues set manual_state = 'closed' where id = tests.id('queue_s');
select tests.act_as('staff');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'Late', null, 1, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'AC1: staff adding a guest to a closed queue raises queue_not_accepting');
select is(tests.error_detail($$ select api.staff_add_visit(tests.id('queue_s'), null, 'Late', null, 1, gen_random_uuid()) $$),
  'closed', 'AC1: the DETAIL says closed');
select is((api.staff_add_visit(tests.id('queue_s'), null, 'Late', null, 1, tests.id('k_add'))).id,
  (select (r).id from tests.rows where name = 'add'), 'a repeated key still returns the visit after close');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_cap'), null, 'Two', null, 1, gen_random_uuid()) $$,
  'P0001', 'capacity_reached', 'a staff add to a full queue raises capacity_reached');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_p'), tests.id('service_a'), 'Sv', null, 1, gen_random_uuid()) $$,
  'P0001', 'not_found', 'a service of another queue is not_found');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_p'), null, 'Big', null, 0, gen_random_uuid()) $$,
  'P0001', 'invalid_input', 'a party of 0 is invalid_input');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_p'), null, 'K', null, 1, null) $$,
  'P0001', 'invalid_input', 'a missing key is invalid_input');
select tests.as_postgres();
update app.queues set manual_state = 'open' where id = tests.id('queue_s');
select tests.act_as('staff');
select lives_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'R' || n, null, 1, gen_random_uuid())
                   from generate_series(1, 3) n $$,
  'staff adds are not rate-capped (queue cap is 1 per minute)');
insert into tests.rows values
  ('known', api.staff_add_visit(tests.id('queue_s'), null, 'Gina', '+1 (415) 555-0123', 1, tests.id('k_known')));
select tests.as_postgres();
select results_eq($$ select v.contact_id, v.guest_id from app.visits v join tests.rows r on v.id = (r.r).id
                     where r.name = 'known' $$,
  $$ values (tests.id('contact_a'), tests.id('guest_a')) $$,
  'a staff add with a phone the org knows links that contact and guest');

------------------------------------------------------------------------------------------------
-- staff_add_visit: who may call it
------------------------------------------------------------------------------------------------
select tests.act_as('other_owner');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'X', null, 1, gen_random_uuid()) $$,
  'P0001', 'not_found', 'cross-tenant: another org''s owner gets not_found');
select tests.act_as('staff_a2');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'X', null, 1, gen_random_uuid()) $$,
  'P0001', 'not_found', 'staff of another location of the same org get not_found');
select tests.act_as('kiosk');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'X', null, 1, gen_random_uuid()) $$,
  'P0001', 'not_found', 'a kiosk device is not staff');
select tests.as_anon();
select throws_ok($$ select api.staff_add_visit(tests.id('queue_s'), null, 'X', null, 1, gen_random_uuid()) $$,
  '42501', null, 'anon cannot call staff_add_visit');

------------------------------------------------------------------------------------------------
-- AC2: set_queue_state(paused)
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.qrows values ('paused', api.set_queue_state(tests.id('queue_p'), 'paused'));
insert into tests.qrows values ('paused_again', api.set_queue_state(tests.id('queue_p'), 'paused'));
select tests.as_postgres();
select results_eq($$ select (r).id, (r).manual_state::text, (r).accepting, (r).not_accepting_reason,
                            (r).waiting_count, (r).capacity, (r).servers_on_duty, (r).ticket_prefix
                     from tests.qrows where name = 'paused' $$,
  $$ values (tests.id('queue_p'), 'paused', false, 'paused', 2, 5, 1, 'P') $$,
  'set_queue_state returns the queue_row: paused, not accepting, reason, counts');
select is((select (r).version from tests.qrows where name = 'paused'),
  (select n + 1 from tests.marks where name = 'version_p'), 'pausing bumps the queue version');
select results_eq($$ select actor, role, before ->> 'manual_state', after ->> 'manual_state'
                     from app.audit_log where row_id = tests.id('queue_p')::text
                     order by id desc limit 1 $$,
  $$ values (tests.id('staff'), 'staff', 'open', 'paused') $$,
  'the change is audited with the staff member, before and after');
select is((select count(*) from app.audit_log where row_id = tests.id('queue_p')::text),
  (select n + 1 from tests.marks where name = 'audit_p'), 'one audit row: the version bump is not audited');
select is((select to_jsonb(r) from tests.qrows where name = 'paused_again'),
  (select to_jsonb(r) from tests.qrows where name = 'paused'),
  'pausing a paused queue changes nothing: same row, same version');

select tests.as_anon();
select throws_ok($$ select api.join_queue(tests.id('queue_p'), null, 'Ann', null, null, 1, null, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'AC2: an anon join to the paused queue is rejected');
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_p'), null, 'Ann', null, null, 1, null, gen_random_uuid()) $$),
  'paused', 'AC2: the DETAIL says paused');
select tests.act_as('staff');
select throws_ok($$ select api.staff_add_visit(tests.id('queue_p'), null, 'Sam', null, 1, gen_random_uuid()) $$,
  'P0001', 'queue_not_accepting', 'staff adds are rejected by a paused queue too');
select tests.as_postgres();
select results_eq($$ select id, status::text from app.visits where queue_id = tests.id('queue_p') order by sort_key $$,
  $$ values (tests.id('p1'), 'waiting'), (tests.id('p2'), 'waiting') $$,
  'AC2: existing waiting visits remain, in order');

------------------------------------------------------------------------------------------------
-- Reopening and closing; roles
------------------------------------------------------------------------------------------------
select tests.act_as('manager');
select is((api.set_queue_state(tests.id('queue_p'), 'open')).accepting, true, 'a manager reopens the queue');
select tests.as_anon();
select lives_ok($$ select api.join_queue(tests.id('queue_p'), null, 'Ann', null, null, 1, null, gen_random_uuid()) $$,
  'an anon join to the reopened queue succeeds');
select tests.act_as('owner');
select is((api.set_queue_state(tests.id('queue_p'), 'closed')).not_accepting_reason, 'closed',
  'an owner closes the queue');
select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_p') and status = 'waiting'), 3,
  'closing keeps waiting guests too');

select tests.act_as('staff');
select throws_ok($$ select api.set_queue_state(tests.id('queue_p'), null) $$,
  'P0001', 'invalid_input', 'a null state is invalid_input');
select tests.act_as('other_owner');
select throws_ok($$ select api.set_queue_state(tests.id('queue_p'), 'open') $$,
  'P0001', 'not_found', 'cross-tenant: another org''s owner cannot change the queue');
select tests.act_as('staff_a2');
select throws_ok($$ select api.set_queue_state(tests.id('queue_p'), 'open') $$,
  'P0001', 'not_found', 'staff of another location cannot change the queue');
select tests.act_as('staff');
select throws_ok($$ select api.set_queue_state(tests.id('queue_b'), 'paused') $$,
  'P0001', 'not_found', 'cross-tenant: staff cannot pause another org''s queue');
select tests.as_anon();
select throws_ok($$ select api.set_queue_state(tests.id('queue_p'), 'open') $$,
  '42501', null, 'anon cannot call set_queue_state');
select tests.as_postgres();
select is((select manual_state::text from app.queues where id = tests.id('queue_p')), 'closed',
  'none of the denied calls changed the queue');

select * from finish();
rollback;
