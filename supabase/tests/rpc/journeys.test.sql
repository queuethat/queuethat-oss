-- 2B-Q8 (#233): api.advance_journey. A step is a transfer to the next queue (ADR 0011).
begin;
\ir ../helpers/_setup.psql
select plan(17);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

-- registration (R) -> triage (T) -> doctor (D); another guest already waits in triage.
insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('q_reg'), tests.id('org_a'), tests.id('loc_a'), 'Registration', 'R'),
  (tests.new_id('q_tri'), tests.id('org_a'), tests.id('loc_a'), 'Triage', 'T'),
  (tests.new_id('q_doc'), tests.id('org_a'), tests.id('loc_a'), 'Doctor', 'D'),
  (tests.new_id('q_org_b'), tests.id('org_b'), tests.id('loc_b'), 'B queue', 'B');
insert into app.services (id, org_id, location_id, queue_id, name) values
  (tests.new_id('s_reg'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_reg'), 'Register'),
  (tests.new_id('s_tri'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_tri'), 'Triage'),
  (tests.new_id('s_doc'), tests.id('org_a'), tests.id('loc_a'), tests.id('q_doc'), 'Consult');
insert into app.journeys (id, org_id, location_id, name)
values (tests.new_id('j1'), tests.id('org_a'), tests.id('loc_a'), 'Clinic visit');
insert into app.journey_steps (journey_id, org_id, step_no, queue_id, service_id) values
  (tests.id('j1'), tests.id('org_a'), 1, tests.id('q_reg'), tests.id('s_reg')),
  (tests.id('j1'), tests.id('org_a'), 2, tests.id('q_tri'), tests.id('s_tri')),
  (tests.id('j1'), tests.id('org_a'), 3, tests.id('q_doc'), tests.id('s_doc'));
update app.services set journey_id = tests.id('j1') where id = tests.id('s_reg');

select tests.new_visit('wait1', 'q_tri', 'Already waiting');
select tests.new_visit('p1', 'q_reg', 'Pat');
select tests.new_visit('p2', 'q_reg', 'Waiting Wes');
update app.visits set service_id = tests.id('s_reg') where id in (tests.id('p1'), tests.id('p2'));
create function tests.ver(p text) returns int language sql as $$ select version from app.visits where id = tests.id(p) $$;
create function tests.ev(p text, p_type text) returns int language sql as $$
  select count(*)::int from app.visit_events where visit_id = tests.id(p) and type = p_type
$$;
grant execute on function tests.ver(text), tests.ev(text, text) to authenticated;
grant select on all tables in schema tests to authenticated;
create table tests.rows (name text primary key, r api.visit_row);
grant select, insert on tests.rows to authenticated;

select tests.act_as('staff');
select api.transition_visit(tests.id('p1'), 'call', tests.ver('p1'), gen_random_uuid());
select api.transition_visit(tests.id('p1'), 'start', tests.ver('p1'), gen_random_uuid());

-- Not serving yet: nothing to advance.
select throws_ok(format($$select api.advance_journey(%L, %s, gen_random_uuid())$$, tests.id('p2'), tests.ver('p2')),
  'P0001', 'illegal_transition', 'a waiting visit cannot advance');

-- AC1: step 1 -> 2
insert into tests.rows select 'a1', api.advance_journey(tests.id('p1'), tests.ver('p1'), gen_random_uuid());
select is((select (r).status from tests.rows where name = 'a1'), 'waiting'::api.visit_state, 'AC1: the visit is waiting after advancing');
select is((select (r).queue_id from tests.rows where name = 'a1'), tests.id('q_tri'), 'AC1: in step 2''s queue');
select is((select (r).service_id from tests.rows where name = 'a1'), tests.id('s_tri'), 'AC1: with step 2''s service');
select is((select string_agg(v.guest_name, ',' order by v.sort_key) from app.visits v
           where v.queue_id = tests.id('q_tri') and v.status = 'waiting'),
  'Already waiting,Pat', 'AC1: filed at the end of the target queue');
select is(tests.ev('p1', 'transferred'), 1, 'AC1: one transferred event');
select is((select e.payload ->> 'from_step' || '>' || (e.payload ->> 'to_step') from app.visit_events e
           where e.visit_id = tests.id('p1') and e.type = 'transferred'), '1>2', 'the event records from_step and to_step');
select is((select (e.payload ->> 'journey_id')::uuid from app.visit_events e
           where e.visit_id = tests.id('p1') and e.type = 'transferred'), tests.id('j1'), 'the event records the journey');

-- AC3: undo within 10 minutes returns the visit to serving in step 1
select is((api.undo_event((select (r).last_event_id from tests.rows where name = 'a1'), gen_random_uuid())).status,
  'serving'::api.visit_state, 'AC3: undo returns the visit to serving');
select is((select queue_id from app.visits where id = tests.id('p1')), tests.id('q_reg'), 'AC3: in the previous queue');

-- Advance again through both remaining steps
insert into tests.rows select 'a2', api.advance_journey(tests.id('p1'), tests.ver('p1'), gen_random_uuid());
select is((select queue_id from app.visits where id = tests.id('p1')), tests.id('q_tri'), 'advancing again reaches step 2');
select api.transition_visit(tests.id('p1'), 'call', tests.ver('p1'), gen_random_uuid());
select api.transition_visit(tests.id('p1'), 'start', tests.ver('p1'), gen_random_uuid());
select is((api.advance_journey(tests.id('p1'), tests.ver('p1'), gen_random_uuid())).queue_id, tests.id('q_doc'), 'step 3 is the doctor');
select api.transition_visit(tests.id('p1'), 'call', tests.ver('p1'), gen_random_uuid());
select api.transition_visit(tests.id('p1'), 'start', tests.ver('p1'), gen_random_uuid());

-- Staff view: no next step on the last one
select is((select journey_next_queue_id from app.staff_visits where id = tests.id('p1')), null, 'no next queue on the last step');
-- AC2: the last step completes
select is((api.advance_journey(tests.id('p1'), tests.ver('p1'), gen_random_uuid())).status, 'served'::api.visit_state, 'AC2: the last step serves the visit');

-- Stale version
select throws_ok(format($$select api.advance_journey(%L, 0, gen_random_uuid())$$, tests.id('p2')), 'P0001', 'stale_visit', 'a stale version is refused');

-- AC5: staff of org B cannot advance an org A visit
select tests.act_as('other_owner');
select throws_ok(format($$select api.advance_journey(%L, 1, gen_random_uuid())$$, tests.id('p1')), 'P0001', 'not_found', 'AC5: org B staff get not_found');
select is((select count(*) from app.journey_steps where journey_id = tests.id('j1'))::int, 0, 'org B sees no org A journey steps');

select * from finish();
rollback;
