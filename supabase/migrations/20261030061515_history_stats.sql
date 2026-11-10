-- 2P-RPT1 (#197): historical wait, service time and throughput per day or local hour.
-- A plain function, not a view: views run as their owner and materialized views have no RLS.
-- Only timestamps, status, queue and service are read, so results survive guest anonymization.

create type api.history_bucket as (
  bucket_start timestamptz, bucket_label text, joined int, served int, no_show int, cancelled int,
  removed int, expired int, avg_wait_s int, p50_wait_s int, p90_wait_s int, avg_service_s int
);
grant usage on type api.history_bucket to authenticated, service_role;

create function api.history_stats(
  p_location_id uuid, p_from date, p_to date, p_bucket text,
  p_queue_id uuid default null, p_service_id uuid default null
) returns setof api.history_bucket
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

  return query
  with v as (
    select
      case p_bucket
        when 'day' then v.service_day::timestamp
        else date_trunc('hour', v.joined_at at time zone loc.tz)
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
    v.local_bucket at time zone loc.tz,
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
comment on function api.history_stats(uuid, date, date, text, uuid, uuid) is
  'Counts per outcome plus average and p50/p90 wait (called_at - joined_at) and average service '
  'time (finished_at - serving_at), in seconds, bucketed by service day or by local hour of '
  'joining; visits are counted in the bucket they joined in, and empty buckets are omitted. '
  'Hour buckets are local to the location, so a DST change day has 23 or 25 hours (the repeated '
  'hour is one bucket). Managers and above of the location. p_bucket is day or hour, the range is '
  'inclusive and at most 400 days (invalid_input otherwise); permission_denied (42501) below '
  'manager, not_found for unknown or foreign locations.';

revoke all on function api.history_stats(uuid, date, date, text, uuid, uuid) from public, anon;
grant execute on function api.history_stats(uuid, date, date, text, uuid, uuid) to authenticated;
