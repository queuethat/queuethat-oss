-- 2A-CHK1 (#149): check-in of expected visits, for staff (transition_visit) and guests (guest_act).
begin;
\ir ../helpers/_setup.psql
select plan(29);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_i'), tests.id('org_a'), tests.id('loc_a'), 'Check in', 'I');
select tests.new_visit('wa', 'queue_i', 'Walk A');
select tests.new_visit('wb', 'queue_i', 'Walk B');
-- A joined before the appointment's time, B (artificially) after it.
update app.visits set joined_at = now() - interval '5 minutes' where id = tests.id('wa');
update app.visits set joined_at = now() + interval '20 minutes' where id = tests.id('wb');
select tests.make_expected_visit('e1', 'queue_i', now() + interval '10 minutes', 'Eve');
select tests.make_expected_visit('e_late', 'queue_i', now() - interval '50 minutes', 'Lena');
select tests.make_expected_visit('e_far', 'queue_i', now() + interval '2 hours', 'Fay');
select tests.make_expected_visit('e_guest', 'queue_i', now() + interval '20 minutes', 'Gus');
select tests.make_expected_visit('e_edge', 'queue_i', now() + interval '31 minutes', 'Edie');

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
create function tests.line() returns text language sql as $$
  select string_agg(n.k, ',' order by v.sort_key, v.id)
  from app.visits v
  join (values ('wa'), ('wb'), ('e1'), ('e_late'), ('e_far'), ('e_guest'), ('e_edge')) as n(k) on tests.id(n.k) = v.id
  where v.queue_id = tests.id('queue_i') and v.status = 'waiting'
$$;
grant execute on function tests.ver(text), tests.line() to authenticated, anon;
create table tests.rows (name text primary key, r api.visit_row);
grant select, insert on tests.rows to authenticated;

------------------------------------------------------------------------------------------------
-- AC4: an expected visit is invisible to the line
------------------------------------------------------------------------------------------------
select tests.as_postgres();
select is(tests.line(), 'wa,wb', 'only the walk-ins are in the line');
select is((select (private.visit_row(tests.id('e1'))).position), null, 'AC4: an expected visit has no position');
select tests.act_as('staff');
select is((select (r).id from (select api.call_next(tests.id('queue_i'), null, gen_random_uuid()) as r) x), tests.id('wa'), 'AC4: call_next never returns it');
select is((select (r).id from (select api.call_next(tests.id('queue_i'), null, gen_random_uuid()) as r) x), tests.id('wb'), 'even when it would be next by schedule');
select is((select (r) from (select api.call_next(tests.id('queue_i'), null, gen_random_uuid()) as r) x), null, 'and with nobody waiting it returns null');
select is((api.today_stats(tests.id('loc_a'))).waiting_now, 1, 'AC4: today_stats counts no expected visit as waiting (only the fixture visit_a waits)');
select tests.as_postgres();
-- put the two walk-ins back to waiting for the placement tests
select tests.act_as('staff');
select api.transition_visit(tests.id('wa'), 'requeue', tests.ver('wa'), gen_random_uuid());
select api.transition_visit(tests.id('wb'), 'requeue', tests.ver('wb'), gen_random_uuid());
select tests.as_postgres();
select is((select count(*)::int from app.visits where queue_id = tests.id('queue_i') and status = 'waiting'), 2, 'the queue holds two waiting visits');
select tests.act_as('staff');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- AC1: on time, filed by schedule
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows select 'e1', api.transition_visit(tests.id('e1'), 'check_in', tests.ver('e1'), gen_random_uuid());
select tests.as_postgres();
select is(tests.line(), 'wa,e1,wb', 'AC1: checked in at 14:20 for 14:30, it waits behind earlier walk-ins and ahead of later ones');
select is((select (r).status::text from tests.rows where name = 'e1'), 'waiting', 'the visit is waiting');
select is((select payload ->> 'late' from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'e1')), null, 'and the event is not marked late');

------------------------------------------------------------------------------------------------
-- AC2: late goes to the end
------------------------------------------------------------------------------------------------
select tests.act_as('staff');
insert into tests.rows select 'late', api.transition_visit(tests.id('e_late'), 'check_in', tests.ver('e_late'), gen_random_uuid());
select tests.as_postgres();
select is(tests.line(), 'wa,e1,wb,e_late', 'AC2: 50 minutes late with a 10-minute tolerance: the end of the line');
select is((select (payload ->> 'late')::boolean from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'late')), true,
  'AC2: late = true in the event');

-- within tolerance is not late
select private.set_actor('system', null);
update app.visits set scheduled_at = now() - interval '5 minutes' where id = tests.id('e_far');
select tests.act_as('staff');
insert into tests.rows select 'tol', api.transition_visit(tests.id('e_far'), 'check_in', tests.ver('e_far'), gen_random_uuid());
select tests.as_postgres();
select is((select payload ->> 'late' from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'tol')), null, '5 minutes late is within the tolerance');

