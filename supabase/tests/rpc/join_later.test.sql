-- 2B-J3 (#241): join for later today and the activation tick.
begin;
\ir ../helpers/_setup.psql
select plan(18);
select tests.create_world();
-- The slots below sit minutes to hours ahead of now and must stay on the location's service day
-- (it rolls over at 04:00 local), so put the location's clock at noon whatever time the test runs.
update app.locations set tz = case
  when extract(hour from now() at time zone 'UTC') = 12 then 'Etc/UTC'
  else 'Etc/GMT' || case when extract(hour from now() at time zone 'UTC') < 12 then '-' else '+' end
       || abs(12 - extract(hour from now() at time zone 'UTC'))::int
  end
 where id = tests.id('loc_a');
delete from app.business_hours;
delete from app.hours_exceptions;

insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_later_enabled, join_later_max_hours) values
  (tests.new_id('ql'), tests.id('org_a'), tests.id('loc_a'), 'Later', 'L', true, 2),
  (tests.new_id('qn'), tests.id('org_a'), tests.id('loc_a'), 'Not offered', 'N', false, 4);

create function tests.ljoin(p_queue text, p_name text, p_at timestamptz) returns text language sql as $$
  select (api.join_queue(tests.id(p_queue), null, p_name, null, null, 1, 'en', gen_random_uuid(), null, null, '{}', null, null, null, p_at)).token
$$;
grant execute on function tests.ljoin(text, text, timestamptz) to service_role;

select tests.as_service();
create temp table tok (name text primary key, token text);
grant all on tok to service_role;
grant select on tok to anon;
insert into tok select 'Later one', tests.ljoin('ql', 'Later one', now() + interval '30 minutes');
select tests.as_postgres();
select is((select status::text from app.visits where guest_name = 'Later one'), 'expected', 'a later join starts expected');
select ok((select arrive_after > now() from app.visits where guest_name = 'Later one'), 'with its arrive_after');
select ok((select token is not null from tok where name = 'Later one'), 'and a token at once');

-- AC2: bad times
select tests.as_service();
select throws_ok(format($$ select tests.ljoin('ql', 'Past', %L) $$, now() - interval '5 minutes'), 'P0001', 'invalid_arrive_after', 'AC2: a past time is refused');
select throws_ok(format($$ select tests.ljoin('ql', 'Far', %L) $$, now() + interval '3 hours'), 'P0001', 'invalid_arrive_after', 'AC2: beyond max hours is refused');
select throws_ok(format($$ select tests.ljoin('ql', 'Tomorrow', %L) $$, now() + interval '2 days'), 'P0001', 'invalid_arrive_after', 'AC2: another service day is refused');
select throws_ok(format($$ select tests.ljoin('qn', 'Off', %L) $$, now() + interval '30 minutes'), 'P0001', 'invalid_arrive_after', 'a queue that does not offer it refuses');
select tests.as_postgres();

-- AC1: ordering at activation
select tests.new_visit('w_before', 'ql', 'Before');
select tests.new_visit('w_after', 'ql', 'After');
select private.set_actor('system', null);
update app.visits set joined_at = now() - interval '30 minutes' where guest_name = 'Before';
update app.visits set joined_at = now() - interval '2 minutes' where guest_name = 'After';
update app.visits set arrive_after = now() - interval '10 minutes' where guest_name = 'Later one';
select is((select ops.activate_later_tick()), 1, 'the tick activates the due visit');
select is((select string_agg(guest_name, ',' order by sort_key) from app.visits
           where queue_id = tests.id('ql') and status = 'waiting'), 'Before,Later one,After',
  'AC1: behind guests who joined before its time, ahead of those after');
select is((select type from app.visit_events e join app.visits v on v.id = e.visit_id
           where v.guest_name = 'Later one' order by e.id desc limit 1), 'check_in', 'the activation is a check_in event');

-- AC3: idempotent
select is((select version from app.visits where guest_name = 'Later one'), (select version from app.visits where guest_name = 'Later one'), 'baseline');
select is((select ops.activate_later_tick()), 0, 'AC3: the second run changes nothing');

-- AC4: a closed queue still activates a promised place
select tests.as_service();
select tests.ljoin('ql', 'Promised', now() + interval '20 minutes');
select tests.as_postgres();
update app.queues set manual_state = 'closed' where id = tests.id('ql');
select private.set_actor('system', null);
update app.visits set arrive_after = now() - interval '1 minute' where guest_name = 'Promised';
select ops.activate_later_tick();
select is((select status::text from app.visits where guest_name = 'Promised'), 'waiting', 'AC4: activated although the queue is closed');

-- the tick survives a queue with no gap to file into (renumbering)
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_later_enabled, capacity)
values (tests.new_id('qr'), tests.id('org_a'), tests.id('loc_a'), 'Tight', 'T', true, 3);
select tests.new_visit('t1', 'qr', 'T1');
select tests.new_visit('t2', 'qr', 'T2');
select private.set_actor('system', null);
update app.visits set sort_key = 1000, joined_at = now() - interval '40 minutes' where guest_name = 'T1';
update app.visits set sort_key = 1001, joined_at = now() - interval '2 minutes' where guest_name = 'T2';
select tests.as_service();
select tests.ljoin('qr', 'T3', now() + interval '20 minutes');
select tests.as_postgres();
select private.set_actor('system', null);
update app.visits set arrive_after = now() - interval '10 minutes' where guest_name = 'T3';
select is((select ops.activate_later_tick()), 1, 'the tick files a visit even when the queue must be renumbered');
select is((select string_agg(guest_name, ',' order by sort_key) from app.visits where queue_id = tests.id('qr') and status = 'waiting'),
  'T1,T3,T2', 'and it lands in the right place');
-- reserved places count toward capacity
select tests.as_service();
select throws_ok($$ select tests.ljoin('qr', 'T4', now() + interval '20 minutes') $$, 'P0001', 'capacity_reached', 'a full queue takes no more reservations');
select tests.as_postgres();

-- status and tenancy
select tests.as_anon();
select is((select (api.get_visit_status((select token from tok where name = 'Later one'))).arrive_after is not null), true, 'get_visit_status carries arrive_after');
select tests.act_as('other_owner');
select is((select count(*)::int from app.staff_visits where guest_name in ('Later one', 'Promised')), 0, 'AC5: org B sees no later visits');
select * from finish();
rollback;
