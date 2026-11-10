-- 2B-Q1 (#226): priority classes and api.set_visit_priority.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');

insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_pr'), tests.id('org_a'), tests.id('loc_a'), 'Priority', 'R');
insert into app.priority_classes (id, org_id, location_id, name, offset_minutes) values
  (tests.new_id('class_30'), tests.id('org_a'), tests.id('loc_a'), 'Elderly', 30),
  (tests.new_id('class_off'), tests.id('org_a'), tests.id('loc_a'), 'Retired', 30);
update app.priority_classes set active = false where id = tests.id('class_off');
-- Five guests, ten minutes apart: p1 is oldest.
select tests.new_visit('p1', 'queue_pr', 'One');
select tests.new_visit('p2', 'queue_pr', 'Two');
select tests.new_visit('p3', 'queue_pr', 'Three');
select tests.new_visit('p4', 'queue_pr', 'Four');
select tests.new_visit('p5', 'queue_pr', 'Five');
update app.visits set joined_at = now() - make_interval(mins => 60 - 10 * n)
from (values ('p1', 0), ('p2', 1), ('p3', 2), ('p4', 3), ('p5', 4)) as t(k, n)
where id = tests.id(t.k);

create function tests.ver(p_visit text) returns int language sql as $$
  select version from app.visits where id = tests.id(p_visit)
$$;
create function tests.line() returns text language sql as $$
  select string_agg(v.guest_name, ',' order by v.sort_key, v.id)
  from app.visits v where v.queue_id = tests.id('queue_pr') and v.status = 'waiting'
$$;
create function tests.prio(p_visit text, p_class text) returns api.visit_row language sql as $$
  select api.set_visit_priority(tests.id(p_visit), tests.id(p_class), tests.ver(p_visit), gen_random_uuid())
$$;
grant execute on function tests.ver(text), tests.line(), tests.prio(text, text) to authenticated;
grant select on all tables in schema tests to authenticated;

select is(tests.line(), 'One,Two,Three,Four,Five', 'baseline order');

-- AC1: p5 joined 20 min ago; the 30 min class files it ahead of p4 and p3 (joined less than 30 min before it), not p2
select tests.act_as('staff');
select tests.prio('p5', 'class_30');
select tests.as_postgres();
select is(tests.line(), 'One,Two,Five,Three,Four', 'AC1: Five jumps the guests who joined less than 30 minutes before it');
select is((select count(*)::int from app.visit_events where visit_id = tests.id('p5') and type = 'priority_changed'), 1,
  'AC1: a priority_changed event exists');
select is((select status::text from app.visits where id = tests.id('p5')), 'waiting', 'the event leaves the state alone');

-- clearing puts it back where its arrival time says
select tests.act_as('staff');
select tests.prio('p5', null);
select tests.as_postgres();
select is(tests.line(), 'One,Two,Three,Four,Five', 'clearing the class refiles by arrival time');

-- same class again: no event
select tests.act_as('staff');
select tests.prio('p4', 'class_30');
select is((tests.prio('p4', 'class_30')).last_event_id, null, 'the same class again is a no-op without an event');
select tests.as_postgres();
select is(tests.line(), 'One,Four,Two,Three,Five', 'p4 (30 min offset) ties One on effective arrival and files after it');

-- AC2: manual reorder wins
select tests.act_as('staff');
select api.move_visit(tests.id('p1'), tests.id('p5'), tests.ver('p1'), gen_random_uuid());
select tests.as_postgres();
select is(tests.line(), 'Four,Two,Three,Five,One', 'p1 moved to the end by hand');
select ok((select manually_ordered from app.visits where id = tests.id('p1')), 'move_visit marks the visit manually ordered');
select tests.act_as('staff');
select tests.prio('p1', 'class_30');
select tests.as_postgres();
select is(tests.line(), 'Four,Two,Three,Five,One', 'AC2: a class on a hand-placed visit leaves its sort_key alone');
select is((select priority_class_id from app.visits where id = tests.id('p1')), tests.id('class_30'), 'but the class is recorded');

-- AC5: stale version, and the error cases
select tests.act_as('staff');
select throws_ok(format($$ select api.set_visit_priority(%L, %L, %s, gen_random_uuid()) $$, tests.id('p2'), tests.id('class_30'), tests.ver('p2') + 7),
  'P0001', 'stale_visit', 'AC5: a stale version raises stale_visit');
select throws_ok(format($$ select api.set_visit_priority(%L, %L, %s, gen_random_uuid()) $$, tests.id('p2'), tests.id('class_off'), tests.ver('p2')),
  'P0001', 'not_found', 'an inactive class is not_found');
select tests.as_postgres();
select is((select priority_class_id from app.visits where id = tests.id('p2')), null, 'nothing changed');

-- AC4: org B cannot reach org A
select tests.act_as('other_owner');
select throws_ok(format($$ select api.set_visit_priority(%L, null, 1, gen_random_uuid()) $$, tests.id('p2')),
  'P0001', 'not_found', 'AC4: another org''s staff get not_found');
select is((select count(*)::int from app.priority_classes), 0, 'AC4: and see no classes');

-- AC3: a guest join never carries a class, whatever the payload says
select tests.as_service();
select throws_ok(format($$ select api.join_queue(%L, null, 'Guest', null, null, 1, 'en', gen_random_uuid(), null, null, %L) $$,
  tests.id('queue_pr'), jsonb_build_object('priority_class_id', tests.id('class_30'), 'priority', 'vip')),
  'P0001', 'invalid_answers', 'AC3: a priority payload is not an accepted answer');
select api.join_queue(tests.id('queue_pr'), null, 'Guest', null, null, 1, 'en', gen_random_uuid());
select tests.as_postgres();
select is((select priority_class_id from app.visits where queue_id = tests.id('queue_pr') and guest_name = 'Guest'), null,
  'AC3: a guest join has no class');
select * from finish();
rollback;
