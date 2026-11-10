-- 2B-A11 (#286): time blocks (app.time_blocks, 2B-A9) take slots off the booking page and out of booking.
-- A slot is hidden while every resource that could serve the service is blocked (a service mapped to
-- resources uses those, else every active resource at the location); a block on a staff resource also
-- removes that person from the slot's free staff. Blocks are unconditional, so they apply with
-- p_ignore_capacity too (staff overrides of a full slot never override a block).
-- redefines private.slot_candidates from 20261030071001_book_appointment.sql
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
                          where ap.staff_user_id = a.staff_user_id and ap.status in ('booked', 'checked_in')
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
