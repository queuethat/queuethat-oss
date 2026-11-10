-- 2A-GST2 (#123): visits.scan_code, api.get_visit_info and api.find_visit_by_scan_code bodies.
-- Signatures and return types are those fixed by 2A-API1/2A-API2 (20261030045508_api_contracts_2a.sql).
--
-- Why a separate scan code: the status page shows a QR for staff to scan at the door. It must not
-- carry the guest token, or a photographed screen would hand over control of the visit. The code
-- identifies a visit only to staff of its location, on its service day.
--
-- Contact data and answers never appear in get_visit_info.

------------------------------------------------------------------------------------------------
-- scan_code: 10 characters of Crockford base32, unique per location
------------------------------------------------------------------------------------------------

alter table app.visits add column scan_code text;
alter table app.visits add constraint visits_scan_code_check
  check (scan_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$');

create function private.new_scan_code() returns text
language sql volatile set search_path = '' as $$
  -- 50 random bits: ten bytes taken from the random part of two v4 uuids, each reduced mod 32
  -- (256 divides evenly, so no character is likelier than another).
  select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                           1 + get_byte(case when i < 5 then r.a else r.b end, i % 5) % 32, 1), '' order by i)
  from (select uuid_send(gen_random_uuid()) as a, uuid_send(gen_random_uuid()) as b) r,
       generate_series(0, 9) i
$$;
comment on function private.new_scan_code() is
  'A fresh random scan code: 10 characters of Crockford base32 (no I, L, O or U).';

create function private.set_scan_code() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Callers cannot choose the code. A collision at one location (1 in 2^50 per pair) draws again.
  loop
    new.scan_code := private.new_scan_code();
    exit when not exists (
      select 1 from app.visits v where v.location_id = new.location_id and v.scan_code = new.scan_code);
  end loop;
  return new;
end $$;
comment on function private.set_scan_code() is
  'BEFORE INSERT on app.visits: sets scan_code, unique within the visit''s location.';
create trigger set_scan_code before insert on app.visits
  for each row execute function private.set_scan_code();

-- Backfill the visits that can still be scanned (the current service day's open ones). A system
-- actor keeps the event trail (I-1) honest about who touched the rows.
select private.set_actor('system', null, null, 'scan code backfill');
update app.visits v set scan_code = private.new_scan_code()
where v.status in ('expected', 'waiting', 'called', 'serving') and v.scan_code is null;

create unique index visits_location_scan_code_key on app.visits (location_id, scan_code)
  where scan_code is not null;

revoke all on function private.new_scan_code() from public, anon, authenticated;
revoke all on function private.set_scan_code() from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Percent-encoding for the directions link
------------------------------------------------------------------------------------------------

create function private.url_encode(p_text text) returns text
language sql immutable set search_path = '' as $$
  select string_agg(
           case when ch ~ '^[A-Za-z0-9_.~-]$' then ch
                else regexp_replace(upper(encode(convert_to(ch, 'UTF8'), 'hex')), '(..)', '%\1', 'g') end,
           '' order by n)
  from regexp_split_to_table(p_text, '') with ordinality as t(ch, n)
$$;
comment on function private.url_encode(text) is
  'RFC 3986 percent-encoding of every byte outside the unreserved set. Null for null.';
revoke all on function private.url_encode(text) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.get_visit_info
------------------------------------------------------------------------------------------------

-- redefines api.get_visit_info from 20261030045508_api_contracts_2a.sql
create or replace function api.get_visit_info(p_token text) returns api.visit_info
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
  l app.locations;
begin
  if current_setting('request.method', true) = 'GET' then
    raise exception 'invalid_input' using detail = 'use POST';
  end if;
  v := private.visit_by_token(p_token);
  select * into l from app.locations where id = v.location_id;
  return row(
    l.name,
    l.address,
    l.contact,
    case when nullif(btrim(l.address), '') is not null
         then 'https://www.google.com/maps/search/?api=1&query=' || private.url_encode(btrim(l.address)) end,
    jsonb_build_object(
      'open_now', private.location_open_at(l.id, now()),
      'next_change', private.location_next_change(l.id, now()),
      'tz', l.tz),
    (select s.name from app.services s where s.id = v.service_id),
    null::timestamptz,
    v.scan_code,
    v.group_key,
    v.locale
  )::api.visit_info;
end $$;
comment on function api.get_visit_info(text) is
  'The static details of the token''s visit: location name, address, phone (the location''s contact '
  'line), a maps directions link built from the address, hours_today as {open_now, next_change, tz} '
  '(next_change = when the location next opens or closes, null if never), service name, scheduled '
  'time (null until bookings), the scan code staff scan at the door, the party group key '
  '(null when the visit is not in a group) and locale. Live status stays in get_visit_status. Never includes the guest''s contact '
  'data, answers or other guests. Raises not_found for unknown or expired tokens, as '
  'get_visit_status does, and invalid_input for GET.';

------------------------------------------------------------------------------------------------
-- api.find_visit_by_scan_code
------------------------------------------------------------------------------------------------

-- redefines api.find_visit_by_scan_code from 20261030045508_api_contracts_2a.sql
create or replace function api.find_visit_by_scan_code(p_location_id uuid, p_code text)
returns api.visit_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits
  where location_id = p_location_id and scan_code = upper(btrim(coalesce(p_code, '')));
  -- One answer for an unknown code, another tenant's location, a past day and no access.
  if not found
     or not private.has_role(v.org_id, v.location_id, 'staff')
     or v.service_day is distinct from private.service_day(v.location_id) then
    raise exception 'not_found';
  end if;
  return private.visit_row(v.id);
end $$;
comment on function api.find_visit_by_scan_code(uuid, text) is
  'The visit of the location that carries scan code p_code (the QR a guest shows at the door), as '
  'staff see it. Staff of the location only; the code works on its own service day. Raises '
  'not_found for an unknown code, a code from an earlier day, another tenant''s location, and '
  'callers without access, all alike. Case and surrounding spaces in the code are ignored.';
