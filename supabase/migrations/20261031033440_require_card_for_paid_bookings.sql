-- 3-PAY8: a booking whose service has a payment policy is not confirmed until the card step succeeds.
-- Before this a guest could book and simply never call payment-intent (or press "continue without
-- paying"), which defeats no-show fees. The rule lives on the appointment row, so every way a guest
-- booking comes to exist is covered: book_appointment, and a waitlist claim flipping an offer to booked.
--   * pending_payment holds the slot (capacity was already taken) but is not 'booked', so reminders,
--     expected visits, calendar feeds and the staff day all ignore it until the card holds or is saved.
--   * app.appointments.payment_due_at is set exactly while the status is pending_payment (a trigger keeps
--     that true), so queries test the column instead of using the new enum value, which a statement
--     in the transaction that adds it cannot reference.
--   * ops.expire_unpaid_appointments cancels a pending booking past its due time and frees the slot.
--   * a payment that succeeds after its booking was cancelled or expired is released or refunded, never kept.
-- Staff bookings are exempt: no guest link exists for the guest to pay with, and staff are in the room.
-- Event seats are exempt too (an event's pricing is its own product decision; listed in #398).
-- Alternatives rejected: (1) a client-side "pay before book" flow, which any direct api call bypasses;
-- (2) keeping status 'booked' with a payment flag, which would send reminders and create expected visits
-- for unpaid bookings and needs every status = 'booked' reader patched.
-- redefines private.slot_candidates from 20261030181054_blocks_hide_slots.sql
-- redefines private.appointment_status_of from 20261030180551_event_booking_not_movable.sql
-- redefines api.guest_cancel_appointment from 20261030073002_guest_appointment_rpcs.sql
-- redefines api.staff_cancel_appointment from 20261030071001_book_appointment.sql
-- redefines api.begin_payment from 20261030220801_payment_intents.sql
-- redefines api.apply_payment_event from 20261030221627_payment_webhook.sql

alter type app.appointment_status add value if not exists 'pending_payment';

alter table app.payment_policies
  add column pay_within_minutes int not null default 15 check (pay_within_minutes between 5 and 120);
comment on column app.payment_policies.pay_within_minutes is
  'How long a guest booking stays pending_payment, holding its slot, before it expires.';
alter table app.appointments add column payment_due_at timestamptz;
create index appointments_pending_start_idx on app.appointments (starts_at) where payment_due_at is not null;
create index appointments_pending_staff_idx on app.appointments (staff_user_id, starts_at) where payment_due_at is not null;

------------------------------------------------------------------------------------------------
-- The gate: guest bookings with a payment policy start pending
------------------------------------------------------------------------------------------------

create function private.require_card_on_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pol app.payment_policies;
begin
  -- Only the moments a guest booking is born: a new row, or a waitlist offer being claimed.
  if new.status::text = 'booked' and new.source = 'guest' and new.event_id is null and new.guest_token_hash is not null
     and (tg_op = 'INSERT' or old.status::text = 'offered') then
    select * into pol from app.payment_policies x
    where x.org_id = new.org_id and x.service_id = new.service_id and x.mode <> 'none';
    if found then
      -- The cap below needs a contact to count against.
      if new.guest_phone_e164 is null and new.guest_email is null then raise exception 'invalid_input'; end if;
      -- Unpaid bookings hold slots, so one contact cannot hold more than 3 at once.
      if (select count(*) from app.appointments a
          where a.org_id = new.org_id and a.payment_due_at is not null and a.id <> new.id
            and ((new.guest_phone_e164 is not null and a.guest_phone_e164 = new.guest_phone_e164)
                 or (new.guest_email is not null and a.guest_email = new.guest_email))) >= 3 then
        raise exception 'rate_limited' using detail = 'client';
      end if;
      new.status := 'pending_payment';
    end if;
  end if;
  new.payment_due_at := case when new.status::text <> 'pending_payment' then null
                             when tg_op = 'UPDATE' and old.payment_due_at is not null then old.payment_due_at
                             else now() + make_interval(mins => coalesce(pol.pay_within_minutes, 15)) end;
  return new;
end $$;
comment on function private.require_card_on_booking() is
  'Makes a guest booking pending_payment when its service has a payment policy, and keeps payment_due_at set '
  'exactly while the status is pending_payment. Raises rate_limited (client) for a fourth unpaid booking of one contact.';
-- Named to sort before sync_appointment_visit, so a pending booking is never made an expected visit.
create trigger a_require_card before insert or update of status on app.appointments
  for each row execute function private.require_card_on_booking();

-- An unpaid payment of a cancelled booking can no longer be retried by the guest.
create function private.fail_unpaid_on_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.payments set status = 'failed', updated_at = now()
  where appointment_id = new.id and status = 'requires_action';
  return null;
end $$;
create trigger fail_unpaid_payments after update of status on app.appointments
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function private.fail_unpaid_on_cancel();

-- The card step succeeded (hold placed, deposit paid or card saved): the booking is confirmed. If the
-- booking was already cancelled or expired, the slot is gone, so a late hold is released and a late deposit refunded.
create function private.confirm_booking_on_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a app.appointments;
begin
  perform private.lock_location(new.location_id);
  select * into a from app.appointments x where x.org_id = new.org_id and x.id = new.appointment_id for update;
  if a.status::text = 'pending_payment' then
    perform private.set_actor('system', null, 'payment_confirmed');
    update app.appointments set status = 'booked' where id = a.id;
  elsif a.status = 'cancelled' then
    if new.kind = 'hold' and new.status = 'authorized' then
      perform private.enqueue_payment_release(new.id);
    elsif new.kind = 'deposit' and new.status = 'succeeded' then
      insert into app.payment_jobs (org_id, location_id, payment_id, action, amount_minor, dedupe_key)
      values (new.org_id, new.location_id, new.id, 'refund', new.amount_minor, 'refund-late:' || new.id)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;
  return null;
end $$;
create trigger confirm_booking after update of status on app.payments
  for each row when (new.appointment_id is not null and new.kind in ('hold', 'deposit', 'card_on_file') and new.status in ('authorized', 'succeeded')
                     and old.status is distinct from new.status)
  execute function private.confirm_booking_on_payment();

create function ops.expire_unpaid_appointments() returns int
language plpgsql volatile set search_path = '' as $$
declare
  a app.appointments;
  n int := 0;
begin
  perform private.set_actor('system', null, 'payment_expired');
  for a in select x.* from app.appointments x where x.payment_due_at <= now() order by x.payment_due_at limit 200 loop
    perform private.lock_location(a.location_id);
    select x.* into a from app.appointments x
    where x.id = a.id and x.payment_due_at <= now() and x.status::text = 'pending_payment' for update;
    if a.id is null then continue; end if;
    if exists (select 1 from app.payments p where p.appointment_id = a.id and p.status in ('authorized', 'succeeded', 'captured'))
       or not exists (select 1 from app.payment_policies x where x.org_id = a.org_id and x.service_id = a.service_id and x.mode <> 'none') then
      -- Paid after all (the webhook raced us), or the policy was switched off while the guest was deciding.
      update app.appointments set status = 'booked' where id = a.id;
    else
      update app.appointments set status = 'cancelled', cancelled_reason = 'payment_expired' where id = a.id returning * into a;
      perform private.release_capacity(a); -- the next waitlisted guest is offered it
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
comment on function ops.expire_unpaid_appointments() is
  'Cancels pending_payment bookings past payment_due_at that have no authorized or succeeded payment and gives '
  'their slot back; one that was paid after all, or whose service no longer asks for payment, is confirmed. Run every minute by pg_cron; returns how many expired.';
revoke all on function private.require_card_on_booking(), private.fail_unpaid_on_cancel(),
  private.confirm_booking_on_payment(), ops.expire_unpaid_appointments() from public, anon, authenticated;
select cron.schedule('expire-unpaid-appointments', '* * * * *', 'select ops.expire_unpaid_appointments()');

------------------------------------------------------------------------------------------------
-- Redefinitions: a pending booking still occupies its staff member and can be cancelled
------------------------------------------------------------------------------------------------

create or replace function private.slot_candidates(p_service_id uuid, p_from date, p_to date, p_now timestamptz default now(), p_ignore_capacity boolean default false)
returns setof private.slot_candidate
language plpgsql stable set search_path = '' as $$
declare
  s app.services;
  bp app.booking_policies;
  l app.locations;
  dur int;
  today date;
  has_rules boolean;
begin
  select * into s from app.services where id = p_service_id and active;
  select * into bp from app.booking_policies where service_id = p_service_id and bookable;
  if s.id is null or bp.id is null then return; end if;
  select * into l from app.locations where id = s.location_id;
  if not exists (select 1 from app.organizations o where o.id = l.org_id and o.status = 'active') then return; end if;
  dur := coalesce(bp.duration_minutes, s.expected_minutes);
  today := (p_now at time zone l.tz)::date;
  has_rules := exists (select 1 from app.availability_rules r
                       where r.location_id = l.id and (r.service_id is null or r.service_id = s.id));

  return query
  with days as (
    select gs::date as d from generate_series(greatest(p_from, today), least(p_to, today + bp.max_days_ahead), '1 day') gs
  ),
  biz as ( -- opening windows as instants (a window may cross midnight)
    select d.d,
           (d.d + o.opens) at time zone l.tz as w_start,
           (d.d + case when o.closes <= o.opens then 1 else 0 end + o.closes) at time zone l.tz as w_end
    from days d
    cross join lateral (
      select e.opens, e.closes from app.hours_exceptions e
      where e.location_id = l.id and e.date = d.d and not e.closed
      union all
      select h.opens, h.closes from app.business_hours h
      where h.location_id = l.id and h.weekday = extract(dow from d.d)
        and not exists (select 1 from app.hours_exceptions e where e.location_id = l.id and e.date = d.d)
    ) o
  ),
  avail as ( -- availability windows per staff member (null = any staff)
    select d.d, r.staff_user_id,
           (d.d + r.starts) at time zone l.tz as a_start,
           (d.d + case when r.ends <= r.starts then 1 else 0 end + r.ends) at time zone l.tz as a_end
    from days d join app.availability_rules r
      on r.location_id = l.id and (r.service_id is null or r.service_id = s.id)
     and r.weekday = extract(dow from d.d)
     and (r.valid_from is null or d.d >= r.valid_from) and (r.valid_to is null or d.d <= r.valid_to)
    union all
    select x.local_date, x.staff_user_id,
           (x.local_date + x.starts) at time zone l.tz,
           (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'extra' and x.local_date between p_from and p_to
  ),
  off as ( -- unavailable windows (null staff = everyone; null times = the whole day)
    select x.staff_user_id,
           tstzrange((x.local_date + coalesce(x.starts, time '00:00')) at time zone l.tz,
                     case when x.starts is null then (x.local_date + 1) at time zone l.tz
                          else (x.local_date + case when x.ends <= x.starts then 1 else 0 end + x.ends) at time zone l.tz end) as r
    from app.availability_exceptions x
    where x.location_id = l.id and x.kind = 'unavailable' and x.local_date between p_from - 1 and p_to
  ),
  rs as ( -- resources that can serve the service
    select ctr.id from app.counters ctr
    where ctr.location_id = l.id and ctr.active
      and (not exists (select 1 from app.service_resources m where m.service_id = s.id)
           or exists (select 1 from app.service_resources m where m.service_id = s.id and m.counter_id = ctr.id))
  ),
  cand as (
    select (b.w_start + m * interval '1 minute') as st,
           (b.w_start + (m + dur) * interval '1 minute') as en,
           b.d
    from biz b
    cross join lateral generate_series(bp.slot_offset_minutes,
        (extract(epoch from (b.w_end - b.w_start)) / 60)::int - dur, bp.slot_minutes) m
  ),
  checked as (
    select c.st, c.en, c.d,
      -- staff who could take the slot: covered by an availability window, not off, not double-booked
      (select coalesce(array_agg(distinct a.staff_user_id), '{}'::uuid[]) from avail a
        where a.staff_user_id is not null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en
          and not exists (select 1 from off f where (f.staff_user_id is null or f.staff_user_id = a.staff_user_id)
                          and f.r && tstzrange(c.st, c.en))
          and not exists (select 1 from app.time_blocks tb join app.counters bc on bc.id = tb.counter_id
                          where bc.location_id = l.id and bc.kind = 'staff' and bc.member_user_id = a.staff_user_id
                            and tb.during && tstzrange(c.st, c.en))
          and not exists (select 1 from app.appointments ap
                          where ap.staff_user_id = a.staff_user_id and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
                            and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
                            and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                                          ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en))
      ) as free_staff,
      exists (select 1 from avail a where a.staff_user_id is null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en) as any_staff,
      exists (select 1 from off f where f.staff_user_id is null and f.r && tstzrange(c.st, c.en)) as closed_all,
      -- 2B-A11: every resource that can do the service (its mapped resources, else all active ones at the
      -- location) is blocked during the slot.
      (exists (select 1 from rs) and not exists (
         select 1 from rs where not exists (select 1 from app.time_blocks tb
                                            where tb.counter_id = rs.id and tb.during && tstzrange(c.st, c.en)))) as blocked_all,
      (select count(*)::int from app.appointments ap
        where (bp.buffer_before_minutes > 0 or bp.buffer_after_minutes > 0)
          and ap.service_id = s.id and ap.staff_user_id is null and (ap.status in ('booked', 'checked_in') or ap.payment_due_at is not null)
          and ap.starts_at <> c.st and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
          and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                        ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en)) as overlap,
      coalesce((select cr.capacity from app.capacity_rules cr
                where cr.service_id = s.id and cr.scope = 'slot'
                  and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
                order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1), 1) as cap,
      (select cr.capacity from app.capacity_rules cr
        where cr.service_id = s.id and cr.scope = 'day'
          and (cr.local_date = c.d or (cr.local_date is null and (cr.weekday is null or cr.weekday = extract(dow from c.d))))
        order by (cr.local_date is not null) desc, (cr.weekday is not null) desc limit 1) as day_cap,
      coalesce((select n.count from app.appointment_slot_counts n where n.service_id = s.id and n.slot_start = c.st), 0) as used,
      coalesce((select n.count from app.appointment_day_counts n where n.service_id = s.id and n.local_date = c.d), 0) as day_used
    from cand c
    where c.st >= p_now + bp.min_notice_minutes * interval '1 minute'
  )
  select k.st, k.en,
         case when p_ignore_capacity then 1 else least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end)::int end,
         k.free_staff, k.any_staff
  from checked k
  where not k.closed_all and not k.blocked_all
    and (not has_rules or k.any_staff or cardinality(k.free_staff) > 0)
    and (p_ignore_capacity or least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else cardinality(k.free_staff) end) > 0)
  order by k.st;
