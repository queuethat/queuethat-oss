-- 2B-A4 (#279): a seat in an event cannot be moved by the guest (the event owns the time), so the appointment
-- page must not offer it. Cancelling stays available and gives the seats back.
-- redefines private.appointment_status_of from 20261030073002_guest_appointment_rpcs.sql
create or replace function private.appointment_status_of(p_a app.appointments) returns api.appointment_status
language sql stable set search_path = '' as $$
  select row(p_a.starts_at, p_a.ends_at, p_a.status::text, s.name, l.name, l.slug,
             p_a.event_id is null and p_a.status = 'booked'
               and p_a.starts_at - now() >= make_interval(mins => coalesce(bp.min_notice_minutes, 0)),
             p_a.status = 'booked' and p_a.starts_at > now(),
             now())::api.appointment_status
  from app.services s
  join app.locations l on l.id = p_a.location_id
  left join app.booking_policies bp on bp.service_id = p_a.service_id
  where s.id = p_a.service_id
$$;

-- The attendee list reads which bookings belong to an event and how many seats each holds (staff only; the
-- table keeps its column grants, so the token hash and idempotency key stay unreadable).
grant select (event_id, seats) on app.appointments to authenticated;
