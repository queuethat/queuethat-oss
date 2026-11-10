-- 2A-ST12 (#145): api.correct_visit_times.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_c'), tests.id('org_a'), tests.id('loc_a'), 'Correct', 'C');
select tests.new_visit('c1', 'queue_c', 'Cleo');
select tests.new_visit('c2', 'queue_c', 'Cy');
select tests.new_visit('c3', 'queue_c', 'Cam');
update app.visits set joined_at = now() - interval '3 hours' where queue_id = tests.id('queue_c');

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
create function tests.fix(p_visit text, p_called interval, p_serving interval, p_finished interval, p_reason text default 'forgot to complete')
returns api.visit_row language sql as $$
  select api.correct_visit_times(tests.id(p_visit),
    now() - p_called, now() - p_serving, now() - p_finished, p_reason, tests.ver(p_visit), gen_random_uuid())
$$;
grant execute on function tests.ver(text), tests.fix(text, interval, interval, interval, text) to authenticated;
create table tests.rows (name text primary key, r api.visit_row);
grant select, insert on tests.rows to authenticated;

-- staff serves c1 and c2; the manager serves c3
select tests.act_as('staff');
select api.call_next(tests.id('queue_c'), null, gen_random_uuid());
select api.transition_visit(tests.id('c1'), 'start', tests.ver('c1'), gen_random_uuid());
select api.transition_visit(tests.id('c1'), 'complete', tests.ver('c1'), gen_random_uuid());
select api.call_next(tests.id('queue_c'), null, gen_random_uuid());
select api.transition_visit(tests.id('c2'), 'no_show', tests.ver('c2'), gen_random_uuid());
select tests.act_as('manager');
select api.call_next(tests.id('queue_c'), null, gen_random_uuid());
select api.transition_visit(tests.id('c3'), 'start', tests.ver('c3'), gen_random_uuid());
select api.transition_visit(tests.id('c3'), 'complete', tests.ver('c3'), gen_random_uuid());

-- AC3: a correction writes before and after and bumps the version
select tests.act_as('staff');
create temp table v0 as select version, called_at, serving_at, finished_at from app.visits where id = tests.id('c1');
grant select on v0 to authenticated;
insert into tests.rows values ('fix', tests.fix('c1', interval '150 minutes', interval '140 minutes', interval '120 minutes'));
select tests.as_postgres();
select is((select version from app.visits where id = tests.id('c1')), (select version + 1 from v0), 'AC3: the visit version increased');
select results_eq($$ select type, reason, (payload -> 'before' ->> 'finished_at')::timestamptz, (payload ->> 'excluded')::boolean
                    from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'fix') $$,
  $$ select 'times_corrected', 'forgot to complete', finished_at, false from v0 $$,
  'AC3: the event holds the reason, the before times and excluded = false');
select ok((select (payload -> 'after' ->> 'finished_at')::timestamptz from app.visit_events where id = (select (r).last_event_id from tests.rows where name = 'fix'))
          = (select finished_at from app.visits where id = tests.id('c1')), 'and the after times');

-- AC1: out of order or future times
select tests.act_as('staff');
select throws_ok($$ select tests.fix('c1', interval '150 minutes', interval '140 minutes', interval '145 minutes') $$,
  'P0001', 'invalid_times', 'AC1: finished before serving raises invalid_times');
select throws_ok($$ select tests.fix('c1', interval '200 minutes', interval '140 minutes', interval '120 minutes') $$,
  'P0001', 'invalid_times', 'called before joining raises invalid_times');
select throws_ok($$ select tests.fix('c1', interval '150 minutes', interval '140 minutes', interval '-10 minutes') $$,
  'P0001', 'invalid_times', 'a time in the future raises invalid_times');
select throws_ok($$ select tests.fix('c1', interval '150 minutes', interval '140 minutes', interval '120 minutes', '  ') $$,
  'P0001', 'invalid_input', 'a reason is required');