end $$;

create or replace function private.appointment_status_of(p_a app.appointments) returns api.appointment_status
language sql stable set search_path = '' as $$
  select row(p_a.starts_at, p_a.ends_at, p_a.status::text, s.name, l.name, l.slug,
             p_a.event_id is null and p_a.status = 'booked'
               and p_a.starts_at - now() >= make_interval(mins => coalesce(bp.min_notice_minutes, 0)),
             p_a.status::text in ('booked', 'pending_payment') and p_a.starts_at > now(),
             now())::api.appointment_status
  from app.services s
  join app.locations l on l.id = p_a.location_id
  left join app.booking_policies bp on bp.service_id = p_a.service_id
  where s.id = p_a.service_id
$$;

create or replace function api.guest_cancel_appointment(p_token text, p_idempotency_key uuid) returns api.appointment_status
language plpgsql volatile security definer set search_path = '' set statement_timeout = '2s' set lock_timeout = '2s' as $$
declare a app.appointments;
begin
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  perform private.lock_location(a.location_id);
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  if a.status = 'cancelled' then return private.appointment_status_of(a); end if;
  if a.status::text not in ('booked', 'pending_payment') or a.starts_at <= now() then raise exception 'too_late_to_change'; end if;
  perform private.set_actor('guest', null, 'cancel', 'guest');
  update app.appointments set status = 'cancelled', cancelled_reason = 'guest' where id = a.id returning * into a;
  perform private.release_capacity(a);
  return private.appointment_status_of(a);
