-- PLT7 (#413): daily platform usage counts and a platform health snapshot for the operator
-- console (technical-design.md 3.6). Counts only, never tenant rows, and computed nightly so the
-- console never runs heavy queries against live tables.
--
-- Days are UTC days. A visit's service day is local to its location, but operators compare the
-- whole platform, so one clock for every org keeps the rows additive.

------------------------------------------------------------------------------------------------
-- Table
------------------------------------------------------------------------------------------------

create table app.platform_daily_stats (
  day date not null,
  -- No foreign key: the counts outlive a deleted org, like platform_audit.
  org_id uuid not null,
  joins int not null default 0,
  served int not null default 0,
  no_shows int not null default 0,
  cancelled int not null default 0,
  notifications_sent int not null default 0,
  notifications_failed int not null default 0,
  computed_at timestamptz not null default now(),
  primary key (day, org_id)
);

------------------------------------------------------------------------------------------------
-- Rollup
------------------------------------------------------------------------------------------------

-- Longest gap one tick fills; older missed days stay empty rather than making one tick slow.
create function private.platform_stats_backfill_days() returns int
language sql immutable set search_path = '' as $$ select 31 $$;

create function private.platform_stats(p_today date) returns int
language plpgsql volatile set search_path = '' as $$
declare
  first_day date;
  last_day date := p_today - 1;
  written int;
begin
  -- From the day after the last one computed, but never later than yesterday (so the last day
  -- is always recomputed) and never further back than the backfill window.
  first_day := greatest(
    least(coalesce((select max(day) + 1 from app.platform_daily_stats), last_day), last_day),
    p_today - private.platform_stats_backfill_days());

  delete from app.platform_daily_stats where day between first_day and last_day;

  with days as (
    select generate_series(first_day, last_day, interval '1 day')::date as day
  ), events as (
    -- Undone transitions never happened, as far as the counts are concerned.
    select (e.occurred_at at time zone 'UTC')::date as day, e.org_id,
           count(*) filter (where e.type = 'joined') as joins,
           count(*) filter (where e.to_status = 'served' and e.type <> 'joined') as served,
           count(*) filter (where e.to_status = 'no_show') as no_shows,
           count(*) filter (where e.to_status = 'cancelled') as cancelled
    from app.visit_events e
    where e.occurred_at >= first_day::timestamp at time zone 'UTC'
      and e.occurred_at < (last_day + 1)::timestamp at time zone 'UTC'
      and e.undone_by_event_id is null
      and e.type <> 'undo'
    group by 1, 2
  ), sends as (
    -- A notification counts on the day it reached its final state.
    select (n.updated_at at time zone 'UTC')::date as day, n.org_id,
           count(*) filter (where n.status = 'sent') as sent,
           count(*) filter (where n.status = 'dead') as failed
    from app.notifications n
    where n.status in ('sent', 'dead')
      and n.updated_at >= first_day::timestamp at time zone 'UTC'
      and n.updated_at < (last_day + 1)::timestamp at time zone 'UTC'
    group by 1, 2
  ), rows as (
    insert into app.platform_daily_stats
      (day, org_id, joins, served, no_shows, cancelled, notifications_sent, notifications_failed)
    select d.day, k.org_id,
           coalesce(e.joins, 0), coalesce(e.served, 0), coalesce(e.no_shows, 0), coalesce(e.cancelled, 0),
           coalesce(s.sent, 0), coalesce(s.failed, 0)
    from days d
    join (select day, org_id from events union select day, org_id from sends) k on k.day = d.day
    left join events e on e.day = k.day and e.org_id = k.org_id
    left join sends s on s.day = k.day and s.org_id = k.org_id
    returning 1
  )
  select count(*)::int into written from rows;
  return written;
end $$;
comment on function private.platform_stats(date) is
  'ops.platform_stats_tick() as if today were p_today: recomputes every UTC day from the day after '
  'the last computed one (at most 31 days back) through yesterday, one row per org with any '
  'activity. Replaces those days'' rows, so running it twice leaves identical rows. Returns rows written.';

create function ops.platform_stats_tick() returns int
language sql volatile set search_path = '' as $$
  select private.platform_stats((now() at time zone 'UTC')::date)
$$;
comment on function ops.platform_stats_tick() is
  'Fills app.platform_daily_stats through yesterday (UTC), backfilling missed days. Idempotent. '
  'Run daily at 00:15 UTC by pg_cron (job platform-stats-tick).';

revoke all on function private.platform_stats_backfill_days() from public, anon, authenticated;
revoke all on function private.platform_stats(date) from public, anon, authenticated;
revoke all on function ops.platform_stats_tick() from public, anon, authenticated;

select cron.schedule('platform-stats-tick', '15 0 * * *', 'select ops.platform_stats_tick()');

------------------------------------------------------------------------------------------------
-- api.platform_health
------------------------------------------------------------------------------------------------

create type api.platform_health as (
  -- Waiting to be sent: new, or failed and due for a retry.
  notifications_queued int,
  notifications_dead int,
  oldest_queued_seconds int,
  -- [{name, schedule, active, last_start, last_status}] for every pg_cron job.
  cron_jobs jsonb,
  -- Orgs with at least one join since 00:00 UTC.
  orgs_active_today int,
  as_of timestamptz
);
grant usage on type api.platform_health to authenticated;

create function api.platform_health() returns api.platform_health
language plpgsql stable security definer set search_path = '' as $$
declare
  result api.platform_health;
begin
  perform private.require_platform('support');

  select count(*) filter (where n.status in ('queued', 'failed')),
         count(*) filter (where n.status = 'dead'),
         extract(epoch from now() - min(n.created_at) filter (where n.status in ('queued', 'failed')))::int
    into result.notifications_queued, result.notifications_dead, result.oldest_queued_seconds
  from app.notifications n
  where n.status in ('queued', 'failed', 'dead');

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
           'last_start', r.start_time, 'last_status', r.status) order by j.jobname), '[]'::jsonb)
    into result.cron_jobs
  from cron.job j
  left join lateral (
    select d.start_time, d.status from cron.job_run_details d
    where d.jobid = j.jobid order by d.runid desc limit 1
  ) r on true;

  select count(distinct e.org_id) into result.orgs_active_today
  from app.visit_events e
  where e.type = 'joined'
    and e.occurred_at >= (now() at time zone 'UTC')::date::timestamp at time zone 'UTC';

  result.as_of := now();
  return result;
