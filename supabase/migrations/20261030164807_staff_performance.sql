-- 2B-R1 (#292): api.staff_performance. Replaces the stub body from 20261030162713_api_contracts_2b.sql;
-- the signature and api.performance_row are unchanged.
-- redefines api.staff_performance from 20261030162713_api_contracts_2b.sql
create or replace function api.staff_performance(p_location_id uuid, p_from_day date, p_to_day date, p_by text)
returns setof api.performance_row
language plpgsql stable security definer set search_path = '' as $$
declare
  loc record;
  v_manager boolean;
begin
  select l.org_id into loc from app.locations l where l.id = p_location_id;
  if loc.org_id is null or not private.has_role(loc.org_id, p_location_id, 'staff') then
    return;
  end if;
  if p_by is null or p_by not in ('staff', 'counter') or p_from_day is null or p_to_day is null
     or p_to_day < p_from_day or p_to_day - p_from_day >= 400 then
    raise exception 'invalid_input';
  end if;
  v_manager := private.has_role(loc.org_id, p_location_id, 'manager');

  return query
  with v as (
    select
      vi.id, vi.status, vi.counter_id,
      (select e.actor_id from app.visit_events e
        where e.visit_id = vi.id and e.type = 'call' and e.actor_kind = 'staff'
        order by e.id limit 1) as staff_id,
      extract(epoch from vi.finished_at - vi.serving_at) as service_s,
      extract(epoch from vi.serving_at - vi.called_at) as call_to_start_s
    from app.visits vi
    where vi.location_id = p_location_id
      and vi.service_day between p_from_day and p_to_day
      and vi.status in ('served', 'no_show')
      and not exists (select 1 from app.visit_events e
                      where e.visit_id = vi.id and e.payload ->> 'auto_closed' = 'true')
  ), g as (
    select
      case p_by when 'staff' then v.staff_id else v.counter_id end as grp_id,
      v.status, v.service_s, v.call_to_start_s
    from v
    where v_manager or v.staff_id = (select auth.uid())
  )
  select
    g.grp_id,
    case p_by
      when 'staff' then coalesce(u.raw_user_meta_data ->> 'name', u.email::text, '')
      else coalesce(c.label, '')
    end,
    (count(*) filter (where g.status = 'served'))::int,
    round(avg(g.service_s) filter (where g.status = 'served'))::int,
    round(avg(g.call_to_start_s) filter (where g.status = 'served'))::int,
    (count(*) filter (where g.status = 'no_show'))::int
  from g
  left join auth.users u on p_by = 'staff' and u.id = g.grp_id
  left join app.counters c on p_by = 'counter' and c.id = g.grp_id
  where g.grp_id is not null
  group by g.grp_id, u.raw_user_meta_data, u.email, c.label
  order by 3 desc, 2;
end $$;
comment on function api.staff_performance(uuid, date, date, text) is
  'Served and no-show counts, average service seconds (serving to finished) and average call-to-start '
  'seconds (avg_wait_sec) per staff member or counter (p_by = staff or counter) over service days '
  'p_from_day..p_to_day, attributed to the staff member who called the visit. Visits closed by '
  'rollover (auto_closed) are excluded. Managers and above see every row; staff see only their own; '
  'callers outside the location get zero rows. Raises invalid_input for another p_by or a range over 400 days.';
