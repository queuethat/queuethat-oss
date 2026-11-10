-- 2A-Q10 (#109): the ETA learns how long each service really takes (W-2).
-- redefines private.eta_at from 20261030110501_unified_fairness.sql
-- SQL only: per service, and per local hour of the day, the median and quartiles of the last 28
-- service days, refreshed every 15 minutes. A service with fewer than 20 samples keeps its
-- expected_minutes. private.visit_eta, queue_eta and every signature stay as they were.

create table private.service_duration_stats (
  service_id uuid not null references app.services (id) on delete cascade,
  -- Local hour of serving_at (0-23) in the location's time zone; null = the whole day.
  hour_bucket smallint check (hour_bucket between 0 and 23),
  samples int not null check (samples > 0),
  median_minutes numeric not null,
  p25 numeric not null,
  p75 numeric not null,
  refreshed_at timestamptz not null default now()
);
create unique index service_duration_stats_key on private.service_duration_stats (service_id, coalesce(hour_bucket, -1));
comment on table private.service_duration_stats is
  'Learned service durations (W-2). Written only by ops.refresh_duration_stats; read by private.service_minutes. Not exposed.';
revoke all on private.service_duration_stats from public, anon, authenticated;

create function ops.refresh_duration_stats() returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  delete from private.service_duration_stats;
  insert into private.service_duration_stats (service_id, hour_bucket, samples, median_minutes, p25, p75)
  select d.service_id, d.hb::smallint, count(*)::int,
         percentile_cont(0.5) within group (order by d.minutes),
         percentile_cont(0.25) within group (order by d.minutes),
         percentile_cont(0.75) within group (order by d.minutes)
  from (
    select v.service_id,
           extract(hour from v.serving_at at time zone l.tz)::int as hb,
           extract(epoch from v.finished_at - v.serving_at) / 60 as minutes
    from app.visits v
    join app.locations l on l.id = v.location_id
    where v.status = 'served' and v.service_id is not null
      and v.serving_at is not null and v.finished_at > v.serving_at
      and v.finished_at - v.serving_at <= interval '4 hours'
      and v.service_day >= private.service_day(v.location_id) - 27
      -- Rollover closes a forgotten serving visit at day end: that is not a duration.
      and not exists (select 1 from app.visit_events e
                      where e.visit_id = v.id and e.payload ->> 'auto_closed' = 'true')
  ) d
  group by grouping sets ((d.service_id, d.hb), (d.service_id));
  get diagnostics n = row_count;
  return n;
end $$;
comment on function ops.refresh_duration_stats() is
  'Rebuilds private.service_duration_stats from served visits of the last 28 service days (duration '
  'finished_at - serving_at; rollover auto-closed visits and durations over 4 hours are left out), '
  'per service for the whole day and per local hour of serving_at. Returns the rows written. Run by '
  'pg_cron every 15 minutes; safe to run at any time.';
revoke all on function ops.refresh_duration_stats() from public, anon, authenticated;
select cron.schedule('refresh-duration-stats', '*/15 * * * *', 'select ops.refresh_duration_stats()');

/**
 * Minutes one guest of a service takes at p_at, and the spread of that: the median and
 * (p75 - p25) / 1.35 of the local hour when it has 20 or more samples, else of the whole day when
 * it has, else expected_minutes and half of it. Null for a visit with no service.
 */
create function private.service_minutes(p_service_id uuid, p_at timestamptz default now(), out minutes numeric, out sd numeric)
language plpgsql stable set search_path = '' as $$
begin
  select st.median_minutes, (st.p75 - st.p25) / 1.35 into minutes, sd
  from private.service_duration_stats st
  join app.services s on s.id = st.service_id
  join app.locations l on l.id = s.location_id
  where st.service_id = p_service_id and st.samples >= 20
    and (st.hour_bucket is null or st.hour_bucket = extract(hour from p_at at time zone l.tz))
  order by st.hour_bucket nulls last
  limit 1;
  if found then
    sd := greatest(sd, 0.1 * minutes);
    return;
  end if;
  select s.expected_minutes, 0.5 * s.expected_minutes into minutes, sd from app.services s where s.id = p_service_id;
end $$;
comment on function private.service_minutes(uuid, timestamptz) is
  'Typical minutes per guest of a service at p_at and its standard deviation: learned (hour bucket, '
  'then whole day, each with at least 20 samples) else expected_minutes and half of it. Both null for an unknown service.';

create or replace function private.eta_at(
  p_queue_id uuid,
  p_before bigint,
  out eta_state api.eta_state,
  out eta_low int,
  out eta_high int
)
language plpgsql stable set search_path = '' as $$
declare
  q app.queues;
  -- Minutes for a visit with no service: the queue's active services on average, else the
  -- services.expected_minutes default.
  v_default numeric;
  v_ahead int;
  v_ahead_work numeric;
  v_avg numeric;
  v_sd numeric;
  v_busy_work numeric;
  v_mean numeric;
  v_sigma numeric;
  v_total int;
  v_reserved numeric := 0;
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return;
  end if;
  if not q.show_eta then
    eta_state := 'hidden';
    return;
  end if;
  if q.manual_state = 'paused' then
    eta_state := 'paused';
    return;
  end if;
  -- Counter sessions do not exist yet; when they do, active sessions replace servers_on_duty here.
  if q.servers_on_duty = 0 then
    eta_state := 'unstaffed';
    return;
  end if;

  select coalesce(avg(s.expected_minutes), 10) into v_default
  from app.services s
  where s.queue_id = q.id and s.active;

  -- 2A-Q10: minutes and spread per visit are learned from history when there is enough of it.
  select count(*), coalesce(sum(coalesce(sm.minutes, v_default)), 0),
         coalesce(avg(coalesce(sm.minutes, v_default)), v_default),
         coalesce(avg(coalesce(sm.sd, 0.5 * v_default)), 0.5 * v_default)
  into v_ahead, v_ahead_work, v_avg, v_sd
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status = 'waiting'
    and (p_before is null or v.sort_key < p_before);

  -- Guests being called or served still hold a server: what is left of their expected time,
  -- but never less than a fifth of it.
  select coalesce(sum(greatest(
           0.2 * coalesce(sm.minutes, v_default),
           coalesce(sm.minutes, v_default)
             - extract(epoch from now() - coalesce(v.serving_at, v.called_at, now())) / 60)), 0)
  into v_busy_work
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status in ('called', 'serving');

  -- Expected guests who will check in ahead of this one (their virtual arrival, ADR 0010, is not
  -- later than when this guest would start) take server time too. Each one found pushes the start
  -- later, so look again; three rounds settle any realistic day. Off unless the queue opts in.
  if q.eta_reserves_appointments then
    for i in 1..3 loop
      select coalesce(sum(coalesce((private.service_minutes(x.service_id)).minutes, v_default)), 0) into v_reserved
      from app.visits x
      where x.queue_id = q.id and x.status = 'expected' and x.scheduled_at is not null
        and x.scheduled_at - make_interval(mins => q.early_checkin_minutes)
            <= now() + ((v_ahead_work + v_busy_work + v_reserved) / q.servers_on_duty)::float8 * interval '1 minute'
        and x.scheduled_at + make_interval(mins => q.no_show_after_minutes) > now();
    end loop;
    v_ahead_work := v_ahead_work + v_reserved;
  end if;

  -- (work ahead + busy) / servers is when the servers would clear everything ahead on average,
  -- but a guest starts as soon as one server frees after the last guest ahead has started, while
  -- the other servers are still mid-service: on average (servers - 1) / servers of half a
  -- service earlier (#548). With one server nothing changes.
  -- 2A-Q11: a manual override replaces the formula until it expires. It is the wait for the whole
  -- line, shared out by place: guest n of n waiting is told the override, earlier guests less.
  if q.wait_override_minutes is not null and q.wait_override_until > now() then
    select count(*)::int into v_total from app.visits v where v.queue_id = q.id and v.status = 'waiting';
    v_mean := q.wait_override_minutes::numeric * (v_ahead + 1) / greatest(v_total, v_ahead + 1);
    eta_low := (round(0.75 * v_mean / 5) * 5)::int;
    eta_high := greatest((ceil(1.25 * v_mean / 5) * 5)::int, eta_low + 5);
    eta_state := case when v_ahead = 0 then 'next' else 'override' end;
    return;
  end if;

  v_mean := greatest(0, (v_ahead_work + v_busy_work) / q.servers_on_duty
                        - (q.servers_on_duty - 1) * v_avg / (2 * q.servers_on_duty));
  v_sigma := v_sd * sqrt(v_ahead + 1) / q.servers_on_duty;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;

comment on function private.eta_at(uuid, bigint) is
  'The wait estimate, in minutes until service starts, for a guest placed after every waiting '
  'visit of the queue whose sort_key is below p_before (null = behind all of them). States, '
  'first match wins: hidden (show_eta off), paused, unstaffed (servers_on_duty = 0); then, while '
  'an unexpired staff override is set, next (nobody ahead) or override (the override minutes x '
  '(ahead + 1) / people waiting, +/-25%, in multiples of 5); otherwise next (nobody waiting ahead), '
  'then over_hour, uncertain or ok by private.eta_range_state. Minutes per guest are the learned '
  'median of the service (local hour, else whole day, at least 20 samples; see '
  'private.service_minutes) else services.expected_minutes, and the range widens with the learned '
  'spread. hidden, paused and unstaffed carry no numbers; the others carry low and high in multiples '
  'of 5 with high >= low + 5. All nulls for an unknown queue.';
