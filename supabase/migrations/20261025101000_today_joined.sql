-- Browser run 5: a "joined today" tile on the admin dashboard (O2). Expand-only: one attribute
-- appended to api.today_stats, which clients that don't know it ignore.

alter type api.today_stats add attribute joined int;

-- redefines api.today_stats from 20261025001900_snapshots.sql
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
         round(avg(extract(epoch from w.first_called_at - v.joined_at) / 60), 1),
         -- Everyone who came in today, whatever happened next. Booked visits that haven't
         -- checked in ('expected') haven't joined yet.
         count(*) filter (where v.status <> 'expected')
  into result.waiting_now, result.served, result.no_shows, result.cancelled,
       result.avg_wait_minutes, result.joined
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
  'Counts for the location''s current service day: waiting now, served, no-shows, cancelled, '
  'joined (every visit that came in today, whatever its status now; not booked visits yet to '
  'check in), and the average wait in minutes (join to first call that was not undone, one '
  'decimal; null until someone has been called). Staff of the location only; raises not_found '
  'otherwise, including for display and kiosk devices.';