end $$;
comment on function api.platform_health() is
  'Support or operator (aal2). Current platform health: notifications waiting to send and dead, '
  'age of the oldest waiting one, last run and status of every pg_cron job, and how many orgs '
  'had a join today (UTC). Counts only; no tenant rows. Raises permission_denied (42501).';

revoke all on function api.platform_health() from public, anon;
grant execute on function api.platform_health() to authenticated;

------------------------------------------------------------------------------------------------
-- api.platform_stats
------------------------------------------------------------------------------------------------

create function api.platform_stats(p_from date, p_to date) returns setof app.platform_daily_stats
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'invalid_input';
  end if;
  return query
    select * from app.platform_daily_stats s
    where s.day between p_from and p_to
    order by s.day, s.org_id;
end $$;
comment on function api.platform_stats(date, date) is
  'Support or operator (aal2). The daily rollup rows (one per org with activity) for UTC days '
  'p_from..p_to inclusive, at most 367 days. Sum client-side for platform totals. Raises '
  'permission_denied (42501) or invalid_input (missing or reversed range, or too long).';

revoke all on function api.platform_stats(date, date) from public, anon;
grant execute on function api.platform_stats(date, date) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

revoke insert, update, delete, truncate on app.platform_daily_stats from authenticated, service_role;

alter table app.platform_daily_stats enable row level security;

create policy platform_daily_stats_select on app.platform_daily_stats for select to authenticated
  using ((select private.is_platform('support')));