end $$;

comment on function api.guest_cancel_appointment(text, uuid) is
  'Cancels the guest''s booked or pending_payment appointment and releases its seat. Repeating is a no-op that returns the '
  'cancelled appointment. Raises not_found (unknown or expired token) and too_late_to_change (started, checked in or finished).';

create or replace function api.staff_cancel_appointment(p_appointment_id uuid, p_expected_version int, p_reason text, p_idempotency_key uuid)
returns api.appointment_row
language plpgsql volatile security definer set search_path = '' as $$
declare a app.appointments;
begin
  select * into a from app.appointments where id = p_appointment_id;
  if a.id is null or not (select private.has_role(a.org_id, a.location_id, 'staff')) then raise exception 'not_found'; end if;
  perform private.lock_location(a.location_id);
  select * into a from app.appointments where id = p_appointment_id;
  if a.status = 'cancelled' then return private.appointment_row(a); end if;
  if a.version <> p_expected_version then raise exception 'stale_visit'; end if;
  if a.status::text not in ('booked', 'pending_payment') then raise exception 'illegal_transition'; end if;
  perform private.set_actor('staff', (select auth.uid()), 'cancel', left(btrim(p_reason), 200));
  update app.appointments set status = 'cancelled', cancelled_reason = left(nullif(btrim(p_reason), ''), 200)
  where id = a.id returning * into a;
  perform private.release_capacity(a);
  return private.appointment_row(a);
