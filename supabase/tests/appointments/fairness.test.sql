-- 2P-APT13 (#169): virtual-arrival ordering, the max walk-in delay guard and reserved ETA (ADR 0010).
begin;
\ir ../helpers/_setup.psql
select plan(12);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix) values
  (tests.new_id('qf'), tests.id('org_a'), tests.id('loc_a'), 'Fair', 'F'),
  (tests.new_id('qg'), tests.id('org_a'), tests.id('loc_a'), 'Guard', 'G'),
  (tests.new_id('qh'), tests.id('org_a'), tests.id('loc_a'), 'Eta', 'H'),
  (tests.new_id('qi'), tests.id('org_a'), tests.id('loc_a'), 'Snooze', 'S');
create function tests.ver(p_visit text) returns int language sql as $$ select version from app.visits where id = tests.id(p_visit) $$;
create function tests.line(p_queue text) returns text language sql as $$
  select string_agg(v.guest_name, ',' order by v.sort_key, v.id) from app.visits v
  where v.queue_id = tests.id(p_queue) and v.status = 'waiting' $$;
create function tests.check_in(p_visit text) returns void language plpgsql as $$
begin
  perform tests.act_as('staff');
  perform api.transition_visit(tests.id(p_visit), 'check_in', tests.ver(p_visit), gen_random_uuid());
  perform tests.as_postgres();
end $$;
grant execute on function tests.ver(text), tests.line(text), tests.check_in(text) to authenticated, anon;

-- A walk-in that joined 2 minutes ago waits in queue qf; every scenario files an appointment around it.
select tests.new_visit('walk', 'qf', 'Walk');
update app.visits set joined_at = now() - interval '2 minutes' where id = tests.id('walk');

-- 1. On time: scheduled in 3 minutes, so its virtual arrival is 7 minutes ago, before the walk-in.
select tests.make_expected_visit('on_time', 'qf', now() + interval '3 minutes', 'OnTime');
select tests.check_in('on_time');
select is(tests.line('qf'), 'OnTime,Walk', 'on time: ahead of a walk-in who joined after its virtual arrival');
select is((select (r).id from (select api.call_next(tests.id('qf'), null, gen_random_uuid()) as r) x where tests.act_as('staff') is not null), tests.id('on_time'),
  'on time: call_next calls the appointment first');
select tests.as_postgres();

-- 2. Early: scheduled in 30 minutes, it keeps its real arrival and waits behind the walk-in.
select tests.make_expected_visit('early', 'qf', now() + interval '30 minutes', 'Early');
select tests.check_in('early');
select is(tests.line('qf'), 'Walk,Early', 'early: behind the walk-in who was already there');

-- 3. Late within grace: 7 minutes late with 10 minutes of tolerance keeps its virtual arrival.
select tests.make_expected_visit('late_ok', 'qf', now() - interval '7 minutes', 'LateOk');
select tests.check_in('late_ok');
select is(tests.line('qf'), 'LateOk,Walk,Early', 'late within grace: still ahead of the walk-in');

-- 4. Late beyond grace: 12 minutes late is a walk-in arriving now, at the end of the line.
select tests.make_expected_visit('late_bad', 'qf', now() - interval '12 minutes', 'LateBad');
select tests.check_in('late_bad');
select is(tests.line('qf'), 'LateOk,Walk,Early,LateBad', 'late beyond grace: end of the line');

-- 5. No-show: never arrives, released by the tick (actor system)
select tests.make_expected_visit('ghost', 'qf', now() - interval '20 minutes', 'Ghost');
select is(private.expire_unarrived(now()), 1, 'no-show: the tick releases the unarrived guest');
select is((select e.actor_kind::text from app.visit_events e where e.visit_id = tests.id('ghost') and e.type = 'no_show'), 'system', 'no-show: by the system');

-- 6. Guard: a walk-in past its quote plus max delay goes before a just-checked-in appointment
select tests.new_visit('old_walk', 'qg', 'OldWalk');
update app.visits set joined_at = now() - interval '16 minutes', eta_quoted_high = 0 where id = tests.id('old_walk');
select tests.make_expected_visit('fresh', 'qg', now() - interval '9 minutes', 'Fresh');
select tests.check_in('fresh');
select is(tests.line('qg'), 'Fresh,OldWalk', 'guard: the appointment is first by position');
select tests.act_as('staff');
select is((select (r).id from (select api.call_next(tests.id('qg'), null, gen_random_uuid()) as r) x), tests.id('old_walk'),
  'guard: the overdue walk-in is called first');
select tests.as_postgres();

-- 6b. A snooze restarts the wait: an old walk-in who just stepped back is not overdue
select tests.new_visit('snoozed', 'qi', 'Snoozed');
select tests.new_visit('plain', 'qi', 'Plain');
update app.visits set joined_at = now() - interval '60 minutes' where id = tests.id('snoozed');
update app.visits set sort_key = (select max(sort_key) + 1024 from app.visits where queue_id = tests.id('qi')) where id = tests.id('snoozed');
select private.set_actor('staff', tests.id('staff'), 'snoozed');
select private.record_visit_event(tests.id('snoozed'), 'snoozed', '{}');
select tests.act_as('staff');
select is((select (r).id from (select api.call_next(tests.id('qi'), null, gen_random_uuid()) as r) x), tests.id('plain'),
  'guard: a recent snooze keeps the guest from jumping the line');
select tests.as_postgres();

-- 7. ETA reserves time for expected guests who check in ahead, when the queue opts in
select tests.new_visit('e1', 'qh', 'E1');
select tests.new_visit('e2', 'qh', 'E2');
select tests.make_expected_visit('r1', 'qh', now() + interval '5 minutes', 'R1');
select tests.make_expected_visit('r2', 'qh', now() + interval '20 minutes', 'R2');
update app.queues set servers_on_duty = 1, show_eta = true where id = tests.id('qh');
create temp table eta_off as select (e).eta_high from (select private.eta_at(tests.id('qh'), (select sort_key from app.visits where id = tests.id('e2'))) e) x;
update app.queues set eta_reserves_appointments = true where id = tests.id('qh');
select cmp_ok((select (e).eta_high from (select private.eta_at(tests.id('qh'), (select sort_key from app.visits where id = tests.id('e2'))) e) x),
  '>=', (select eta_high from eta_off) + 20, 'ETA: expected guests at +5 and +20 minutes add their reserved minutes');
select is((select (e).eta_state::text from (select private.eta_at(tests.id('qh'), (select sort_key from app.visits where id = tests.id('e2'))) e) x) is not null, true, 'and the estimate is still produced');

select * from finish();
rollback;
