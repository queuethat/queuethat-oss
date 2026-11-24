-- Extension hook for the month a location's plan has no bookings left in. Same idea as the hooks in
-- 20261112085032_extension_hooks.sql: the hook does nothing here, a deployment that limits booked
-- appointments per month replaces its body in its own migration, and api.get_available_slots is never
-- redefined by that deployment. Before this, a hosted copy of get_available_slots carried the limit and
-- had to be re-copied whenever this function changed.
--
-- Alternatives (interface rule 7): (1) keep redefining api.get_available_slots in the hosted repository:
-- two bodies of one function to keep equal, and the second one already dropped a fix once (won't);
-- (2) move the limit itself (trigger, counting, plan numbers) here: self-hosters get a cap nobody asked
-- for and the plan numbers stop being hosted-only; (3) one hook called per month with the answer a
-- boolean: no new entry point, no signature change (won).

create function private.ext_booking_month_full(p_location_id uuid, p_month date) returns boolean
language sql stable set search_path = '' as $$ select false $$;
revoke execute on function private.ext_booking_month_full(uuid, date) from public;
comment on function private.ext_booking_month_full(uuid, date) is
  'Extension hook: true when the deployment allows no more bookings at p_location_id in the local calendar '
  'month of p_month (the first day of that month). api.get_available_slots then lists no slot in that '
  'month, so a guest is not offered a time that booking would refuse. Does not stop a booking by itself. '
  'Called at most once per month of the range, never with guest data. Returns false here.';

-- redefines api.get_available_slots from 20261030062750_appointments.sql
-- (its zone conversion is the one 20261123193342_zone_fix.sql gave it: private.zone)
create or replace function api.get_available_slots(p_location_slug text, p_service_id uuid, p_from date, p_to date)
returns setof api.available_slot
language plpgsql stable security definer set search_path = '' set statement_timeout = '2s' as $$
declare l app.locations;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid_input'; end if;
  if p_to - p_from > 31 then raise exception 'range_too_large'; end if;
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null or not exists (select 1 from app.services s where s.id = p_service_id and s.location_id = l.id) then
    raise exception 'not_found';
  end if;
  -- a range spans at most two local months, so the hook is asked once per month, not per slot
  return query
    with s as (select * from private.available_slots(p_service_id, p_from, p_to)),
         m as (select distinct date_trunc('month', (s.slot_start at time zone private.zone(l.tz))::date)::date as month from s),
         f as (select m.month from m where private.ext_booking_month_full(l.id, m.month))
    select s.slot_start, s.slot_end, s.remaining from s
    where date_trunc('month', (s.slot_start at time zone private.zone(l.tz))::date)::date not in (select month from f);
end $$;
comment on function api.get_available_slots(text, uuid, date, date) is
  'Bookable slots of one service at a location for a local date range of at most 31 days: start, '
  'end and remaining seats. Contains no staff or guest data. Empty for services that are not '
  'bookable and for non-active organizations, and for any month in which the deployment allows no more '
  'bookings (private.ext_booking_month_full; never here). Raises not_found (unknown location or a '
  'service of another location), range_too_large and invalid_input.';

notify pgrst, 'reload schema';