select throws_ok(format($$ select api.correct_visit_times(%L, null, null, now(), 'r', 0, gen_random_uuid()) $$, tests.id('c1')),
  'P0001', 'stale_visit', 'a stale version raises stale_visit');

-- AC2: staff who did not handle the visit are denied; managers may correct it
select throws_ok($$ select tests.fix('c3', interval '150 minutes', interval '140 minutes', interval '120 minutes') $$,
  '42501', 'permission_denied', 'AC2: staff who did not handle the visit are denied');
select tests.act_as('manager');
select lives_ok($$ select tests.fix('c3', interval '150 minutes', interval '140 minutes', interval '120 minutes') $$,
  'a manager corrects any visit of the location');
select lives_ok(format($$ select api.correct_visit_times(%L, now() - interval '150 minutes', null, now() - interval '120 minutes', 'late no-show', %s, gen_random_uuid()) $$, tests.id('c2'), tests.ver('c2')),
  'a no_show visit can be corrected; serving_at stays null');

select throws_ok(format($$ select api.correct_visit_times(%L, null, now() - interval '100 minutes', null, 'r', %s, gen_random_uuid()) $$, tests.id('c2'), tests.ver('c2')),
  'P0001', 'invalid_times', 'a no_show visit cannot gain a serving time');
select is((select (r).last_event_id from (select api.correct_visit_times(tests.id('c2'), null, null, null, 'same', tests.ver('c2'), gen_random_uuid()) as r) x),
  null::bigint, 'correcting nothing is a no-op without an event');
create temp table k as select gen_random_uuid() as key;
grant select on k to authenticated;
insert into tests.rows select 'first', api.correct_visit_times(tests.id('c3'), now() - interval '160 minutes', null, null, 'again', tests.ver('c3'), (select key from k));
insert into tests.rows select 'replay', api.correct_visit_times(tests.id('c3'), now() - interval '170 minutes', null, null, 'again', 0, (select key from k));
select is((select to_jsonb(r) from tests.rows where name = 'replay'), (select to_jsonb(r) from tests.rows where name = 'first'), 'repeating a key returns the first result');

-- staff who only added the visit (a walk-in) did not handle it
select tests.act_as('staff');
select api.staff_add_visit(tests.id('queue_c'), null, 'Walk In', null, 1, gen_random_uuid());
select tests.act_as('manager');
select api.call_next(tests.id('queue_c'), null, gen_random_uuid());
select api.transition_visit(id, 'start', version, gen_random_uuid()) from app.visits where guest_name = 'Walk In';
select api.transition_visit(id, 'complete', version, gen_random_uuid()) from app.visits where guest_name = 'Walk In';
select tests.act_as('staff');
select throws_ok($$ select api.correct_visit_times((select id from app.visits where guest_name = 'Walk In'), null, null, now() - interval '2 minutes', 'r', (select version from app.visits where guest_name = 'Walk In'), gen_random_uuid()) $$,
  '42501', 'permission_denied', 'staff who only added the walk-in cannot correct its times');
select tests.as_postgres();
select tests.new_visit('c4', 'queue_c', 'Cat');
select tests.act_as('manager');
select throws_ok(format($$ select api.correct_visit_times(%L, null, null, now(), 'r', %s, gen_random_uuid()) $$, tests.id('c4'), tests.ver('c4')),
  'P0001', 'illegal_transition', 'a waiting visit cannot be corrected');

-- AC4
select tests.act_as('other_owner');
select throws_ok(format($$ select api.correct_visit_times(%L, null, null, now(), 'r', 0, gen_random_uuid()) $$, tests.id('c1')),
  'P0001', 'not_found', 'AC4: a manager of org B gets not_found');
select tests.as_anon();
select throws_ok(format($$ select api.correct_visit_times(%L, null, null, now(), 'r', 0, gen_random_uuid()) $$, tests.id('c1')),
  '42501', null, 'anon is denied');

select * from finish();
rollback;
