-- Display boards show a short guest name ("James W.") by default.
--
-- Before: a board showed ticket numbers only unless an admin turned names on, which left guests
-- without phones, added by staff, with nothing on the screen to recognise. Now new locations show
-- names by default, and what a screen gets is the short form only: the first word of the name and
-- the initial of the last word. The rest of the name never leaves the database (I-5, I-13).
-- Existing locations keep their setting. Health-tagged organizations still cannot show names.

alter table app.locations alter column display_names_enabled set default true;

-- "  james   o'neil smith " -> "james S."; "Dana" -> "Dana"; blank -> null.
create function private.display_short_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  with w as (
    select string_to_array(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), ' ') as words
  )
  select nullif(
    left(w.words[1], 24)
      || case when cardinality(w.words) > 1 and w.words[cardinality(w.words)] ~ '^[[:alpha:]]'
              then ' ' || upper(substring(w.words[cardinality(w.words)] from 1 for 1)) || '.'
              else '' end,
    '')
  from w;
$$;
comment on function private.display_short_name(text) is
  'The most of a guest name a public screen may show: the first word (at most 24 characters) and, '
  'when there is more than one word and the last begins with a letter, its capital initial and a '
  'full stop ("James W."). Null for a blank name. Pure; callers decide whether names may show.';

-- redefines private.guard_display_names from 20261030071733_industry_templates.sql
-- A new location of a health-tagged organization starts with names off instead of failing on the new
-- default; turning them on later still raises display_names_locked.
create or replace function private.guard_display_names() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.display_names_enabled
     and (select o.health_tagged from app.organizations o where o.id = new.org_id) then
    if tg_op = 'INSERT' then
      new.display_names_enabled := false;
    else
      raise exception 'display_names_locked';
    end if;
  end if;
  return new;
end $$;
comment on function private.guard_display_names() is
  'BEFORE trigger on app.locations: a health-tagged organization never shows names on the display. '
  'A new location starts with names off; turning them on raises display_names_locked.';

-- redefines api.display_snapshot from 20261025114010_display_recall_refresh.sql
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
                      then private.display_short_name(v.guest_name) end,
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
                      then private.display_short_name(v.guest_name) end,
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
  'call or recall that was not undone, so it changes on every recall and moves the ticket first. first_name is the short form of the guest name (first word and last initial, "James W.") '
  'only when the location shows names, otherwise always null; the rest of the name and every '
  'other detail of a guest is never returned. Callable by staff and paired devices of that location; raises not_found for '
  'anyone else.';

-- redefines api.counter_display_snapshot from 20261030171118_counter_display.sql
create or replace function api.counter_display_snapshot() returns api.counter_snapshot
language plpgsql stable security definer set search_path = '' as $$
declare
  d app.devices;
  l app.locations;
  c app.counters;
  result api.counter_snapshot;
  v app.visits;
begin
  select * into d from app.devices
  where auth_user_id = (select auth.uid()) and revoked_at is null and kind = 'display';
  if not found or d.counter_id is null then
    raise exception 'not_found';
  end if;
  select * into l from app.locations where id = d.location_id;
  select * into c from app.counters where id = d.counter_id;

  result.counter_label := c.label;
  result.as_of := now();
  if c.archived_at is not null then
    result.status := 'closed';
    return result;
  end if;

  select v2.* into v
  from app.visits v2
  where v2.counter_id = c.id and v2.service_day = private.service_day(l.id)
    and v2.status in ('called', 'serving')
  order by coalesce((select max(e.id) from app.visit_events e
                     where e.visit_id = v2.id and e.type in ('call', 'recall')
                       and e.undone_by_event_id is null), 0) desc, v2.id
  limit 1;

  if found then
    result.status := 'serving';
    result.ticket := v.display_ticket;
    if l.display_names_enabled then
      result.guest_first_name := private.display_short_name(v.guest_name);
    end if;
  else
    result.status := 'idle';
  end if;
  return result;
end $$;
comment on function api.counter_display_snapshot() is
  'What a counter-scoped display shows: the counter label, the ticket now called or served there '
  '(latest call or recall that was not undone) and status serving, idle (nothing at the counter) or '
  'closed (counter archived). guest_first_name is the short form of the guest name (first word and last initial, '
  '"James W.") only when the location shows names, otherwise null. The counter comes from the caller''s device row, '
  'never from an argument. Raises not_found for anyone who is not an active display bound to a counter.';
