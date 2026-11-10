-- 2A-ST1 (#134): api.move_visit, api.transfer_visit and their undo.
begin;
\ir ../helpers/_setup.psql
select plan(45);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('queue_m'), tests.id('org_a'), tests.id('loc_a'), 'Move', 'M'),
  (tests.new_id('queue_n'), tests.id('org_a'), tests.id('loc_a'), 'Other', 'N'),
  (tests.new_id('queue_p'), tests.id('org_a'), tests.id('loc_a'), 'Same prefix', 'M');
insert into app.services (id, org_id, location_id, queue_id, name) values
  (tests.new_id('svc_m1'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_m'), 'Cut'),
  (tests.new_id('svc_m2'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_m'), 'Colour'),
  (tests.new_id('svc_n1'), tests.id('org_a'), tests.id('loc_a'), tests.id('queue_n'), 'Beard');
select tests.new_visit('m1', 'queue_m', 'One');
select tests.new_visit('m2', 'queue_m', 'Two');
select tests.new_visit('m3', 'queue_m', 'Three');
select tests.new_visit('m4', 'queue_m', 'Four');
select tests.new_visit('m5', 'queue_m', 'Five');

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
-- The waiting line of a queue as visit names in order.
create function tests.line(p_queue text) returns text language sql as $$
  select string_agg(coalesce(n.k, '?'), ',' order by v.sort_key, v.id)
  from app.visits v
  left join (values ('m1'), ('m2'), ('m3'), ('m4'), ('m5'), ('n1'), ('n2'), ('p1')) as n(k)
    on tests.id(n.k) = v.id
  where v.queue_id = tests.id(p_queue) and v.status = 'waiting'
$$;
create function tests.mv(p_visit text, p_after text) returns api.visit_row language sql as $$
  select api.move_visit(tests.id(p_visit), tests.id(p_after), tests.ver(p_visit), gen_random_uuid())
$$;
grant execute on function tests.ver(text), tests.line(text), tests.mv(text, text) to authenticated;
grant select on all tables in schema tests to authenticated;
create table tests.rows (name text primary key, r api.visit_row);
grant select, insert on tests.rows to authenticated;

------------------------------------------------------------------------------------------------
-- AC1: the 5th moves after the 1st
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows values ('m5_after_m1', tests.mv('m5', 'm1'));
select tests.as_postgres();
select is(tests.line('queue_m'), 'm1,m5,m2,m3,m4', 'AC1: positions are 1,5,2,3,4');
select is((select (r).position from tests.rows where name = 'm5_after_m1'), 2, 'the row reports position 2');
select is((select count(*)::int - count(distinct sort_key)::int from app.visits where queue_id = tests.id('queue_m')), 0,
  'AC1: no sort_key duplicates');
select results_eq($$ select type, from_status::text, to_status::text, actor_id,
                           payload ->> 'from_after_visit_id', payload ->> 'to_after_visit_id'
                    from app.visit_events where visit_id = tests.id('m5') and type <> 'joined' $$,
  $$ values ('moved', 'waiting', 'waiting', tests.id('staff'), tests.id('m4')::text, tests.id('m1')::text) $$,
  'one moved event with the staff actor and the old and new neighbours');

-- to the front, and a no-op
select tests.act_as('staff');
insert into tests.rows values ('m3_front', tests.mv('m3', null));
insert into tests.rows values ('m3_front_again', tests.mv('m3', null));
select tests.as_postgres();
select is(tests.line('queue_m'), 'm3,m1,m5,m2,m4', 'null moves the visit to the front');
select is((select (r).last_event_id from tests.rows where name = 'm3_front_again'), null::bigint,
  'moving to where it already is is a no-op without an event');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('m3') and type = 'moved'), 1, 'and writes no second event');

-- idempotent per key
select tests.act_as('staff');
create temp table k as select gen_random_uuid() as key;
grant select on k to authenticated;
insert into tests.rows select 'm4_first', api.move_visit(tests.id('m4'), tests.id('m3'), tests.ver('m4'), (select key from k));
insert into tests.rows select 'm4_replay', api.move_visit(tests.id('m4'), tests.id('m3'), 0, (select key from k));
select tests.as_postgres();
select is((select to_jsonb(r) from tests.rows where name = 'm4_replay'), (select to_jsonb(r) from tests.rows where name = 'm4_first'),
  'repeating a key returns the first result');
select is(tests.line('queue_m'), 'm3,m4,m1,m5,m2', 'and moved once');

------------------------------------------------------------------------------------------------
-- AC2: no gap between neighbours renumbers in the same transaction
------------------------------------------------------------------------------------------------
update app.visits set sort_key = case id when tests.id('m3') then 100 when tests.id('m4') then 101
  when tests.id('m1') then 102 when tests.id('m5') then 103 else 104 end where queue_id = tests.id('queue_m');
select tests.act_as('staff');
insert into tests.rows values ('m2_squeeze', tests.mv('m2', 'm3'));
select tests.as_postgres();
select is(tests.line('queue_m'), 'm3,m2,m4,m1,m5', 'AC2: the visit lands right after its new predecessor');
select is((select array_agg(sort_key order by sort_key, id) from app.visits where queue_id = tests.id('queue_m') and status = 'waiting'),
  array[1024, 2048, 3072, 4096, 5120]::bigint[], 'AC2: the queue was renumbered with even spacing');
select is((select (payload ->> 'renumbered')::boolean from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'm2_squeeze')),
  true, 'the moved event says it renumbered');
select is((select count(*)::int from app.visit_events where type = 'renumbered' and payload ->> 'caused_by_visit_id' = tests.id('m2')::text), 4,
  'every renumbered neighbour has an event (I-1)');
select is((select count(*)::int from app.visit_events e where e.visit_id = tests.id('m2') and e.type = 'moved'), 2, 'the moved visit has its own event');

-- undo of a move that renumbered puts it behind its old predecessor again
select tests.act_as('staff');
insert into tests.rows select 'm2_undo', api.undo_event((r).last_event_id, gen_random_uuid()) from tests.rows where name = 'm2_squeeze';
select tests.as_postgres();
select is(tests.line('queue_m'), 'm3,m4,m1,m5,m2', 'undo after a renumber re-files the visit behind its old predecessor');

-- undo of a plain move restores the exact key
select tests.act_as('staff');
insert into tests.rows values ('m5_up', tests.mv('m5', null));
select tests.as_postgres();
select is(tests.line('queue_m'), 'm5,m3,m4,m1,m2', 'moved to the front');
select tests.act_as('staff');
insert into tests.rows select 'm5_down', api.undo_event((r).last_event_id, gen_random_uuid()) from tests.rows where name = 'm5_up';
select tests.as_postgres();
select is(tests.line('queue_m'), 'm3,m4,m1,m5,m2', 'undoing a plain move restores the place');

------------------------------------------------------------------------------------------------
-- errors
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
select throws_ok(format($$ select api.move_visit(%L, null, %s, gen_random_uuid()) $$, tests.id('m1'), tests.ver('m1') + 5),
  'P0001', 'stale_visit', 'a stale version raises stale_visit');
select throws_ok(format($$ select api.move_visit(%L, %L, %s, gen_random_uuid()) $$, tests.id('m1'), tests.id('m1'), tests.ver('m1')),
  'P0001', 'invalid_input', 'a visit cannot go after itself');
select throws_ok(format($$ select api.move_visit(%L, null, %s, null) $$, tests.id('m1'), tests.ver('m1')),
  'P0001', 'invalid_input', 'a key is required');
select api.call_next(tests.id('queue_m'), null, gen_random_uuid());
select tests.as_postgres();
select tests.act_as('staff');
select throws_ok(format($$ select api.move_visit(%L, null, %s, gen_random_uuid()) $$, tests.id('m3'), tests.ver('m3')),
  'P0001', 'illegal_transition', 'only waiting visits move');
select throws_ok(format($$ select api.move_visit(%L, %L, %s, gen_random_uuid()) $$, tests.id('m4'), tests.id('m3'), tests.ver('m4')),
  'P0001', 'stale_visit', 'moving behind a visit that was called meanwhile raises stale_visit');
select tests.as_postgres();
select tests.new_visit('n1', 'queue_n', 'Nina');
select tests.act_as('staff');
select throws_ok(format($$ select api.move_visit(%L, %L, %s, gen_random_uuid()) $$, tests.id('m4'), tests.id('n1'), tests.ver('m4')),
  'P0001', 'not_found', 'an after visit of another queue is not_found');

-- AC4 and devices
select tests.act_as('other_owner');
select throws_ok(format($$ select api.move_visit(%L, null, 0, gen_random_uuid()) $$, tests.id('m4')),
  'P0001', 'not_found', 'AC4: staff of org B get not_found for an org A visit (move)');
select throws_ok(format($$ select api.transfer_visit(%L, %L, null, 0, gen_random_uuid()) $$, tests.id('m4'), tests.id('queue_n')),
  'P0001', 'not_found', 'AC4: and for transfer');
select tests.as_anon();
select throws_ok(format($$ select api.move_visit(%L, null, 0, gen_random_uuid()) $$, tests.id('m4')),
  '42501', null, 'anon cannot move visits');

------------------------------------------------------------------------------------------------
-- transfer: different queue, prefix differs: ticket kept, filed by joined_at
------------------------------------------------------------------------------------------------
select tests.as_postgres();
select tests.new_visit('n2', 'queue_n', 'Nora');
-- n1 joined before m4, n2 after: m4 must land between them.
update app.visits set joined_at = case id when tests.id('n1') then now() - interval '30 minutes'
  when tests.id('m4') then now() - interval '20 minutes' else now() - interval '10 minutes' end
  where id in (tests.id('n1'), tests.id('n2'), tests.id('m4'));
create temp table before_transfer as
  select v.ticket_number, v.display_ticket, v.joined_at, v.sort_key,
         (select version from app.queues where id = v.queue_id) as qm,
         (select version from app.queues where id = tests.id('queue_n')) as qn
  from app.visits v where v.id = tests.id('m4');
select tests.act_as('staff');
insert into tests.rows select 'm4_to_n', api.transfer_visit(tests.id('m4'), tests.id('queue_n'), tests.id('svc_n1'), tests.ver('m4'), gen_random_uuid());
select tests.as_postgres();
select is(tests.line('queue_n'), 'n1,m4,n2', 'the visit is filed by joined_at among the target''s waiting visits');
select is((select (r).queue_id from tests.rows where name = 'm4_to_n'), tests.id('queue_n'), 'it is in the other queue');
select results_eq($$ select ticket_number, display_ticket, joined_at, status::text, service_id from app.visits where id = tests.id('m4') $$,
  $$ select ticket_number, display_ticket, joined_at, 'waiting', tests.id('svc_n1') from before_transfer $$,
  'ticket and joined_at are kept, it stays waiting, with the new service');
select is((select version from app.queues where id = tests.id('queue_m')) + (select version from app.queues where id = tests.id('queue_n')),
  (select qm + qn + 2 from before_transfer), 'both queues'' versions were bumped');
select is((select type from app.visit_events where visit_id = tests.id('m4') order by id desc limit 1), 'transferred', 'a transferred event was written');

-- AC3: undo restores queue, place and ticket
select tests.act_as('staff');
insert into tests.rows select 'm4_back', api.undo_event((r).last_event_id, gen_random_uuid()) from tests.rows where name = 'm4_to_n';
select tests.as_postgres();
select results_eq($$ select queue_id, service_id, sort_key, ticket_number, display_ticket from app.visits where id = tests.id('m4') $$,
  $$ select tests.id('queue_m'), null::uuid, sort_key, ticket_number, display_ticket from before_transfer $$,
  'AC3: undo puts the visit back in its original queue with its sort_key and ticket');
select is(tests.line('queue_m'), 'm4,m1,m5,m2', 'AC3: and at its original position (m3 was called, so m4 is first)');

------------------------------------------------------------------------------------------------
-- transfer: same prefix gets a fresh ticket; same queue changes service only; errors
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows values ('m1_to_p', api.transfer_visit(tests.id('m1'), tests.id('queue_p'), null, tests.ver('m1'), gen_random_uuid()));
select tests.as_postgres();
select is((select (r).display_ticket from tests.rows where name = 'm1_to_p'), 'M001', 'the same prefix gets the next ticket of the target queue');
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_p') and ticket_number = 1), 1, 'and the unique ticket rule holds');
select tests.act_as('staff');
insert into tests.rows select 'm1_back', api.undo_event((r).last_event_id, gen_random_uuid()) from tests.rows where name = 'm1_to_p';
select tests.as_postgres();
select is((select display_ticket from app.visits where id = tests.id('m1')), 'M001'::text, 'undo restores the original ticket');

select tests.act_as('staff');
insert into tests.rows values ('m2_svc', api.transfer_visit(tests.id('m2'), tests.id('queue_m'), tests.id('svc_m2'), tests.ver('m2'), gen_random_uuid()));
insert into tests.rows values ('m2_svc_again', api.transfer_visit(tests.id('m2'), tests.id('queue_m'), tests.id('svc_m2'), tests.ver('m2'), gen_random_uuid()));
select tests.as_postgres();
select is((select (r).service_id from tests.rows where name = 'm2_svc'), tests.id('svc_m2'), 'same queue, other service: the service changes');
select is((select sort_key from app.visits where id = tests.id('m2')), (select (r).sort_key from tests.rows where name = 'm2_svc'), 'and the place in line does not');
select is((select (r).last_event_id from tests.rows where name = 'm2_svc_again'), null::bigint, 'same queue and service is a no-op');

select tests.act_as('staff');
select throws_ok(format($$ select api.transfer_visit(%L, %L, %L, %s, gen_random_uuid()) $$, tests.id('m2'), tests.id('queue_n'), tests.id('svc_m1'), tests.ver('m2')),
  'P0001', 'not_found', 'a service of another queue is not_found');
select throws_ok(format($$ select api.transfer_visit(%L, %L, null, %s, gen_random_uuid()) $$, tests.id('m2'), gen_random_uuid(), tests.ver('m2')),
  'P0001', 'not_found', 'an unknown queue is not_found');
select throws_ok(format($$ select api.transfer_visit(%L, %L, null, %s, gen_random_uuid()) $$, tests.id('m2'), tests.id('queue_n'), tests.ver('m2') + 3),
  'P0001', 'stale_visit', 'a stale version raises stale_visit');
select throws_ok(format($$ select api.transfer_visit(%L, %L, null, %s, gen_random_uuid()) $$, tests.id('m3'), tests.id('queue_n'), tests.ver('m3')),
  'P0001', 'illegal_transition', 'a called visit does not transfer');
select tests.as_postgres();
update app.queues set manual_state = 'paused' where id = tests.id('queue_n');
select tests.act_as('staff');
select throws_ok(format($$ select api.transfer_visit(%L, %L, null, %s, gen_random_uuid()) $$, tests.id('m2'), tests.id('queue_n'), tests.ver('m2')),
  'P0001', 'queue_not_accepting', 'a paused target queue raises queue_not_accepting');
select tests.as_postgres();

-- the undo window and the latest-event rule apply
select tests.act_as('staff');
select throws_ok(format($$ select api.undo_event(%s, gen_random_uuid()) $$, (select (r).last_event_id from tests.rows where name = 'm4_to_n')),
  'P0001', 'undo_not_allowed', 'a transfer that was already undone cannot be undone again');

select * from finish();
rollback;
