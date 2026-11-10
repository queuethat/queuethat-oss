-- V10 (#39): the two read models, api.display_snapshot (waiting-room TV, D-1, D-3) and
-- api.today_stats (today dashboard, R-1). Signatures, return types and grants are from S5
-- (20261025000600_api_contracts.sql); this file only replaces the bodies.
--
-- Both read the location's current service day only, so yesterday's leftovers never show on the
-- TV or in today's counts. The display is the one place that decides what a public screen may
-- show: ticket and counter always, a first name only when the location opted in.

------------------------------------------------------------------------------------------------
-- api.display_snapshot
------------------------------------------------------------------------------------------------

create or replace function api.display_snapshot(p_location_id uuid) returns api.display_snapshot
language plpgsql stable security definer set search_path = '' as $$
declare
  -- How many waiting tickets the TV lists per queue, and the cap on tickets shown as called.
  c_next_up constant int := 5;
  c_now_serving constant int := 10;
  l app.locations;
  v_day date;
  result api.display_snapshot;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not (private.has_role(l.org_id, l.id, 'staff') or private.is_device(l.org_id, l.id)) then
    raise exception 'not_found';
  end if;
  v_day := private.service_day(l.id);

  result.location_id := l.id;
  result.location_name := l.name;
  result.names_enabled := l.display_names_enabled;
  result.as_of := now();
  select coalesce(array_agg(row(q.id, q.name, q.manual_state, ns.tickets, nu.tickets)::api.display_queue
                            order by q.sort_order, q.name, q.id), '{}')
  into result.queues
  from app.queues q
  cross join lateral (
    select coalesce(array_agg(t.ticket order by t.called_at desc, t.id), '{}') as tickets
    from (
      select v.id, v.called_at,
             row(v.display_ticket, c.label,
                 case when l.display_names_enabled
                      then nullif(split_part(btrim(v.guest_name), ' ', 1), '') end,
                 v.called_at)::api.display_ticket as ticket
      from app.visits v
      left join app.counters c on c.id = v.counter_id
      where v.queue_id = q.id and v.service_day = v_day and v.status in ('called', 'serving')
      order by v.called_at desc, v.id
      limit c_now_serving
    ) t
  ) ns
  cross join lateral (
    select coalesce(array_agg(t.ticket order by t.sort_key, t.id), '{}') as tickets
    from (
      select v.id, v.sort_key,
             row(v.display_ticket, null,
                 case when l.display_names_enabled
                      then nullif(split_part(btrim(v.guest_name), ' ', 1), '') end,
                 null)::api.display_ticket as ticket
      from app.visits v
      where v.queue_id = q.id and v.service_day = v_day and v.status = 'waiting'
      order by v.sort_key, v.id
      limit c_next_up
    ) t
  ) nu
  where q.location_id = l.id and q.archived_at is null;

  return result;
end $$;
comment on function api.display_snapshot(uuid) is
  'What the waiting-room TV shows for the location''s current service day: per active queue, '
  'now serving (called or serving tickets, latest call first, with counter label) and the next '
  '5 waiting tickets in call order. first_name is the first word of the guest name only when '
  'the location enabled display names, otherwise always null; nothing else about a guest is '
  'returned. Callable by staff and paired devices of that location; raises not_found for '
  'anyone else.';

------------------------------------------------------------------------------------------------
-- api.today_stats
------------------------------------------------------------------------------------------------

create or replace function api.today_stats(p_location_id uuid) returns api.today_stats
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  result api.today_stats;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not private.has_role(l.org_id, l.id, 'staff') then
    raise exception 'not_found';
  end if;

  result.location_id := l.id;
  result.service_day := private.service_day(l.id);
  result.as_of := now();
  select count(*) filter (where v.status = 'waiting'),
         count(*) filter (where v.status = 'served'),
         count(*) filter (where v.status = 'no_show'),
         count(*) filter (where v.status = 'cancelled'),
         round(avg(extract(epoch from w.first_called_at - v.joined_at) / 60), 1)
  into result.waiting_now, result.served, result.no_shows, result.cancelled, result.avg_wait_minutes
  from app.visits v
  -- A wait ends at the visit's first call that was not undone; a requeue and second call does
  -- not restart it. Visits never called have no wait yet and are left out of the average.
  left join lateral (
    select min(e.occurred_at) as first_called_at
    from app.visit_events e
    where e.visit_id = v.id and e.from_status = 'waiting' and e.to_status = 'called'
      and e.undone_by_event_id is null
  ) w on true
  where v.location_id = l.id and v.service_day = result.service_day;

  return result;
end $$;
comment on function api.today_stats(uuid) is
  'Counts for the location''s current service day: waiting now, served, no-shows, cancelled, and '
  'the average wait in minutes (join to first call that was not undone, one decimal; null until '
  'someone has been called). Staff of the location only; raises not_found otherwise, including '
  'for display and kiosk devices.';
