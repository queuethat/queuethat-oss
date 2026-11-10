-- V3 (#32): api.undo_event.
begin;
\ir ../helpers/_setup.psql
select plan(36);
select tests.create_world();

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_u'), tests.id('org_a'), tests.id('loc_a'), 'Undo', 'U');
select tests.new_visit('u1', 'queue_u', 'Uma');
select tests.new_visit('u2', 'queue_u', 'Ugo');
select tests.new_visit('u3', 'queue_u', 'Una');
insert into app.counters (id, org_id, location_id, label)
values (tests.new_id('counter_a2'), tests.id('org_a'), tests.id('loc_a'), 'Chair 2');
select tests.new_id('k_undo');
create table tests.rows (name text primary key, r api.visit_row);

-- Applies a staff action at the visit's current version; returns the event it wrote.
create function tests.act(p_visit text, p_action api.visit_action, p_counter text default null)
returns bigint language sql as $$
  select (api.transition_visit(tests.id(p_visit), p_action,
          (select version from app.visits where id = tests.id(p_visit)), gen_random_uuid(),
          tests.id(p_counter), case when p_action = 'remove' then 'Mis-tap' end)).last_event_id
$$;
-- Undoes the visit's latest event with a fresh key.
create function tests.undo_last(p_visit text) returns api.visit_row language sql as $$
  select api.undo_event((select max(id) from app.visit_events where visit_id = tests.id(p_visit)),
                        gen_random_uuid())
$$;
-- Moves an event back in time; visit_events is append-only, so its triggers are bypassed.
create function tests.age_event(p_event_id bigint, p_age interval) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update app.visit_events set occurred_at = now() - p_age where id = p_event_id;
  set local session_replication_role = origin;
end $$;
grant select on all tables in schema tests to anon, authenticated;
grant insert on tests.rows to authenticated;
grant execute on function tests.act(text, api.visit_action, text), tests.undo_last(text) to authenticated;

------------------------------------------------------------------------------------------------
-- AC1: a guest called by mistake is waiting at the original position again
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows values ('call', api.call_next(tests.id('queue_u'), tests.id('counter_a'), gen_random_uuid()));
insert into tests.rows select 'undo', api.undo_event((r).last_event_id, tests.id('k_undo')) from tests.rows where name = 'call';
insert into tests.rows select 'undo_again', api.undo_event((r).last_event_id, tests.id('k_undo')) from tests.rows where name = 'call';
select tests.as_postgres();

select results_eq($$ select (r).id, (r).status::text, (r).position, (r).counter_id, (r).call_count,
                            (r).called_at, (r).version from tests.rows where name = 'undo' $$,
  $$ values (tests.id('u1'), 'waiting', 1, null::uuid, 0, null::timestamptz, 2) $$,
  'AC1: undoing a mistaken call puts the guest back to waiting at position 1, no counter, call_count 0');
select is((select (r).sort_key from tests.rows where name = 'undo'),
  (select (r).sort_key from tests.rows where name = 'call'), 'AC1: the sort_key is the original one');
select results_eq($$ select type, from_status::text, to_status::text, actor_id from app.visit_events
                     where visit_id = tests.id('u1') and type <> 'joined' order by id $$,
  $$ values ('call', 'waiting', 'called', tests.id('staff')), ('undo', 'called', 'waiting', tests.id('staff')) $$,
  'AC1: two events exist, the call and the compensating undo');
select is((select undone_by_event_id from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'call')),
  (select (r).last_event_id from tests.rows where name = 'undo'), 'the call event is marked undone_by_event_id');
select is((select payload from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'undo')),
  jsonb_build_object('undoes_event_id', (select (r).last_event_id from tests.rows where name = 'call'), 'undoes_type', 'call'),
  'the undo event names the event it undoes');
select is((select to_jsonb(r) from tests.rows where name = 'undo_again'), (select to_jsonb(r) from tests.rows where name = 'undo'),
  'repeating an undo key returns the first result');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('u1')), 3, 'the replay wrote no event');
select is((select version from app.queues where id = tests.id('queue_u')), 2::bigint, 'call and undo each bumped the queue version');

select tests.act_as('staff');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$, (select (r).last_event_id from tests.rows where name = 'call')),
  'P0001', 'undo_not_allowed', 'an event cannot be undone twice');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$, (select (r).last_event_id from tests.rows where name = 'undo')),
  'P0001', 'undo_not_allowed', 'an undo cannot itself be undone');

