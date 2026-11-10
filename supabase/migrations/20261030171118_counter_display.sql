-- 2B-D1 (#258): counter-scoped display devices.
--
-- A display device may be bound to one counter (app.devices.counter_id). A bound device reads only
-- api.counter_display_snapshot(): its counter's label and the ticket being served there. The
-- binding is looked up from app.devices on every call, like revocation, so no JWT claim can go
-- stale and pair-device and api.create_pairing_code keep their fixed signatures. An admin binds
-- the counter after pairing with api.set_device_counter.

alter table app.devices add column counter_id uuid;
alter table app.devices add constraint devices_counter_fk
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id)
  on delete set null (counter_id);

------------------------------------------------------------------------------------------------
-- Admin: bind or unbind a display's counter
------------------------------------------------------------------------------------------------

create function api.set_device_counter(p_device_id uuid, p_counter_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  d app.devices;
begin
  select * into d from app.devices where id = p_device_id;
  if not found or not private.has_role(d.org_id, d.location_id, 'admin') then
    raise exception 'not_found';
  end if;
  if d.kind <> 'display' then
    raise exception 'invalid_input';
  end if;
  if p_counter_id is not null and not exists (
    select 1 from app.counters c
    where c.id = p_counter_id and c.org_id = d.org_id and c.location_id = d.location_id
      and c.archived_at is null
  ) then
    raise exception 'not_found';
  end if;
  update app.devices set counter_id = p_counter_id where id = d.id;
end $$;
comment on function api.set_device_counter(uuid, uuid) is
  'Binds a paired display to one counter of its location, or to none when p_counter_id is null. '
  'Setting the same value again changes nothing. Admins of the device''s location only; raises '
  'not_found for a device or counter the caller cannot see, or a counter of another location, and '
  'invalid_input for a device that is not a display.';

------------------------------------------------------------------------------------------------
-- Device: what my counter is serving
------------------------------------------------------------------------------------------------

-- redefines api.counter_display_snapshot from 20261030162713_api_contracts_2b.sql
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
      result.guest_first_name := nullif(split_part(btrim(v.guest_name), ' ', 1), '');
    end if;
  else
    result.status := 'idle';
  end if;
  return result;
end $$;
comment on function api.counter_display_snapshot() is
  'What a counter-scoped display shows: the counter label, the ticket now called or served there '
  '(latest call or recall that was not undone) and status serving, idle (nothing at the counter) or '
  'closed (counter archived). guest_first_name is the first word of the guest name only when the '
  'location enabled display names, otherwise null. The counter comes from the caller''s device row, '
  'never from an argument. Raises not_found for anyone who is not an active display bound to a counter.';

revoke all on function api.set_device_counter(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function api.set_device_counter(uuid, uuid) to authenticated;
