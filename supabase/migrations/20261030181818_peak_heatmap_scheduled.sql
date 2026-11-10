-- 2B-R4 (#295): api.peak_heatmap gains scheduled_staff, the people on shift in that local hour.
-- api.heatmap_cell only gains an attribute; the function signature and existing columns are unchanged.
-- redefines api.peak_heatmap from 20261030170125_peak_heatmap.sql
alter type api.heatmap_cell add attribute scheduled_staff numeric;

create or replace function api.peak_heatmap(p_location_id uuid, p_weeks int default 8, p_target_util numeric default 0.8)
returns setof api.heatmap_cell
language plpgsql stable security definer set search_path = '' as $$
declare
  loc record;
  v_from date;
begin
  select l.org_id, l.tz into loc from app.locations l where l.id = p_location_id;
  if loc.org_id is null or not private.has_role(loc.org_id, p_location_id, 'manager') then
    return;
  end if;
  if p_weeks is null or p_weeks not between 1 and 52 or p_target_util is null
     or p_target_util <= 0 or p_target_util > 1 then
    raise exception 'invalid_input';
  end if;
  v_from := private.service_day(p_location_id) - 7 * p_weeks;

  return query
  with v as (
    select
      vi.service_day,
      (vi.joined_at at time zone loc.tz)::date as local_day,
      extract(hour from vi.joined_at at time zone loc.tz)::int as hr,
      extract(dow from vi.joined_at at time zone loc.tz)::int as dow,
      extract(epoch from vi.called_at - vi.joined_at) / 60 as wait_min,
      case when vi.status = 'served' then extract(epoch from vi.finished_at - vi.serving_at) / 60 end as service_min
    from app.visits vi
    where vi.location_id = p_location_id
      and vi.service_day >= v_from
      and vi.status in ('served', 'no_show', 'cancelled', 'removed', 'called', 'serving', 'waiting')
      and not exists (select 1 from app.visit_events e
                      where e.visit_id = vi.id and e.payload ->> 'auto_closed' = 'true')
  ), open_days as (
    -- days the location saw any visit: closed days do not dilute the averages
    select v.dow, count(distinct v.local_day) as n from v group by v.dow
  )
  select
    v.dow,
    v.hr,
    round(count(*)::numeric / o.n, 2),
    round(avg(v.wait_min), 1),
    ceil(count(*)::numeric / o.n * coalesce(percentile_cont(0.5) within group (order by v.service_min), 0)
         / 60 / p_target_util)::int,
    -- People on shift in this local hour, averaged over the days of that weekday that saw visits;
    -- null while the location has no shifts in the window at all.
    case when exists (select 1 from app.staff_shifts sh where sh.location_id = p_location_id
                        and sh.during && tstzrange(v_from::timestamp at time zone loc.tz, null)) then
      coalesce((select round(count(distinct (d.local_day, sh.user_id))::numeric / o.n, 1)
                from (select distinct v2.local_day from v v2 where v2.dow = v.dow) d
                join app.staff_shifts sh on sh.location_id = p_location_id
                 and sh.during && tstzrange((d.local_day + make_interval(hours => v.hr)) at time zone loc.tz,
                                            (d.local_day + make_interval(hours => v.hr + 1)) at time zone loc.tz)), 0)
    end
  from v
  join open_days o on o.dow = v.dow
  group by v.dow, v.hr, o.n
  order by v.dow, v.hr;
end $$;
comment on function api.peak_heatmap(uuid, int, numeric) is
  'Average arrivals and call waits (minutes) by local weekday (0 = Sunday) and hour over the last '
  'p_weeks (1..52) service days, plus suggested_staff = ceil(avg_arrivals x median service minutes / 60 '
  '/ p_target_util), 0 where no served visit gives a service time. Hours use the location tz, so DST '
  'weeks land in the right local hour. Averages divide by the days of that weekday that saw any visit. '
  'scheduled_staff is the average number of people on shift in that hour, null when the location has no '
  'shifts in the window. Visits closed by rollover (auto_closed) are excluded. Managers and above only; others get zero rows. '
  'Raises invalid_input for p_weeks outside 1..52 or p_target_util outside (0, 1].';