-- undo puts it back to expected
select tests.act_as('staff');
select api.undo_event((select (r).last_event_id from tests.rows where name = 'tol'), gen_random_uuid());
select tests.as_postgres();
select is((select status::text from app.visits where id = tests.id('e_far')), 'expected', 'undoing a check-in returns the visit to expected');

-- the other transitions are not available to expected visits except cancel and no_show
select tests.act_as('staff');
select throws_ok(format($$ select api.transition_visit(%L, 'call', %s, gen_random_uuid()) $$, tests.id('e_far'), tests.ver('e_far')),
  'P0001', 'illegal_transition', 'an expected visit cannot be called');
select tests.as_postgres();

------------------------------------------------------------------------------------------------
-- guests
------------------------------------------------------------------------------------------------
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set scheduled_at = now() + interval '2 hours' where id = tests.id('e_far');
select tests.as_anon();
select throws_ok($$ select api.guest_act('e_far-token', 'check_in', gen_random_uuid()) $$, 'P0001', 'check_in_not_allowed',
  'AC3: checking in 2 hours early raises check_in_not_allowed');
select throws_ok($$ select api.guest_act('e_edge-token', 'check_in', gen_random_uuid()) $$, 'P0001', 'check_in_not_allowed',
  'and 31 minutes early');
select is((select (api.guest_act('e_guest-token', 'check_in', gen_random_uuid())).status::text), 'waiting', 'inside the 30-minute window a guest checks in');
select is((select (api.guest_act('e_guest-token', 'check_in', gen_random_uuid())).status::text), 'waiting', 'checking in again is a no-op');
select tests.as_postgres();
select is((select count(*)::int from app.visit_events where visit_id = tests.id('e_guest') and type = 'check_in'), 1, 'and writes one event');
select is((select actor_kind::text from app.visit_events where visit_id = tests.id('e_guest') and type = 'check_in'), 'guest', 'by the guest actor');
select is(tests.line(), 'wa,e1,wb,e_late,e_guest', 'the guest is filed the same way: behind everyone not scheduled later, so behind the late arrival at the end');
select tests.as_anon();
select throws_ok($$ select api.guest_act('nobody', 'check_in', gen_random_uuid()) $$, 'P0001', 'not_found', 'an unknown token is not_found');

------------------------------------------------------------------------------------------------
-- a guest check-in with no gap renumbers the line, attributed to the guest
------------------------------------------------------------------------------------------------
select tests.as_postgres();
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_r'), tests.id('org_a'), tests.id('loc_a'), 'Tight', 'R');
select tests.new_visit('wr1', 'queue_r', 'Rae');
select tests.new_visit('wr2', 'queue_r', 'Rui');
select tests.make_expected_visit('er', 'queue_r', now() + interval '5 minutes', 'Ren');
select private.set_actor('system', null);
update app.visits set sort_key = 100, joined_at = now() - interval '5 minutes' where id = tests.id('wr1');
update app.visits set sort_key = 101, joined_at = now() + interval '30 minutes' where id = tests.id('wr2');
select tests.as_anon();
select is((select (api.guest_act('er-token', 'check_in', gen_random_uuid())).status::text), 'waiting', 'a guest checks in between two visits with adjacent sort keys');
select tests.as_postgres();
select is((select string_agg(v.guest_name, ',' order by v.sort_key, v.id) from app.visits v where v.queue_id = tests.id('queue_r') and v.status = 'waiting'),
  'Rae,Ren,Rui', 'it lands between them');
select is((select array_agg(distinct (e.actor_kind::text || ':' || coalesce(e.actor_id::text, 'null'))) from app.visit_events e
           where e.type = 'renumbered' and e.visit_id in (tests.id('wr1'), tests.id('wr2'))),
  array['guest:null'], 'the renumbering events of the other visits name the guest as the actor');

------------------------------------------------------------------------------------------------
-- AC5 and the columns
------------------------------------------------------------------------------------------------
select tests.act_as('other_owner');
select throws_ok(format($$ select api.transition_visit(%L, 'check_in', 0, gen_random_uuid()) $$, tests.id('e_far')), 'P0001', 'not_found',
  'AC5: staff of org B get not_found');
select tests.as_postgres();
select is((select late_tolerance_minutes from app.queues where id = tests.id('queue_i')), 10, 'late_tolerance_minutes defaults to 10');
select throws_ok($$ update app.queues set late_tolerance_minutes = 500 where id = tests.id('queue_i') $$, '23514', null, 'and is bounded');

select * from finish();
rollback;
