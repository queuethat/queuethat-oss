-- V7 (#36): service-day rollover around boundaries and DST change days, idempotency, grants.
begin;
\ir ../helpers/_setup.psql
select plan(33);
select tests.create_world();

-- loc_a is America/New_York, loc_b is Europe/Berlin, both with the default 04:00 boundary.
-- Seeded demo locations are parked in the future so only the fixtures roll over.
update app.locations set last_rollover_day = '2100-01-01'
where id not in (tests.id('loc_a'), tests.id('loc_b'));
-- The world's own visit is on the real current day; keep it out of every fixture day.
select private.set_actor('system', null);
update app.visits set service_day = '2100-01-01' where id = tests.id('visit_a');
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Berlin', 'B');

/** A visit in p_queue on service day p_day, moved to p_status through the state machine. */
create function tests.visit_on(p_name text, p_queue text, p_day date, p_status text default 'waiting')
returns uuid
language plpgsql as $$
declare
  vid uuid := tests.new_visit(p_name, p_queue);
  step text;
begin
  perform private.set_actor('system', null);
  update app.visits set service_day = p_day where id = vid;
  foreach step in array case p_status when 'called' then array['call']
                                      when 'serving' then array['call', 'start']
                                      else '{}'::text[] end loop
    perform private.set_actor('staff', null, step);
    update app.visits
    set status = case step when 'call' then 'called' else 'serving' end::api.visit_state
    where id = vid;
  end loop;
  return vid;
end $$;

create function tests.status(p_name text) returns text
language sql stable as $$ select status::text from app.visits where id = tests.id(p_name) $$;

create function tests.rolled_to(p_loc text) returns date
language sql stable as $$ select last_rollover_day from app.locations where id = tests.id(p_loc) $$;

create function tests.events() returns bigint
language sql stable as $$ select count(*) from app.visit_events $$;

------------------------------------------------------------------------------------------------
-- AC1: Berlin fall-back day (2026-10-25, 04:00 CET = 03:00Z); New York is still on 10-24
------------------------------------------------------------------------------------------------
update app.locations set last_rollover_day = '2026-10-24' where id in (tests.id('loc_a'), tests.id('loc_b'));
select tests.visit_on('b_wait', 'queue_b', '2026-10-24');
select tests.visit_on('b_called', 'queue_b', '2026-10-24', 'called');
select tests.visit_on('b_serving', 'queue_b', '2026-10-24', 'serving');
select tests.visit_on('a_wait', 'queue_a', '2026-10-24');
create table tests.marks as
  select 'queue_b'::text as name, version::bigint as n from app.queues where id = tests.id('queue_b')
  union all select 'notifications', count(*) from app.notifications
  union all select 'audit', count(*) from app.audit_log where table_name = 'locations';

select is(private.rollover('2026-10-25 02:59Z'), 0, 'Berlin 03:59 CET on fall-back day: nothing rolls');
select is(tests.status('b_wait'), 'waiting', '... the Berlin visit is still waiting');
select is(private.rollover('2026-10-25 03:00Z'), 3, 'Berlin 04:00 CET: three Berlin visits change');
select is(tests.status('b_wait'), 'expired', 'a waiting visit of the old day expires');
select is(tests.status('b_called'), 'expired', 'a called visit of the old day expires');
select is(tests.status('b_serving'), 'served', 'a serving visit is auto-closed as served');
select is(tests.status('a_wait'), 'waiting', 'New York (23:00 EDT on 10-24) does not roll');
select is(tests.rolled_to('loc_b'), '2026-10-25'::date, 'Berlin last_rollover_day moves to 10-25');
select is(tests.rolled_to('loc_a'), '2026-10-24'::date, 'New York last_rollover_day stays');

select results_eq(
  $$select type, reason, actor_kind::text, payload from app.visit_events
    where visit_id in (tests.id('b_wait'), tests.id('b_serving')) and to_status in ('expired', 'served')
    order by type$$,
  $$values ('complete', 'day_end', 'system', '{"auto_closed": true}'::jsonb),
           ('expire', 'day_end', 'system', '{}'::jsonb)$$,
  'events: expire with reason day_end, auto-closed complete, both by the system');
select is((select finished_at from app.visits where id = tests.id('b_wait')), '2026-10-25 03:00Z'::timestamptz,
  'finished_at is the tick time');
select is((select version::bigint from app.queues where id = tests.id('queue_b')),
  (select n + 1 from tests.marks where name = 'queue_b'), 'the Berlin queue version bumps once');
select is((select count(*) from app.notifications), (select n from tests.marks where name = 'notifications'),
  'rollover enqueues no notifications');
select is((select count(*) from app.audit_log where table_name = 'locations'),
  (select n from tests.marks where name = 'audit'), 'last_rollover_day changes write no audit rows');

------------------------------------------------------------------------------------------------
-- AC2: a second run changes nothing
------------------------------------------------------------------------------------------------
create temp table before_rerun as select tests.events() as n;
select is(private.rollover('2026-10-25 03:00Z'), 0, 'AC2: the same tick again changes nothing');
select is(private.rollover('2026-10-25 03:05Z'), 0, 'AC2: the next tick changes nothing');
select is(tests.events(), (select n from before_rerun), 'AC2: no events written on rerun');

------------------------------------------------------------------------------------------------
-- AC1: New York's own boundary on the same date (04:00 EDT = 08:00Z)
------------------------------------------------------------------------------------------------
select is(private.rollover('2026-10-25 07:59Z'), 0, 'NY 03:59 EDT: nothing rolls');
select is(private.rollover('2026-10-25 08:00Z'), 1, 'NY 04:00 EDT: the New York visit expires');
select is(tests.status('a_wait'), 'expired', '... it is the leftover NY visit');

------------------------------------------------------------------------------------------------
-- AC1: New York fall-back day (2026-11-01, 04:00 EST = 09:00Z, not 08:00Z)
------------------------------------------------------------------------------------------------
update app.locations set last_rollover_day = '2026-10-31' where id = tests.id('loc_a');
update app.locations set last_rollover_day = '2026-11-01' where id = tests.id('loc_b');
select tests.visit_on('a_fall', 'queue_a', '2026-10-31');
select tests.visit_on('b_fall', 'queue_b', '2026-10-31');
select is(private.rollover('2026-11-01 08:00Z'), 0, 'NY 03:00 EST on fall-back day: not yet (an EDT clock would roll)');
select is(private.rollover('2026-11-01 08:59Z'), 0, 'NY 03:59 EST: nothing rolls');
select is(private.rollover('2026-11-01 09:00Z'), 1, 'NY 04:00 EST: only New York rolls');
select is(tests.status('b_fall'), 'waiting', 'the Berlin location, already on 11-01, is untouched');

------------------------------------------------------------------------------------------------
-- AC1: spring-forward days (NY 2026-03-08 04:00 EDT = 08:00Z, Berlin 2026-03-29 04:00 CEST = 02:00Z)
------------------------------------------------------------------------------------------------
update app.locations set last_rollover_day = '2026-03-07' where id = tests.id('loc_a');
update app.locations set last_rollover_day = '2026-03-28' where id = tests.id('loc_b');
select tests.visit_on('a_spring', 'queue_a', '2026-03-07', 'called');
select tests.visit_on('b_spring', 'queue_b', '2026-03-28');
select is(private.rollover('2026-03-08 07:59Z'), 0, 'NY 03:59 EDT on spring-forward day: nothing rolls');
select is(private.rollover('2026-03-08 08:00Z'), 1, 'NY 04:00 EDT: only New York rolls');
select is(private.rollover('2026-03-29 01:59Z'), 0, 'Berlin 03:59 CEST on spring-forward day: nothing rolls');
select is(private.rollover('2026-03-29 02:00Z'), 1, 'Berlin 04:00 CEST: only Berlin rolls');

------------------------------------------------------------------------------------------------
-- AC3: not callable through the API; the job is scheduled
------------------------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok('select ops.rollover_tick()', '42501', null, 'AC3: anon cannot call ops.rollover_tick');
select tests.act_as('owner');
select throws_ok('select ops.rollover_tick()', '42501', null, 'AC3: an authenticated owner cannot call it');
select throws_ok($$select private.rollover(now())$$, '42501', null, 'AC3: nor the private sweep');
select tests.as_postgres();

select is((select schedule from cron.job where jobname = 'rollover-tick'), '*/5 * * * *',
  'pg_cron runs the tick every 5 minutes');
select is((select command from cron.job where jobname = 'prune-cron-history'), 'select ops.prune_cron_history()',
  'pg_cron prunes its own history daily');

select * from finish();
rollback;
