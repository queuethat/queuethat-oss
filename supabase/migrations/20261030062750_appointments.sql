-- 2P-APT2 (#158): appointments data model and api.get_available_slots.
-- Appointments become expected visits in 2P-APT12 (#168). Rows change only through definer
-- functions (like visits); every change writes an appointment_events row by trigger.
-- Booking lookups are bounded to +-1 day around a candidate (buffers are capped at 8 h) so they use the
-- (service_id, starts_at) and (staff_user_id, starts_at) indexes; the anon function also has a 2 s timeout.
-- Slot semantics (also in COMMENT ON FUNCTION private.available_slots):
--   * A slot occupies [start, start + duration). Slots are anchored at each opening window's start,
--     first slot at open + slot_offset_minutes, then every slot_minutes. Windows are business hours
--     (or the date's exception) intersected with availability rules when any apply to the service.
--   * capacity: slot-scope rule (date > weekday > default of 1) minus the slot's count; the day-scope
--     rule (if any) bounds the whole local date.
--   * buffers: a booking occupies [start - buffer_before, end + buffer_after). It blocks a staff
--     member's overlapping slots and is subtracted from the capacity of overlapping slots that start
--     at a different time (same-start bookings are already in the slot count).

alter table app.booking_policies
  add constraint booking_policies_buffers_cap check (buffer_before_minutes <= 480 and buffer_after_minutes <= 480);

create type app.appointment_status as enum ('booked', 'cancelled', 'checked_in', 'no_show', 'completed');
create type api.available_slot as (slot_start timestamptz, slot_end timestamptz, remaining int);
grant usage on type api.available_slot, app.appointment_status to anon, authenticated, service_role;

create table app.appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  queue_id uuid not null,
  staff_user_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  local_date date not null,
  status app.appointment_status not null default 'booked',
  guest_name text not null check (length(btrim(guest_name)) between 1 and 60),
  guest_id uuid,
  contact_id uuid,
  guest_token_hash bytea unique, -- sha256 only; null for staff-made bookings without a link
  source text not null check (source in ('guest', 'staff')),
  visit_id uuid,
  version int not null default 0,
  idempotency_key uuid not null,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  foreign key (org_id, service_id) references app.services (org_id, id),
  foreign key (org_id, queue_id) references app.queues (org_id, id),
  foreign key (org_id, staff_user_id) references app.memberships (org_id, user_id),
  foreign key (org_id, guest_id) references app.guests (org_id, id),
  foreign key (org_id, visit_id) references app.visits (org_id, id),
  unique (org_id, id),
  unique (location_id, idempotency_key)
);
create index appointments_slot_idx on app.appointments (service_id, starts_at) where status in ('booked', 'checked_in');
create index appointments_staff_idx on app.appointments (staff_user_id, starts_at) where status in ('booked', 'checked_in');
create index appointments_day_idx on app.appointments (location_id, local_date);

create table app.appointment_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  appointment_id uuid not null,
  type text not null, -- 'booked', a status name, or 'rescheduled'
  from_status app.appointment_status,
  to_status app.appointment_status not null,
  actor_kind app.actor_kind not null,
  actor_id uuid,
  payload jsonb not null default '{}', -- never contact data
  occurred_at timestamptz not null default now(),
  foreign key (org_id, appointment_id) references app.appointments (org_id, id)
);
create index appointment_events_idx on app.appointment_events (appointment_id, id);

create table app.appointment_slot_counts (
  org_id uuid not null,
  service_id uuid not null,
  slot_start timestamptz not null,
  count int not null default 0 check (count >= 0),
  primary key (service_id, slot_start),
  foreign key (org_id, service_id) references app.services (org_id, id) on delete cascade
);
create table app.appointment_day_counts (
  org_id uuid not null,
  service_id uuid not null,
  local_date date not null,
  count int not null default 0 check (count >= 0),
  primary key (service_id, local_date),
  foreign key (org_id, service_id) references app.services (org_id, id) on delete cascade
);

create function private.guard_appointment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if nullif(current_setting('app.actor_kind', true), '') is null then
    raise exception 'missing_actor_context'
      using hint = 'Appointments change only through api.* functions, which call private.set_actor().';
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id or new.id is distinct from old.id
       or new.guest_token_hash is distinct from old.guest_token_hash then
      raise exception 'immutable_column' using errcode = '42501';
    end if;
    new.version := old.version + 1;
  end if;
  return new;
end $$;
create trigger guard_appointment before insert or update on app.appointments
  for each row execute function private.guard_appointment();

create function private.record_appointment_event() returns trigger
language plpgsql set search_path = '' as $$
declare
  kind text := nullif(current_setting('app.actor_kind', true), '');
begin
  if tg_op = 'INSERT' then
    insert into app.appointment_events (org_id, appointment_id, type, to_status, actor_kind, actor_id, payload)
    values (new.org_id, new.id, 'booked', new.status, kind::app.actor_kind,
            nullif(current_setting('app.actor_id', true), '')::uuid,
            jsonb_build_object('starts_at', new.starts_at, 'source', new.source));
  elsif new.status is distinct from old.status or new.starts_at is distinct from old.starts_at then
    insert into app.appointment_events (org_id, appointment_id, type, from_status, to_status, actor_kind, actor_id, payload)
    values (new.org_id, new.id,
            case when new.status is distinct from old.status then new.status::text else 'rescheduled' end,
            old.status, new.status, kind::app.actor_kind,
            nullif(current_setting('app.actor_id', true), '')::uuid,
            jsonb_build_object('old_starts_at', old.starts_at, 'new_starts_at', new.starts_at,
                               'reason', nullif(current_setting('app.reason', true), '')));
  end if;
  return null;
end $$;
create trigger record_appointment_event after insert or update on app.appointments
  for each row execute function private.record_appointment_event();

create function private.guard_appointment_event() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'appointment_events is append-only' using errcode = '42501';
end $$;
create trigger guard_appointment_event before update or delete on app.appointment_events
  for each row execute function private.guard_appointment_event();

revoke insert, update, delete, truncate on app.appointments, app.appointment_events,
  app.appointment_slot_counts, app.appointment_day_counts from authenticated;

do $$
declare t text;
begin
  foreach t in array array['appointments', 'appointment_events', 'appointment_slot_counts', 'appointment_day_counts'] loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;
create policy appointments_select on app.appointments for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy appointment_events_select on app.appointment_events for select to authenticated
  using (exists (select 1 from app.appointments a where a.id = appointment_id
                 and (select private.has_role(a.org_id, a.location_id, 'staff'))));
create policy appointment_slot_counts_select on app.appointment_slot_counts for select to authenticated
  using (exists (select 1 from app.services s where s.id = service_id
                 and (select private.has_role(s.org_id, s.location_id, 'staff'))));
create policy appointment_day_counts_select on app.appointment_day_counts for select to authenticated
  using (exists (select 1 from app.services s where s.id = service_id
                 and (select private.has_role(s.org_id, s.location_id, 'staff'))));

------------------------------------------------------------------------------------------------
-- Slot computation
------------------------------------------------------------------------------------------------

create function private.available_slots(p_service_id uuid, p_from date, p_to date, p_now timestamptz default now())
returns setof api.available_slot
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
      (select count(distinct a.staff_user_id) from avail a
        where a.staff_user_id is not null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en
          and not exists (select 1 from off f where (f.staff_user_id is null or f.staff_user_id = a.staff_user_id)
                          and f.r && tstzrange(c.st, c.en))
          and not exists (select 1 from app.appointments ap
                          where ap.staff_user_id = a.staff_user_id and ap.status in ('booked', 'checked_in')
                            and ap.starts_at >= c.st - interval '1 day' and ap.starts_at < c.en + interval '1 day'
                            and tstzrange(ap.starts_at - bp.buffer_before_minutes * interval '1 minute',
                                          ap.ends_at + bp.buffer_after_minutes * interval '1 minute') && tstzrange(c.st, c.en))
      ) as free_staff,
      exists (select 1 from avail a where a.staff_user_id is null and a.d = c.d and a.a_start <= c.st and a.a_end >= c.en) as any_staff,
      exists (select 1 from off f where f.staff_user_id is null and f.r && tstzrange(c.st, c.en)) as closed_all,
      (select count(*)::int from app.appointments ap
        where (bp.buffer_before_minutes > 0 or bp.buffer_after_minutes > 0)
          and ap.service_id = s.id and ap.staff_user_id is null and ap.status in ('booked', 'checked_in')
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
         least(k.cap - k.used - k.overlap,
               coalesce(k.day_cap - k.day_used, 1000000),
               case when k.any_staff or not has_rules then 1000000 else k.free_staff end)::int
  from checked k
  where not k.closed_all
    and (not has_rules or k.any_staff or k.free_staff > 0)
    and least(k.cap - k.used - k.overlap, coalesce(k.day_cap - k.day_used, 1000000),
              case when k.any_staff or not has_rules then 1000000 else k.free_staff end) > 0
  order by k.st;
end $$;
comment on function private.available_slots(uuid, date, date, timestamptz) is
  'Bookable slots of a service for local dates from..to (clamped to today and max_days_ahead): '
  'anchored at each opening window, bounded by business hours/exceptions and availability rules, '
  'minus notice, buffers and full slot/day capacity. Slots are instants, so the skipped DST hour '
  'never appears and the repeated hour yields distinct instants. Empty for non-bookable or inactive '
  'services and non-active orgs.';
revoke all on function private.available_slots(uuid, date, date, timestamptz) from public, anon, authenticated;

create function api.get_available_slots(p_location_slug text, p_service_id uuid, p_from date, p_to date)
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
  return query select * from private.available_slots(p_service_id, p_from, p_to);
end $$;
comment on function api.get_available_slots(text, uuid, date, date) is
  'Bookable slots of one service at a location for a local date range of at most 31 days: start, '
  'end and remaining seats. Contains no staff or guest data. Empty for services that are not '
  'bookable and for non-active organizations. Raises not_found (unknown location or a service of '
  'another location), range_too_large and invalid_input.';
revoke all on function api.get_available_slots(text, uuid, date, date) from public;
grant execute on function api.get_available_slots(text, uuid, date, date) to anon, authenticated, service_role;
