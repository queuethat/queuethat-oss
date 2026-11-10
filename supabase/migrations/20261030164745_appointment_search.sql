-- 2B-A12 (#287): appointment search across a date range. Replaces the stub body from 20261030162713_api_contracts_2b.sql.
-- redefines api.search_appointments from 20261030162713_api_contracts_2b.sql
-- Matches guest name (trigram-indexed substring), email substring, phone suffix (4+ digits) or a booking
-- reference (the leading hex of the appointment id). The result row carries no phone or email.

create extension if not exists pg_trgm with schema extensions;
create index appointments_guest_name_trgm on app.appointments using gin (guest_name extensions.gin_trgm_ops);

create or replace function api.search_appointments(
  p_location_id uuid, p_query text, p_from date, p_to date, p_statuses text[], p_limit int default 25, p_after uuid default null
) returns setof api.appointment_search_row
language plpgsql stable security definer set search_path = '' set statement_timeout = '3s' as $$
declare
  l app.locations;
  q text := btrim(coalesce(p_query, ''));
  digits text := regexp_replace(q, '\D', '', 'g');
  like_q text;
  after_at timestamptz;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if length(q) < 2 or p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_input'; end if;
  if p_to - p_from > 366 then raise exception 'range_too_large'; end if;
  select * into l from app.locations where id = p_location_id;
  -- Not a member (or no such location): no rows, the same answer for both.
  if l.id is null or not (select private.has_role(l.org_id, l.id, 'staff')) then return; end if;
  like_q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if p_after is not null then
    select a.starts_at into after_at from app.appointments a where a.id = p_after and a.location_id = l.id;
  end if;
  return query
    select a.id, a.starts_at, a.ends_at, a.status::text, a.guest_name, s.name, null::text
    from app.appointments a
    join app.services s on s.org_id = a.org_id and s.id = a.service_id
    where a.location_id = l.id and a.local_date between p_from and p_to
      and (p_statuses is null or a.status::text = any (p_statuses))
      and (p_after is null or after_at is null or (a.starts_at, a.id) > (after_at, p_after))
      and (a.guest_name ilike like_q
           or a.guest_email ilike like_q
           or (length(digits) >= 4 and right(regexp_replace(coalesce(a.guest_phone_e164, ''), '\D', '', 'g'), length(digits)) = digits)
           or (q ~ '^[0-9a-fA-F]{6,}$' and replace(a.id::text, '-', '') ilike lower(q) || '%'))
    order by a.starts_at, a.id
    limit v_limit;
end $$;
comment on function api.search_appointments(uuid, text, date, date, text[], int, uuid) is
  'Keyset-paged appointment search (earliest first; pass the last id as p_after) over a local date range of at most '
  '366 days. Matches guest name or email substring, phone suffix of 4+ digits, or booking reference (leading hex of the id). '
  'Rows carry no phone or email. Zero rows for anyone who is not staff at that location. Raises invalid_input '
  '(query under 2 characters, bad range) and range_too_large. staff_name is null until staff display names exist.';
