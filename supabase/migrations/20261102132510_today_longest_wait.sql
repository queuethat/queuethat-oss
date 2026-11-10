-- #1166: the owner's end-of-day numbers need the longest wait and the busiest hour of the day. Expand-only: one
-- attribute appended to api.today_stats, which clients that don't know it ignore.

alter type api.today_stats add attribute longest_wait_minutes numeric;
alter type api.today_stats add attribute busiest_hour timestamptz;

-- redefines api.today_stats from 20261025101000_today_joined.sql
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
         count(*) filter (where v.status <> 'expected'),
         round(max(extract(epoch from w.first_called_at - v.joined_at) / 60), 1)
  into result.waiting_now, result.served, result.no_shows, result.cancelled,
       result.avg_wait_minutes, result.joined, result.longest_wait_minutes
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

  -- The local hour (by joining time, as api.history_stats buckets it) the most visits came in;
  -- the earlier hour wins a tie. Null until someone has joined.
  select (date_trunc('hour', v.joined_at at time zone l.tz)) at time zone l.tz
  into result.busiest_hour
  from app.visits v
  where v.location_id = l.id and v.service_day = result.service_day and v.status <> 'expected'
  group by date_trunc('hour', v.joined_at at time zone l.tz)
  order by count(*) desc, date_trunc('hour', v.joined_at at time zone l.tz)
  limit 1;

  return result;
end $$;
comment on function api.today_stats(uuid) is
  'Counts for the location''s current service day: waiting now, served, no-shows, cancelled, '
  'joined (every visit that came in today, whatever its status now; not booked visits yet to '
  'check in), and the average and longest wait in minutes (join to first call that was not '
  'undone, one decimal; both null until someone has been called), and busiest_hour (the start of '
  'the local hour the most visits joined in, earlier on a tie; null until someone joins). Staff of the location only; raises not_found '
  'otherwise, including for display and kiosk devices.';
