-- 2P-RPT2 (#198): abandonment and no-show rates, sharing access and bucketing with history_stats.
-- redefines api.history_stats from 20261030061515_history_stats.sql (access check moves to
-- private.analytics_tz; behaviour is unchanged).

/** The location's tz after the shared analytics checks; raises not_found, permission_denied, invalid_input. */
create function private.analytics_tz(p_location_id uuid, p_from date, p_to date, p_bucket text)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  loc record;
begin
  select l.org_id, l.tz into loc from app.locations l where l.id = p_location_id;
  if loc.org_id is null or not private.has_role(loc.org_id, p_location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(loc.org_id, p_location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_bucket is null or p_bucket not in ('day', 'hour') or p_from is null or p_to is null
     or p_to < p_from or p_to - p_from >= 400 then
    raise exception 'invalid_input';
  end if;
  return loc.tz;
end $$;
comment on function private.analytics_tz(uuid, date, date, text) is
  'The one access and range check behind api.history_stats and api.outcome_rates: managers and '
  'above of the location, bucket day or hour, range at most 400 days. Returns the location tz.';
revoke all on function private.analytics_tz(uuid, date, date, text) from public, anon, authenticated;

create or replace function api.history_stats(
  p_location_id uuid, p_from date, p_to date, p_bucket text,
  p_queue_id uuid default null, p_service_id uuid default null
) returns setof api.history_bucket
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := private.analytics_tz(p_location_id, p_from, p_to, p_bucket);
begin
  return query
  with v as (
    select
      case p_bucket
        when 'day' then v.service_day::timestamp
        else date_trunc('hour', v.joined_at at time zone v_tz)
      end as local_bucket,
      v.status,
      extract(epoch from v.called_at - v.joined_at) as wait_s,
      extract(epoch from v.finished_at - v.serving_at) as service_s
    from app.visits v
    where v.location_id = p_location_id
      and v.service_day between p_from and p_to
      and (p_queue_id is null or v.queue_id = p_queue_id)
      and (p_service_id is null or v.service_id = p_service_id)
  )
  select
    v.local_bucket at time zone v_tz,
    to_char(v.local_bucket, case p_bucket when 'day' then 'YYYY-MM-DD' else 'YYYY-MM-DD HH24:00' end),
    count(*)::int,
    (count(*) filter (where v.status = 'served'))::int,
    (count(*) filter (where v.status = 'no_show'))::int,
    (count(*) filter (where v.status = 'cancelled'))::int,
    (count(*) filter (where v.status = 'removed'))::int,
    (count(*) filter (where v.status = 'expired'))::int,
    round(avg(v.wait_s))::int,
    round((percentile_cont(0.5) within group (order by v.wait_s)))::int,
    round((percentile_cont(0.9) within group (order by v.wait_s)))::int,
    round(avg(v.service_s))::int
  from v
  group by v.local_bucket
  order by v.local_bucket;
end $$;

create type api.outcome_bucket as (
  bucket_start timestamptz, left_waiting int, cancelled int, abandonment_rate numeric, called int,
  no_show int, no_show_rate numeric, abandon_lt10 int, abandon_10_30 int, abandon_gt30 int
);
grant usage on type api.outcome_bucket to authenticated, service_role;

create function api.outcome_rates(p_location_id uuid, p_from date, p_to date, p_bucket text)
returns setof api.outcome_bucket
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := private.analytics_tz(p_location_id, p_from, p_to, p_bucket);
begin
  return query
  with v as (
    select
      case p_bucket
        when 'day' then v.service_day::timestamp
        else date_trunc('hour', v.joined_at at time zone v_tz)
      end as local_bucket,
      v.status,
      v.called_at is not null as was_called,
      extract(epoch from coalesce(v.called_at, v.finished_at) - v.joined_at) / 60 as waited_min
    from app.visits v
    where v.location_id = p_location_id
      and v.service_day between p_from and p_to
  )
  select
    v.local_bucket at time zone v_tz,
    (count(*) filter (where v.status not in ('expected', 'waiting', 'expired')))::int,
    (count(*) filter (where v.status = 'cancelled'))::int,
    round((count(*) filter (where v.status = 'cancelled'))::numeric
      / nullif(count(*) filter (where v.status not in ('expected', 'waiting', 'expired')), 0), 4)::numeric(5, 4),
    (count(*) filter (where v.was_called))::int,
    (count(*) filter (where v.status = 'no_show'))::int,
    round((count(*) filter (where v.status = 'no_show'))::numeric
      / nullif(count(*) filter (where v.was_called), 0), 4)::numeric(5, 4),
    (count(*) filter (where v.status = 'cancelled' and v.waited_min < 10))::int,
    (count(*) filter (where v.status = 'cancelled' and v.waited_min >= 10 and v.waited_min <= 30))::int,
    (count(*) filter (where v.status = 'cancelled' and v.waited_min > 30))::int
  from v
  group by v.local_bucket
  order by v.local_bucket;
end $$;
comment on function api.outcome_rates(uuid, date, date, text) is
  'Abandonment and no-show rates per service day or local hour of joining, with numerators and '
  'denominators. left_waiting counts visits that are no longer waiting except expired ones '
  '(served, no_show, cancelled, removed, called, serving); abandonment_rate = cancelled / '
  'left_waiting; no_show_rate = no_show / called. Rates are null when the denominator is 0. Cancelled '
  'visits are split by time waited before leaving: under 10, 10 to 30, over 30 minutes. Expired '
  '(rollover) visits are in no figure. Access, range and errors as api.history_stats.';
revoke all on function api.outcome_rates(uuid, date, date, text) from public, anon;
grant execute on function api.outcome_rates(uuid, date, date, text) to authenticated;
