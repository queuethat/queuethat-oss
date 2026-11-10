-- 2P-CRM2 (#185): guest search, profile and repeat-guest badges (C-3).
--
-- Phone search is a bulk-exfiltration risk, so search needs 3+ characters, returns at most 25
-- rows, shows masked contacts and requires staff membership of the location. The composite types
-- of fixed phase-1 RPCs are untouched; repeat-guest badges come from a separate batched RPC.

create type api.guest_summary as (
  guest_id uuid, name text, masked_contact text, visit_count int, last_visit_at timestamptz
);
create type api.guest_profile as (
  guest_id uuid, name text, contacts jsonb, visits jsonb, appointments jsonb,
  visit_count int, first_visit_at timestamptz, last_visit_at timestamptz
);
create type api.guest_badge as (
  visit_id uuid, visit_count int, last_visit_at timestamptz, is_repeat boolean
);

-- '+14155550123' -> '+•••••••0123', 'jane@example.com' -> 'j•••@example.com'.
create function private.mask_contact(p_channel app.contact_channel, p_value text) returns text
language sql immutable set search_path = '' as $$
  select case p_channel
    when 'phone' then '+' || repeat('•', greatest(length(p_value) - 5, 3)) || right(p_value, 4)
    else left(p_value, 1) || '•••' || substr(p_value, strpos(p_value, '@'))
  end
$$;

create function api.search_guests(p_location_id uuid, p_query text)
returns setof api.guest_summary
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.locations;
  v_q text := btrim(p_query);
  v_like text;
  v_digits text;
begin
  select * into l from app.locations where id = p_location_id;
  if not found or not private.has_role(l.org_id, l.id, 'staff') then
    raise exception 'not_found';
  end if;
  if length(coalesce(v_q, '')) < 3 then
    raise exception 'query_too_short';
  end if;
  v_like := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');

  return query
  select g.id, g.first_name,
         (select private.mask_contact(c.channel, c.value) from app.guest_contacts c
          where c.guest_id = g.id order by c.created_at limit 1),
         s.n, s.last_at
  from app.guests g
  cross join lateral (
    select count(*)::int as n, max(v.joined_at) as last_at from app.visits v where v.guest_id = g.id
  ) s
  where g.org_id = l.org_id and g.anonymized_at is null
    and (lower(g.first_name) like v_like
         or exists (
           select 1 from app.guest_contacts c
           where c.guest_id = g.id
             and ((c.channel = 'email' and c.value like v_like)
                  or (c.channel = 'phone' and length(v_digits) >= 4 and v_digits = right(c.value, length(v_digits))))))
  order by s.last_at desc nulls last, g.first_name
  limit 25;
end $$;
comment on function api.search_guests(uuid, text) is
  'Guests of the location''s org whose first name or email starts with the query, or whose phone '
  'ends with its digits (4 or more); staff or above of the location. At most 25, newest visit '
  'first, contacts masked, anonymized guests never. Raises not_found for a location outside the '
  'caller''s orgs, query_too_short under 3 characters. Implemented in 2P-CRM2 (#185).';

create function api.get_guest(p_guest_id uuid) returns api.guest_profile
language plpgsql stable security definer set search_path = '' as $$
declare
  g app.guests;
  r api.guest_profile;
begin
  select * into g from app.guests where id = p_guest_id and anonymized_at is null;
  if not found or not private.has_role(g.org_id, null, 'staff') then
    raise exception 'not_found';
  end if;
  r.guest_id := g.id;
  r.name := g.first_name;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'channel', c.channel, 'value', c.value,
                                               'verified', c.verified_at is not null) order by c.created_at), '[]')
    into r.contacts
  from app.guest_contacts c where c.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object('visit_id', x.id, 'status', x.status, 'service', x.service_name,
                                               'location_id', x.location_id, 'joined_at', x.joined_at,
                                               'finished_at', x.finished_at) order by x.joined_at desc), '[]')
    into r.visits
  from (
    select v.id, v.status, sv.name as service_name, v.location_id, v.joined_at, v.finished_at
    from app.visits v left join app.services sv on sv.id = v.service_id
    where v.guest_id = g.id order by v.joined_at desc limit 50
  ) x;
  select count(*)::int, min(v.joined_at), max(v.joined_at)
    into r.visit_count, r.first_visit_at, r.last_visit_at
  from app.visits v where v.guest_id = g.id;
  select coalesce(jsonb_agg(jsonb_build_object('appointment_id', x.id, 'status', x.status, 'service', x.service_name,
                                               'starts_at', x.starts_at) order by x.starts_at desc), '[]')
    into r.appointments
  from (
    select a.id, a.status, sv.name as service_name, a.starts_at
    from app.appointments a left join app.services sv on sv.id = a.service_id
    where a.guest_id = g.id order by a.starts_at desc limit 50
  ) x;
  return r;
end $$;
comment on function api.get_guest(uuid) is
  'A guest''s profile: contacts (full values; clients mask them), their last 50 visits newest '
  'first, appointments and counts; staff or above of the org. Raises not_found for a guest of '
  'another org or an anonymized one. Implemented in 2P-CRM2 (#185).';

create function api.guest_badges(p_visit_ids uuid[]) returns setof api.guest_badge
language plpgsql stable security definer set search_path = '' as $$
begin
  if cardinality(p_visit_ids) > 200 then
    raise exception 'invalid_input';
  end if;
  return query
  select v.id, s.n, s.last_at, s.n > 1
  from app.visits v
  cross join lateral (
    select count(*)::int as n, max(h.joined_at) as last_at from app.visits h where h.guest_id = v.guest_id
  ) s
  where v.id = any (p_visit_ids) and v.guest_id is not null
    and private.has_role(v.org_id, v.location_id, 'staff');
end $$;
comment on function api.guest_badges(uuid[]) is
  'Per visit: how many visits its guest has had (this one included), the latest, and whether '
  'they are a repeat guest. Only visits the caller is staff for and that are linked to a guest '
  'appear, so foreign ids return nothing. At most 200 ids, else invalid_input. Implemented in '
  '2P-CRM2 (#185).';

revoke all on function api.search_guests(uuid, text), api.get_guest(uuid), api.guest_badges(uuid[])
  from public, anon;
grant execute on function api.search_guests(uuid, text), api.get_guest(uuid), api.guest_badges(uuid[])
  to authenticated;
revoke all on function private.mask_contact(app.contact_channel, text) from public, anon, authenticated;
