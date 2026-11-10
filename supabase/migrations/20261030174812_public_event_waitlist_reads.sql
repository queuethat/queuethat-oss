-- 2B-A2/A4 (#277, #279): the two reads the guest pages need. Anon has no table access (I-4), and no phase-0 stub
-- lists upcoming events or shows a waitlist entry's state, so these are added (read-only, stable).
-- Alternative rejected: widening api.get_appointment. Its return type is fixed and a waitlist entry has no
-- appointment until it is offered.

create type api.waitlist_status as (
  status text, service_name text, location_name text, location_slug text, wanted_day date,
  slot_start timestamptz, slot_end timestamptz, offer_expires_at timestamptz, as_of timestamptz
);
grant usage on type api.waitlist_status to anon, authenticated, service_role;

create function api.get_location_events(p_location_slug text) returns setof api.event_row
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare l app.locations;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null or not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then
    return;
  end if;
  return query
    select (private.event_row(e)).*
    from app.events e
    where e.location_id = l.id and e.public and e.status = 'scheduled' and upper(e.during) > now()
    order by lower(e.during), e.id
    limit 100;
end $$;
comment on function api.get_location_events(text) is
  'Upcoming public, scheduled events of a location with seats taken against capacity, earliest first (at most 100). '
  'Nothing for an unknown slug or a suspended org. No attendee data.';
revoke all on function api.get_location_events(text) from public;
grant execute on function api.get_location_events(text) to anon, authenticated, service_role;

create function api.guest_get_waitlist(p_token text) returns api.waitlist_status
language plpgsql stable security definer set search_path = '' as $$
declare
  w app.slot_waitlist;
  v_status text;
begin
  select * into w from app.slot_waitlist where token_hash = private.token_hash(p_token);
  -- unknown tokens and entries that ended more than 2 days ago answer alike
  if w.id is null or (w.status in ('claimed', 'expired', 'cancelled') and w.created_at < now() - interval '2 days'
                      and coalesce(w.offer_expires_at, w.created_at) < now() - interval '2 days') then
    raise exception 'not_found';
  end if;
  v_status := case when w.status = 'offered' and w.offer_expires_at <= now() then 'expired' else w.status::text end;
  return row(v_status, s.name, l.name, l.slug, w.wanted_day,
             case when v_status in ('offered', 'claimed') then lower(w.offered_slot) end,
             case when v_status in ('offered', 'claimed') then upper(w.offered_slot) end,
             case when v_status = 'offered' then w.offer_expires_at end, now())::api.waitlist_status
  from app.services s join app.locations l on l.id = w.location_id
  where s.id = w.service_id;
end $$;
comment on function api.guest_get_waitlist(text) is
  'The guest''s own waitlist entry: status (waiting, offered, claimed, expired, cancelled; an offer past its hold reads '
  'expired), the day wanted, names, the offered slot and hold deadline while offered or claimed, and the server time. '
  'Never includes contact data. Unknown tokens and entries over 2 days past their end raise the same not_found.';
revoke all on function api.guest_get_waitlist(text) from public;
grant execute on function api.guest_get_waitlist(text) to anon, authenticated, service_role;