------------------------------------------------------------------------------------------------
-- AC2: a later action blocks undoing the earlier one
------------------------------------------------------------------------------------------------
insert into tests.rows values ('call2', api.call_next(tests.id('queue_u'), tests.id('counter_a'), gen_random_uuid()));
select tests.act('u1', 'recall', 'counter_a2');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$, (select (r).last_event_id from tests.rows where name = 'call2')),
  'P0001', 'undo_not_allowed', 'AC2: the call cannot be undone after a recall');
select results_eq($$ select status::text, call_count, version from app.visits where id = tests.id('u1') $$,
  $$ values ('called', 2, 4) $$, 'AC2: the rejected undo changed nothing');

------------------------------------------------------------------------------------------------
-- Every reversible action (u1 is called at Chair 2 after a recall)
------------------------------------------------------------------------------------------------
select results_eq($$ select (r).status::text, (r).call_count, (r).counter_label from tests.undo_last('u1') r $$,
  $$ values ('called', 1, 'Chair 1') $$, 'undo recall: one call fewer, back at the previous counter');
select tests.act('u1', 'requeue');
select results_eq($$ select (r).status::text, (r).counter_label, (r).position from tests.undo_last('u1') r $$,
  $$ values ('called', 'Chair 1', null::int) $$, 'undo requeue: called again at the same counter');
select tests.act('u1', 'start');
select results_eq($$ select (r).status::text, (r).serving_at from tests.undo_last('u1') r $$,
  $$ values ('called', null::timestamptz) $$, 'undo start: called, serving_at cleared');
select tests.as_postgres();
select is((select assigned_staff_id from app.visits where id = tests.id('u1')), null, 'undo start: no assigned staff');
select tests.act_as('staff');
select tests.act('u1', 'start');
select tests.act('u1', 'complete');
select results_eq($$ select (r).status::text, (r).finished_at, (r).serving_at is not null from tests.undo_last('u1') r $$,
  $$ values ('serving', null::timestamptz, true) $$, 'undo complete: serving again, unfinished');

select tests.act('u2', 'call', 'counter_a');
select tests.act('u2', 'no_show');
select results_eq($$ select (r).status::text, (r).finished_at, (r).counter_label from tests.undo_last('u2') r $$,
  $$ values ('called', null::timestamptz, 'Chair 1') $$, 'undo no_show from called: called at the same counter');
select tests.act('u2', 'remove');
select results_eq($$ select (r).status::text, (r).finished_at from tests.undo_last('u2') r $$,
  $$ values ('called', null::timestamptz) $$, 'undo remove: called again, unfinished');
select tests.act('u2', 'cancel');
select is((tests.undo_last('u2')).status::text, 'called', 'undo cancel: called again');
select tests.act('u3', 'no_show');
select tests.as_postgres();
select tests.age_event((select max(id) from app.visit_events where visit_id = tests.id('u3')), '1 hour');
select tests.act_as('staff');
select tests.act('u3', 'reinstate');
select results_eq($$ select (r).status::text, (r).finished_at, (r).position from tests.undo_last('u3') r $$,
  $$ values ('no_show', now() - interval '1 hour', null::int) $$,
  'undo reinstate: no_show again with the original finished_at');
select throws_ok($$ select tests.undo_last('u3') $$, 'P0001', 'undo_not_allowed',
  'once the reinstate is undone, the hour-old no_show is the latest event and too old to undo');
select tests.act('u3', 'reinstate');

-- A second call undone restores the first call's called_at.
select tests.act('u3', 'call', 'counter_a');
select tests.act('u3', 'requeue');
select tests.as_postgres();
select tests.age_event((select max(id) from app.visit_events where visit_id = tests.id('u3') and type = 'call'), '5 minutes');
select tests.act_as('staff');
select tests.act('u3', 'call', 'counter_a');
select results_eq($$ select (r).status::text, (r).called_at, (r).call_count from tests.undo_last('u3') r $$,
  $$ values ('waiting', now() - interval '5 minutes', 1) $$,
  'undo of a second call: waiting, the first call''s called_at and call_count kept');

select tests.as_postgres();
select private.set_actor('system', null);
insert into app.visits (id, org_id, location_id, queue_id, service_day, ticket_prefix, ticket_number,
                        display_ticket, status, sort_key, guest_token_hash, source, idempotency_key)