end $$;

comment on function api.staff_cancel_appointment(uuid, int, text, uuid) is
  'Staff cancels a booked or pending_payment appointment and releases its capacity. Repeating is a no-op that returns the '
  'cancelled row. Raises not_found (unknown, or another org), stale_visit (version moved) and '
  'illegal_transition (already checked in, completed or no-show).';

create or replace function api.begin_payment(p_token text, p_provider text, p_idempotency_key text)
returns table (payment_id uuid, org_id uuid, kind text, amount_minor bigint, currency text, ref_id uuid, intent_id text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash bytea := private.token_hash(coalesce(p_token, ''));
  v app.visits;
  a app.appointments;
  pol app.payment_policies;
  v_org uuid;
  v_loc uuid;
  v_service uuid;
  v_starts timestamptz;
  v_kind text;
  p app.payments;
begin
  if p_token is null or length(p_token) not between 8 and 200
     or length(coalesce(p_provider, '')) not between 1 and 30
     or length(coalesce(p_idempotency_key, '')) not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  select * into a from app.appointments x where x.guest_token_hash = v_hash;
  if found then
    -- A cancelled or expired booking no longer holds a slot, so nobody can start paying for it.
    if a.status::text in ('cancelled', 'offered') or a.payment_due_at <= now() then raise exception 'not_found'; end if;
    v_org := a.org_id; v_loc := a.location_id; v_service := a.service_id; v_starts := a.starts_at;
  else
    select * into v from app.visits x where x.guest_token_hash = v_hash;
    if not found then raise exception 'not_found'; end if;
    v_org := v.org_id; v_loc := v.location_id; v_service := v.service_id;
  end if;
  select * into pol from app.payment_policies x where x.org_id = v_org and x.service_id = v_service;
  if not found or pol.mode = 'none' then raise exception 'payment_not_required'; end if;

  -- A card authorisation lasts about 7 days: hold only within 6, otherwise save the card.
  v_kind := case when pol.mode = 'deposit' then 'deposit'
                 when v_starts is null or v_starts < now() + interval '6 days' then 'hold'
                 else 'card_on_file' end;

  -- Serialize concurrent calls for one visit or appointment, so two tabs can't open two intents.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(a.id, v.id)::text, 0));
  select * into p from app.payments x
  where x.org_id = v_org and x.kind = v_kind and x.status in ('requires_action', 'authorized', 'succeeded')
    and ((a.id is not null and x.appointment_id = a.id) or (a.id is null and x.visit_id = v.id))
  order by x.created_at limit 1;
  if not found then
    insert into app.payments (org_id, location_id, visit_id, appointment_id, provider, kind, amount_minor, currency,
                              release_after, cancel_cutoff_hours, idempotency_key)
    values (v_org, v_loc, case when a.id is null then v.id end, a.id, p_provider, v_kind, pol.amount_minor, pol.currency,
            pol.release_after, pol.cancel_cutoff_hours, p_idempotency_key)
    on conflict on constraint payments_org_id_idempotency_key_key do nothing
    returning * into p;
    if p.id is null then
      -- The key was used before. It must have been for this same visit or appointment, never another's.
      select * into p from app.payments x
      where x.org_id = v_org and x.idempotency_key = p_idempotency_key
        and ((a.id is not null and x.appointment_id = a.id) or (a.id is null and x.visit_id = v.id));
      if p.id is null then raise exception 'invalid_input'; end if;
    end if;
  end if;
  return query select p.id, p.org_id, p.kind, p.amount_minor, p.currency, coalesce(a.id, v.id), p.intent_id;
end $$;

create or replace function api.apply_payment_event(
  p_org_id uuid, p_provider text, p_type text, p_object_id text, p_meta_org uuid,
  p_amount_minor bigint, p_customer_id text, p_payment_method_id text
) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p app.payments;
  v_new text;
  v_loc uuid;
  v_rank constant jsonb := '{"requires_action":0,"failed":0,"authorized":1,"succeeded":2,"captured":2,"released":3,"refunded":3}';
begin
  if p_type not in ('authorized', 'succeeded', 'canceled', 'failed', 'setup_succeeded', 'refunded') then
    raise exception 'invalid_input';
  end if;
  -- The endpoint's org is the authority; metadata written at creation must agree with it.
  if p_meta_org is not null and p_meta_org <> p_org_id then return 'org_mismatch'; end if;

  -- Location lock before the payment row: the order every appointment path uses, and confirming a booking takes it.
  select x.location_id into v_loc from app.payments x
  where x.org_id = p_org_id and x.provider = p_provider
    and (x.intent_id = p_object_id or (p_type = 'setup_succeeded' and x.setup_intent_id = p_object_id));
  if v_loc is not null then perform private.lock_location(v_loc); end if;
  select * into p from app.payments x
  where x.org_id = p_org_id and x.provider = p_provider
    and (x.intent_id = p_object_id or (p_type = 'setup_succeeded' and x.setup_intent_id = p_object_id))
  for update;
  if not found then return 'unknown_intent'; end if;

  if p_type = 'setup_succeeded' then
    update app.payments set customer_id = coalesce(customer_id, p_customer_id),
           payment_method_id = coalesce(payment_method_id, p_payment_method_id),
           status = case when status = 'requires_action' then 'authorized' else status end, updated_at = now()
    where id = p.id;
    return 'applied';
  elsif p_type = 'refunded' then
    if p.status not in ('succeeded', 'captured', 'refunded') then return 'ignored'; end if;
    update app.payments set refunded_minor = least(amount_minor, greatest(refunded_minor, coalesce(p_amount_minor, 0))),
           status = case when greatest(refunded_minor, coalesce(p_amount_minor, 0)) >= amount_minor then 'refunded' else status end,
           updated_at = now()
    where id = p.id;
    return 'applied';
  end if;

  v_new := case p_type
    when 'authorized' then 'authorized'
    when 'succeeded' then case when p.kind = 'hold' then 'captured' else 'succeeded' end
    when 'canceled' then 'released'
    else 'failed' end;
  -- A hold is only captured after it was authorized, and only an unpaid payment can be released.
  if (v_new = 'captured' and p.status <> 'authorized')
     or (v_new = 'released' and p.status not in ('requires_action', 'authorized')) then
    return 'ignored';
  end if;
  -- Forward only. A failed attempt can still be retried by the guest, so only a payment that has not
  -- progressed at all can fail.
  if (v_rank ->> v_new)::int > (v_rank ->> p.status)::int
     or (v_new = 'failed' and p.status = 'requires_action') then
    update app.payments set status = v_new, updated_at = now() where id = p.id;
    return 'applied';
  end if;
  return 'ignored';
end $$;

notify pgrst, 'reload schema';
