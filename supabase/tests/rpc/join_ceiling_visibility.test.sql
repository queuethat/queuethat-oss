-- #492 (20261025005100_join_ceiling_visibility.sql): staff can see when a queue's hourly online
-- ceiling is reached, from the same rule take_join_slot enforces; admins set it within 1 to 1000.
begin;
\ir ../helpers/_setup.psql
select plan(12);
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
grant execute on function tests.error_detail(text) to anon, authenticated;

delete from app.business_hours where location_id = tests.id('loc_a');
delete from app.hours_exceptions where location_id = tests.id('loc_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix, join_rate_per_min, online_joins_per_hour) values
  (tests.new_id('queue_cap'), tests.id('org_a'), tests.id('loc_a'), 'Capped', 'C', 100, 3);
grant select on tests.ids to anon, authenticated;

create function tests.paused_until(p_actor text) returns timestamptz
language plpgsql as $$
declare r timestamptz;
begin
  perform tests.act_as(p_actor);
  select app.online_joins_paused_until(q) into r from app.queues q where q.id = tests.id('queue_cap');
  perform tests.as_postgres();
  return r;
end $$;

-- Below the ceiling.
select tests.as_anon();
select set_config('request.headers', '{"x-real-ip": "198.51.100.1"}', true);
select api.join_queue(tests.id('queue_cap'), null, 'G' || i, null, null, 1, null, gen_random_uuid(),
                      'ceiling-device-key-000' || i)
from generate_series(1, 2) i;
select tests.as_postgres();
select is(tests.paused_until('staff'), null, 'under the ceiling, online joins are not paused');

-- At the ceiling.
select tests.as_anon();
select api.join_queue(tests.id('queue_cap'), null, 'G3', null, null, 1, null, gen_random_uuid(), 'ceiling-device-key-0003');
select tests.as_postgres();
select is(tests.paused_until('staff'),
          (select max(joined_at) + interval '1 hour' from app.visits where queue_id = tests.id('queue_cap')),
  'at the ceiling, staff see when online joins open again: the oldest counted join plus an hour');
select is((select app.online_joins_paused_until(q) from app.queues q where q.id = tests.id('queue_cap')),
          tests.paused_until('staff'), 'the same value through the function');
select tests.as_anon();
select is(tests.error_detail($$ select api.join_queue(tests.id('queue_cap'), null, 'G4', null, null, 1, null, gen_random_uuid(), 'ceiling-device-key-0004') $$),
  'queue_total', 'and join_queue refuses online joins with queue_total, from the same rule');
select tests.as_postgres();
select is(tests.paused_until('other_owner'), null,
  'cross-tenant: another org''s owner cannot see the queue, so learns nothing about its ceiling');
select ok(not has_function_privilege('anon', 'app.online_joins_paused_until(app.queues)', 'EXECUTE'),
  'anon cannot call it');
select ok(not (select prosecdef from pg_proc where oid = 'app.online_joins_paused_until(app.queues)'::regprocedure),
  'it is security invoker, so a staff caller only counts visits RLS shows them');

-- Raising the ceiling reopens joins at once.
select tests.act_as('admin');
update app.queues set online_joins_per_hour = 4 where id = tests.id('queue_cap');
select tests.as_postgres();
select is(tests.paused_until('staff'), null, 'an admin raising the ceiling reopens online joins');

-- Who may change it, and the range.
select is(tests.probe('staff', $$ with u as (update app.queues set online_joins_per_hour = 500
                                  where id = tests.id('queue_cap') returning 1) select count(*) from u $$),
  'deny', 'staff cannot change the ceiling');
select is(tests.probe('other_owner', $$ with u as (update app.queues set online_joins_per_hour = 500
                                        where id = tests.id('queue_cap') returning 1) select count(*) from u $$),
  'deny', 'cross-tenant: another org''s owner cannot change it');
select throws_ok($$ update app.queues set online_joins_per_hour = 1001 where id = tests.id('queue_cap') $$,
  '23514', null, 'the ceiling is at most 1000');
select throws_ok($$ update app.queues set online_joins_per_hour = 0 where id = tests.id('queue_cap') $$,
  '23514', null, 'and at least 1');

select * from finish();
rollback;
