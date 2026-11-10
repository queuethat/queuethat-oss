-- Slot hogging in the card step: a script with many phones or +tag emails could hold slots of a paid
-- service until each 15-minute hold expired, bounded only by booking_rate_per_min (Riz, #398 batch 1).
--   * require_card_on_booking: a new guest booking that would become pending_payment is refused with
--     rate_limited (DETAIL day_holds) while its service already has 20 live unpaid holds on that local day.
--     The cap ignores the contact, so rotating phones or emails does not help; paying or expiry frees room
--     at once (holds past their due time no longer count, swept or not). It is per service and day rather
--     than per location so 20 holds cannot lock real guests out of every other day (security review).
--     A waitlist claim is exempt (the offer already held its seat).
--   * book_appointment: appended p_join_pass (default null), spent exactly as join_queue does, but only
--     when the service has a payment policy and a processor is connected, i.e. exactly when the booking
--     would be held pending. Free services and deployments without a Turnstile key need none.
-- Alternatives rejected: (1) a shorter first-booking window, which punishes real new customers and does not
-- stop a script; (2) a pass on every booking, which adds a challenge to free bookings that nothing abuses.
-- redefines private.require_card_on_booking from 20261031035601_paid_bookings_need_processor.sql
-- redefines api.book_appointment from 20261030071001_book_appointment.sql

create or replace function private.require_card_on_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pol app.payment_policies;
begin
  -- Only the moments a guest booking is born: a new row, or a waitlist offer being claimed.
  if new.status::text = 'booked' and new.source = 'guest' and new.event_id is null and new.guest_token_hash is not null
     and (tg_op = 'INSERT' or old.status::text = 'offered') then
    select * into pol from app.payment_policies x
    where x.org_id = new.org_id and x.service_id = new.service_id and x.mode <> 'none'
      and private.payments_connected(x.org_id);
    if found then
      -- The cap below needs a contact to count against.
      if new.guest_phone_e164 is null and new.guest_email is null then raise exception 'invalid_input'; end if;
      -- Unpaid bookings hold slots, so one contact cannot hold more than 3 at once.
      if (select count(*) from app.appointments a
          where a.org_id = new.org_id and a.payment_due_at > now() and a.id <> new.id
            and ((new.guest_phone_e164 is not null and a.guest_phone_e164 = new.guest_phone_e164)
                 or (new.guest_email is not null and a.guest_email = new.guest_email))) >= 3 then
        raise exception 'rate_limited' using detail = 'client';
      end if;
      -- Contacts are free to invent, so one service's holds on one local day are capped as well. Scoped to the
      -- day, not the location: 20 holds must not lock real guests out of every other day and service.
      -- book_core holds the per-location advisory lock, so this count-then-insert is serialised.
      if tg_op = 'INSERT' and (select count(*) from app.appointments a, app.locations l
          where l.id = new.location_id and a.service_id = new.service_id and a.payment_due_at > now()
            and (a.starts_at at time zone l.tz)::date = (new.starts_at at time zone l.tz)::date) >= 20 then
        raise exception 'rate_limited' using detail = 'day_holds';
      end if;
      new.status := 'pending_payment';
    end if;
  end if;
  new.payment_due_at := case when new.status::text <> 'pending_payment' then null
                             when tg_op = 'UPDATE' and old.payment_due_at is not null then old.payment_due_at
                             else now() + make_interval(mins => coalesce(pol.pay_within_minutes, 15)) end;
  return new;
end $$;

drop function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid);
create function api.book_appointment(
  p_location_slug text, p_service_id uuid, p_slot_start timestamptz, p_name text, p_phone_e164 text,
  p_email text, p_party_size int, p_locale text, p_idempotency_key uuid, p_join_pass text default null
) returns api.booking_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.locations;
  booked record;
  result api.booking_result;
begin
  select * into l from app.locations where slug = p_location_slug;
  if not found then
    select loc.* into l from app.slug_redirects r join app.locations loc on loc.id = r.location_id
    where r.old_slug = p_location_slug;
  end if;
  if l.id is null then raise exception 'not_found'; end if;
  -- A booking that would be held pending a card needs a Turnstile pass (scoped to this location and key).
  if exists (select 1 from app.payment_policies x
             where x.org_id = l.org_id and x.service_id = p_service_id and x.mode <> 'none')
     and private.payments_connected(l.org_id) then
    perform private.spend_join_pass(p_join_pass, l.id, p_idempotency_key);
  end if;
  select * into booked from private.book_core(l.id, p_service_id, p_slot_start, null, p_name, p_phone_e164,
    p_email, p_party_size, p_locale, p_idempotency_key, 'guest', 'guest', null, false);
  select private.visit_token((booked.appointment).id, p_idempotency_key), (booked.appointment).starts_at,
         (booked.appointment).ends_at, s.name, l.name, (booked.appointment).status::text
  into result from app.services s where s.id = (booked.appointment).service_id;
  return result;
end $$;
comment on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid, text) is
  'Anonymous booking of one slot returned by get_available_slots. Status, org, staff and source are '
  'derived on the server, never accepted. Idempotent per (location, p_idempotency_key): a repeat returns '
  'the same booking and token and consumes no capacity. The token is derived from the appointment and '
  'the key, stored only as sha256. When the deployment has a Turnstile site key and the service has a '
  'payment policy with a connected processor, the booking needs p_join_pass from api.issue_join_pass '
  '(unused, or spent on this same location and key as a replay); a refused booking leaves it unspent. '
  'Free services need none. Raises not_found, invalid_input, party_size_out_of_range, captcha_required, '
  'org_suspended, rate_limited (DETAIL client: this contact has 3 unpaid holds; day_holds: the '
  'service has 20 live holds that day), slot_unavailable and slot_full.';
revoke all on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid, text) from public;
grant execute on function api.book_appointment(text, uuid, timestamptz, text, text, text, int, text, uuid, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