select tests.new_id('u4'), org_id, location_id, id, private.service_day(location_id), 'U', 99, 'U099',
       'expected', 99 * 1024, extensions.digest('u4', 'sha256'), 'appointment', gen_random_uuid()
from app.queues where id = tests.id('queue_u');
select tests.act_as('staff');
select tests.act('u4', 'check_in');
select is((tests.undo_last('u4')).status::text, 'expected', 'undo check_in: expected again');

------------------------------------------------------------------------------------------------
-- What cannot be undone
------------------------------------------------------------------------------------------------
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$,
                        (select max(id) from app.visit_events where visit_id = tests.id('u4'))),
  'P0001', 'undo_not_allowed', 'a joined event cannot be undone');
select tests.as_postgres();
select tests.new_visit('u5', 'queue_u');
select private.set_actor('guest', null, 'cancel');
update app.visits set status = 'cancelled', finished_at = now() where id = tests.id('u5');
select tests.act_as('staff');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$,
                        (select max(id) from app.visit_events where visit_id = tests.id('u5'))),
  'P0001', 'undo_not_allowed', 'a guest''s own cancel is not a staff action to undo');

select tests.act('u2', 'no_show');
select tests.as_postgres();
select tests.age_event((select max(id) from app.visit_events where visit_id = tests.id('u2')), '10 minutes 1 second');
select tests.act_as('staff');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$,
                        (select max(id) from app.visit_events where visit_id = tests.id('u2'))),
  'P0001', 'undo_not_allowed', 'an event older than 10 minutes cannot be undone');
select tests.as_postgres();
select tests.age_event((select max(id) from app.visit_events where visit_id = tests.id('u2')), '9 minutes 59 seconds');
select tests.act_as('manager');
select is((tests.undo_last('u2')).status::text, 'called', 'within 10 minutes a manager can undo a staff member''s action');
select throws_ok($$ select api.undo_event(1, null) $$, 'P0001', 'not_found', 'an event outside the caller''s locations is not_found before input checks');
select tests.act_as('staff');
select throws_ok(format($$ select api.undo_event(%s, null) $$, (select max(id) from app.visit_events where visit_id = tests.id('u2'))),
  'P0001', 'invalid_input', 'undo needs an idempotency key');

------------------------------------------------------------------------------------------------
-- Cross-tenant, other locations, devices, anon
------------------------------------------------------------------------------------------------
select tests.act('u2', 'requeue');
select tests.as_postgres();
insert into app.locations (id, org_id, name, slug, tz)
values (tests.new_id('loc_a2'), tests.id('org_a'), 'Location A2', 'test-location-a2', 'America/New_York');
insert into app.memberships (org_id, user_id, role, location_ids)
values (tests.id('org_a'), tests.create_user('staff_a2'), 'staff', array[tests.id('loc_a2')]);
insert into tests.actors values ('staff_a2', 'authenticated',
  jsonb_build_object('sub', tests.id('staff_a2'), 'role', 'authenticated', 'aud', 'authenticated'));
create table tests.last as select max(id) as id from app.visit_events where visit_id = tests.id('u2');
grant select on tests.last to anon, authenticated;
select tests.act_as('other_owner');
select throws_ok($$ select api.undo_event((select id from tests.last), gen_random_uuid()) $$,
  'P0001', 'not_found', 'org B staff undoing an org A event get not_found');
select throws_ok($$ select api.undo_event(-1, gen_random_uuid()) $$,
  'P0001', 'not_found', 'the same error as for an event that does not exist');
select tests.act_as('staff_a2');
select throws_ok($$ select api.undo_event((select id from tests.last), gen_random_uuid()) $$,
  'P0001', 'not_found', 'staff limited to another location get not_found');
select tests.act_as('display');
select throws_ok($$ select api.undo_event((select id from tests.last), gen_random_uuid()) $$,
  'P0001', 'not_found', 'a paired display cannot undo');
select tests.as_anon();
select throws_ok($$ select api.undo_event((select id from tests.last), gen_random_uuid()) $$,
  '42501', null, 'anon cannot execute undo_event');
select tests.as_postgres();
select results_eq($$ select status::text, undone_by_event_id from app.visits v
                     join app.visit_events e on e.id = (select id from tests.last) where v.id = tests.id('u2') $$,
  $$ values ('waiting', null::bigint) $$, 'none of the denied undos changed anything');

select * from finish();
rollback;
