-- 2P-APT9 (#165): the day agenda. Members of the location read its appointments for a local date range.

create function api.list_appointments(p_location_id uuid, p_from date, p_to date)
returns setof api.appointment_row
language plpgsql stable security definer set search_path = '' set statement_timeout = '3s' as $$
declare l app.locations;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_input'; end if;
  if p_to - p_from > 31 then raise exception 'range_too_large'; end if;
  select * into l from app.locations where id = p_location_id;
  -- Not a member (or no such location): no rows, the same answer for both.
  if l.id is null or not (select private.has_role(l.org_id, l.id, 'staff')) then return; end if;
  return query
    select (private.appointment_row(a)).*
    from app.appointments a
    where a.location_id = l.id and a.local_date between p_from and p_to
    order by a.starts_at, a.id;
end $$;
comment on function api.list_appointments(uuid, date, date) is
  'Appointments of one location for a local date range of at most 31 days, earliest first, cancelled ones included '
  'with their status. Zero rows for anyone who is not staff at that location. Raises invalid_input and range_too_large.';
revoke all on function api.list_appointments(uuid, date, date) from public, anon;
grant execute on function api.list_appointments(uuid, date, date) to authenticated, service_role;
