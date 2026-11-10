-- #529: the waiting-room TV re-highlights a recalled ticket, and refetches when the location's
-- display settings change.
--
-- api.display_snapshot: a recall keeps visits.called_at (the first call, decision 5), so the
-- board, which keys a highlight on (ticket, called_at), never flashed a recall. Now-serving
-- called_at is the latest call or recall event instead, and the list is ordered by it. Same
-- signature and return type; only the now-serving subquery and the comment change.
--
-- Location signal: turning display names on or off, or renaming the location, changes what the
-- board shows without touching a visit or queue, so boards kept the old names for up to a 30 s
-- poll. Such an update now notes every active queue of the location in private.realtime_changes,
-- and the existing commit-time flush sends the usual pulse and loc: signal (V9). Payloads are
-- unchanged: {version, now_serving} and {queue_id, visit_id: null, version} (I-5).

------------------------------------------------------------------------------------------------
-- api.display_snapshot
------------------------------------------------------------------------------------------------

-- redefines api.display_snapshot from 20261025001900_snapshots.sql
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
    select coalesce(array_agg(t.ticket order by t.call_event desc nulls last, t.id), '{}') as tickets
    from (
      select v.id, lc.id as call_event,
             row(v.display_ticket, c.label,
                 case when l.display_names_enabled
                      then nullif(split_part(btrim(v.guest_name), ' ', 1), '') end,
                 coalesce(lc.occurred_at, v.called_at))::api.display_ticket as ticket
      from app.visits v
      left join app.counters c on c.id = v.counter_id
      -- #529: the latest call or recall that was not undone. A recall keeps visits.called_at
      -- (the first call), so the TV keys and orders on this event instead.
      left join lateral (
        select e.id, e.occurred_at
        from app.visit_events e
        where e.visit_id = v.id and e.type in ('call', 'recall') and e.undone_by_event_id is null
        order by e.id desc
        limit 1
      ) lc on true
      where v.queue_id = q.id and v.service_day = v_day and v.status in ('called', 'serving')
      order by lc.id desc nulls last, v.id
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
  '5 waiting tickets in call order. A now-serving called_at is the time of the ticket''s latest '
  'call or recall that was not undone, so it changes on every recall and moves the ticket first. first_name is the first word of the guest name only when '
  'the location enabled display names, otherwise always null; nothing else about a guest is '
  'returned. Callable by staff and paired devices of that location; raises not_found for '
  'anyone else.';

------------------------------------------------------------------------------------------------
-- Signal boards when the location's display settings change
------------------------------------------------------------------------------------------------

create function private.note_location_display_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.realtime_changes (queue_id)
  select q.id from app.queues q where q.location_id = new.id and q.archived_at is null;
  return null;
end $$;
comment on function private.note_location_display_change() is
  'After a location''s name or display_names_enabled changes, notes each of its active queues so '
  'the commit-time flush sends their pulse and loc: signal and boards refetch the snapshot.';

create trigger note_display_change after update of name, display_names_enabled on app.locations
  for each row when (new.name is distinct from old.name
                     or new.display_names_enabled is distinct from old.display_names_enabled)
  execute function private.note_location_display_change();
