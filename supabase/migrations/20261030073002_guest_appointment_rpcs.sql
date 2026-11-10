-- 2P-APT4 (#160): guests view, move or cancel their own appointment by link token (no account).
-- The token is the only key (I-7). An unknown token and one past its life raise the same not_found.
-- Life: until 12 h after the appointment ends, or 12 h after it was cancelled.
-- Cancelling is allowed any time before the appointment starts; moving needs the location's
-- min_notice for both the old and the new slot (too_late_to_change).

create type api.appointment_status as (starts_at timestamptz, ends_at timestamptz, status text,
                                       service_name text, location_name text, location_slug text,
                                       can_reschedule boolean, can_cancel boolean, as_of timestamptz);
grant usage on type api.appointment_status to anon, authenticated, service_role;

-- The appointment a token opens, or null (unknown or expired). Callers raise not_found on null.
create function private.appointment_by_token(p_token text) returns app.appointments
language sql stable set search_path = '' as $$
  select a.* from app.appointments a
  where a.guest_token_hash = private.token_hash(p_token)
    and now() < case when a.status = 'cancelled'
                     then coalesce((select max(e.occurred_at) from app.appointment_events e
                                    where e.appointment_id = a.id and e.to_status = 'cancelled'), a.ends_at)
                     else a.ends_at end + interval '12 hours'
$$;
revoke all on function private.appointment_by_token(text) from public, anon, authenticated;

create function private.appointment_status_of(p_a app.appointments) returns api.appointment_status
language sql stable set search_path = '' as $$
  select row(p_a.starts_at, p_a.ends_at, p_a.status::text, s.name, l.name, l.slug,
             p_a.status = 'booked' and p_a.starts_at - now() >= make_interval(mins => coalesce(bp.min_notice_minutes, 0)),
             p_a.status = 'booked' and p_a.starts_at > now(),
             now())::api.appointment_status
  from app.services s
  join app.locations l on l.id = p_a.location_id
  left join app.booking_policies bp on bp.service_id = p_a.service_id
  where s.id = p_a.service_id
$$;
revoke all on function private.appointment_status_of(app.appointments) from public, anon, authenticated;

create function api.get_appointment(p_token text) returns api.appointment_status
language plpgsql stable security definer set search_path = '' as $$
declare a app.appointments;
begin
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  return private.appointment_status_of(a);
end $$;
comment on function api.get_appointment(text) is
  'The guest''s own appointment: times, status, service and location names, whether it can still be moved '
  'or cancelled, and the server time. Never includes contact data or staff. Unknown tokens and tokens '
  'past their life (12 h after the appointment ended or was cancelled) raise the same not_found.';
revoke all on function api.get_appointment(text) from public;
grant execute on function api.get_appointment(text) to anon, authenticated, service_role;

create function api.guest_cancel_appointment(p_token text, p_idempotency_key uuid) returns api.appointment_status
language plpgsql volatile security definer set search_path = '' set statement_timeout = '2s' set lock_timeout = '2s' as $$
declare a app.appointments;
begin
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  perform private.lock_location(a.location_id);
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  if a.status = 'cancelled' then return private.appointment_status_of(a); end if;
  if a.status <> 'booked' or a.starts_at <= now() then raise exception 'too_late_to_change'; end if;
  perform private.set_actor('guest', null, 'cancel', 'guest');
  update app.appointments set status = 'cancelled', cancelled_reason = 'guest' where id = a.id returning * into a;
  perform private.release_capacity(a);
  return private.appointment_status_of(a);
end $$;
comment on function api.guest_cancel_appointment(text, uuid) is
  'Cancels the guest''s booked appointment and releases its seat. Repeating is a no-op that returns the '
  'cancelled appointment. Raises not_found (unknown or expired token) and too_late_to_change (started, '
  'checked in or finished).';
revoke all on function api.guest_cancel_appointment(text, uuid) from public;
grant execute on function api.guest_cancel_appointment(text, uuid) to anon, authenticated, service_role;

create function api.guest_reschedule_appointment(p_token text, p_new_slot_start timestamptz, p_idempotency_key uuid)
returns api.appointment_status
language plpgsql volatile security definer set search_path = '' set statement_timeout = '2s' set lock_timeout = '2s' as $$
declare
  a app.appointments;
  l app.locations;
  bp app.booking_policies;
  slot private.slot_candidate;
  v_date date;
  v_staff uuid;
begin
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  if p_new_slot_start is null or not isfinite(p_new_slot_start) then raise exception 'invalid_input'; end if;
  perform private.lock_location(a.location_id);
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  if a.starts_at = p_new_slot_start and a.status = 'booked' then return private.appointment_status_of(a); end if;
  -- A guest cannot churn one booking: at most 5 moves an hour.
  if (select count(*) from app.appointment_events e where e.appointment_id = a.id and e.type = 'rescheduled'
        and e.occurred_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited' using detail = 'client';
  end if;
  select * into bp from app.booking_policies where service_id = a.service_id;
  if a.status <> 'booked' or a.starts_at - now() < make_interval(mins => coalesce(bp.min_notice_minutes, 0)) then
    raise exception 'too_late_to_change';
  end if;

  if p_new_slot_start < now() + make_interval(mins => coalesce(bp.min_notice_minutes, 0)) then
    raise exception 'too_late_to_change';
  end if;
  select * into l from app.locations where id = a.location_id;
  -- The appointment's own seat must not count against the move; any exception below rolls this back.
  perform private.release_capacity(a);
  v_date := (p_new_slot_start at time zone l.tz)::date;
  select c.* into slot from private.slot_candidates(a.service_id, v_date - 1, v_date + 1, now(), true) c
  where c.slot_start = p_new_slot_start;
  if slot.slot_start is null then raise exception 'slot_unavailable'; end if;
  if not exists (select 1 from private.slot_candidates(a.service_id, v_date - 1, v_date + 1) c
                 where c.slot_start = p_new_slot_start) then
    raise exception 'slot_full';
  end if;

  v_staff := case when a.staff_user_id = any (slot.free_staff) then a.staff_user_id
                  when cardinality(slot.free_staff) = 0 then null
                  else (select f from unnest(slot.free_staff) f
                        order by (select count(*) from app.appointments x where x.staff_user_id = f
                                  and x.local_date = v_date and x.status in ('booked', 'checked_in')), f limit 1) end;

  perform private.set_actor('guest', null, 'reschedule', 'guest');
  update app.appointments
  set starts_at = slot.slot_start, ends_at = slot.slot_end, local_date = v_date, staff_user_id = v_staff
  where id = a.id returning * into a;
  perform private.take_capacity(a.org_id, a.service_id, a.starts_at, a.local_date);
  return private.appointment_status_of(a);
end $$;
comment on function api.guest_reschedule_appointment(text, timestamptz, uuid) is
  'Moves the guest''s booked appointment to another slot from get_available_slots: takes the new seat and '
  'releases the old one in one step, keeps the same token and writes a rescheduled event. Moving to the '
  'current slot is a no-op. Raises not_found, too_late_to_change (the current slot is inside min_notice, '
  'or the appointment is no longer booked), slot_unavailable and slot_full (nothing changes).';
revoke all on function api.guest_reschedule_appointment(text, timestamptz, uuid) from public;
grant execute on function api.guest_reschedule_appointment(text, timestamptz, uuid) to anon, authenticated, service_role;
