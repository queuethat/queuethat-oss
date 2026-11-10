-- PLT7 (#413): the nightly rollup is idempotent and backfills missed days; platform_health and
-- platform_stats are counts-only RPCs for support and operators.
begin;
\ir ../helpers/_setup.psql
select plan(14);

select tests.create_world();
insert into app.queues (id, org_id, location_id, name, ticket_prefix)
values (tests.new_id('queue_b'), tests.id('org_b'), tests.id('loc_b'), 'Queue B', 'B');
select tests.new_visit('visit_b', 'queue_b');

-- Synthetic history on two UTC days. visit_events is append-only, so the setup inserts rows with
-- explicit timestamps and marks one transition undone with the guard trigger off.
/** Appends a visit_events row for org/visit at p_at; returns its id. */
create function tests.event(p_visit text, p_type text, p_to api.visit_state, p_at timestamptz)
returns bigint language sql as $$
  insert into app.visit_events (org_id, visit_id, type, to_status, actor_kind, occurred_at)
  select v.org_id, v.id, p_type, p_to, 'system', p_at from app.visits v where v.id = tests.id(p_visit)
  returning id
$$;

select tests.event('visit_a', 'joined', 'waiting', '2026-03-10 08:00Z');
select tests.event('visit_a', 'joined', 'waiting', '2026-03-10 23:59Z');
select tests.event('visit_a', 'complete', 'served', '2026-03-10 09:00Z');
select tests.event('visit_a', 'cancel', 'cancelled', '2026-03-10 10:00Z');
alter table app.visit_events disable trigger guard_visit_event;
select tests.event('visit_a', 'complete', 'served', '2026-03-10 11:00Z') as done_id \gset
select tests.event('visit_a', 'undo', 'waiting', '2026-03-10 11:05Z') as undo_id \gset
update app.visit_events set undone_by_event_id = :undo_id where id = :done_id;
alter table app.visit_events enable trigger guard_visit_event;
select tests.event('visit_b', 'joined', 'waiting', '2026-03-11 00:00Z');
select tests.event('visit_b', 'no_show', 'no_show', '2026-03-11 12:00Z');

insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, created_at, updated_at)
values (tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'sent-1', 'sent',
        '2026-03-10 09:00Z', '2026-03-10 09:01Z'),
       (tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'dead-1', 'dead',
        '2026-03-11 09:00Z', '2026-03-11 09:30Z');

-- AC2: nothing computed for these days yet; one tick on 2026-03-12 fills both.
select private.platform_stats('2026-03-12');
select results_eq(
  $$ select day, org_id, joins, served, no_shows, cancelled, notifications_sent, notifications_failed
     from app.platform_daily_stats where day >= '2026-03-01' order by day, org_id = tests.id('org_b') $$,
  $$ values ('2026-03-10'::date, tests.id('org_a'), 2, 1, 0, 1, 1, 0),
            ('2026-03-11'::date, tests.id('org_a'), 0, 0, 0, 0, 0, 1),
            ('2026-03-11'::date, tests.id('org_b'), 1, 0, 1, 0, 0, 0) $$,
  'AC2: one tick fills both missed days; undone transitions and undo events are not counted');

-- AC1: running the tick again for the same day changes nothing and duplicates nothing.
create temp table before_rerun as
  select day, org_id, joins, served, no_shows, cancelled, notifications_sent, notifications_failed
  from app.platform_daily_stats;
select private.platform_stats('2026-03-12');
select private.platform_stats('2026-03-12');
select set_eq(
  $$ select day, org_id, joins, served, no_shows, cancelled, notifications_sent, notifications_failed
     from app.platform_daily_stats $$,
  $$ select * from before_rerun $$,
  'AC1: a repeated tick leaves identical rows and no duplicates');

-- A later tick only recomputes from the day after the last one it has.
select private.platform_stats('2026-03-13');
select is((select count(*)::int from app.platform_daily_stats where day >= '2026-03-01'), 3,
  'a tick with no new activity adds no rows');

select is((select schedule from cron.job where jobname = 'platform-stats-tick'), '15 0 * * *',
  'the tick runs daily at 00:15 UTC');

-- AC3 and the health snapshot. One more notification waits to be sent, ten minutes old.
insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                               dedupe_key, status, created_at)
values (tests.id('org_a'), tests.id('visit_a'), 'push', tests.id('push_a'), 'called', 1, 'queued-old', 'queued',
        now() - interval '10 minutes');

select count(*) as waiting from app.notifications where status in ('queued', 'failed') \gset

select tests.act_as('platform');
select is((api.platform_health()).notifications_dead, 1, 'AC3: platform_health reports the dead notification');
select is((api.platform_health()).notifications_queued, :waiting, 'platform_health counts notifications waiting to send');
select ok((api.platform_health()).oldest_queued_seconds >= 600, 'platform_health reports the oldest waiting age');
select ok((api.platform_health()).cron_jobs @> '[{"name": "platform-stats-tick", "schedule": "15 0 * * *"}]',
  'platform_health lists the pg_cron jobs');
select is((api.platform_health()).orgs_active_today, 2, 'platform_health counts orgs with a join today');

select is((select count(*)::int from api.platform_stats('2026-03-10', '2026-03-11')), 3,
  'platform_stats returns the rows in range');
select throws_ok($$ select * from api.platform_stats('2026-03-11', '2026-03-10') $$, 'P0001', 'invalid_input',
  'a reversed range is invalid_input');
select throws_ok($$ select * from api.platform_stats('2025-01-01', '2026-03-10') $$, 'P0001', 'invalid_input',
  'a range over a year is invalid_input');

select tests.act_as('owner');
select throws_ok('select api.platform_health()', '42501', 'permission_denied', 'an org owner cannot read platform health');
select throws_ok($$ select * from api.platform_stats('2026-03-10', '2026-03-11') $$, '42501', 'permission_denied',
  'an org owner cannot read platform stats');

select * from finish();
rollback;
