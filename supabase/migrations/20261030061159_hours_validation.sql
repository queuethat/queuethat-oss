-- #89 (2A-ORG1): hours that cannot be saved ambiguous, and one function answering
-- "open at T, and when does that change".
-- redefines private.within_hours from 20261025001000_join_queue.sql

------------------------------------------------------------------------------------------------
-- Validation
------------------------------------------------------------------------------------------------

-- Two spans [start, start+len) overlap, allowing the second to be shifted by whole periods
-- (the week wraps; calendar dates do not, so they pass a period larger than any distance).
create function private.spans_overlap(a_start bigint, a_len bigint, b_start bigint, b_len bigint, p_period bigint)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from generate_series(-1, 1) k
    where a_start < b_start + b_len + k * p_period and b_start + k * p_period < a_start + a_len
  )
$$;

-- Minutes an interval lasts; closes < opens runs past midnight. Callers reject opens = closes.
create function private.interval_minutes(p_opens time, p_closes time)
returns bigint language sql immutable set search_path = '' as $$
  select ((extract(epoch from p_closes - p_opens) / 60)::bigint + 1440) % 1440
$$;

create function private.validate_business_hours() returns trigger
language plpgsql set search_path = '' as $$
declare
  o app.business_hours;
begin
  if new.opens = new.closes then raise exception 'hours_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.location_id::text, 0));
  if (select count(*) from app.business_hours b
      where b.location_id = new.location_id and b.weekday = new.weekday and b.id <> new.id) >= 3 then
    raise exception 'hours_too_many';
  end if;
  for o in select * from app.business_hours b where b.location_id = new.location_id and b.id <> new.id loop
    if private.spans_overlap(
         new.weekday * 1440 + extract(epoch from new.opens)::bigint / 60,
         private.interval_minutes(new.opens, new.closes),
         o.weekday * 1440 + extract(epoch from o.opens)::bigint / 60,
         private.interval_minutes(o.opens, o.closes), 10080) then
      raise exception 'hours_overlap';
    end if;
  end loop;
  return new;
end $$;
comment on function private.validate_business_hours() is
  'Rejects weekly hours that are empty (hours_invalid), exceed three intervals a day '
  '(hours_too_many) or overlap another interval of the location, including a cross-midnight '
  'interval spilling into the next weekday and Saturday into Sunday (hours_overlap).';

create trigger validate_business_hours before insert or update on app.business_hours
  for each row execute function private.validate_business_hours();

create function private.validate_hours_exception() returns trigger
language plpgsql set search_path = '' as $$
declare
  o app.hours_exceptions;
  a_start bigint;
begin
  if not new.closed and new.opens = new.closes then raise exception 'hours_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.location_id::text, 1));
  -- One row set per (location, date): a closed day stands alone, special hours hold up to three.
  if new.closed then
    if exists (select 1 from app.hours_exceptions e
               where e.location_id = new.location_id and e.date = new.date and e.id <> new.id) then
      raise exception 'hours_overlap';
    end if;
    return new;
  end if;
  if exists (select 1 from app.hours_exceptions e
             where e.location_id = new.location_id and e.date = new.date and e.id <> new.id and e.closed) then
    raise exception 'hours_overlap';
  end if;
  if (select count(*) from app.hours_exceptions e
      where e.location_id = new.location_id and e.date = new.date and e.id <> new.id) >= 3 then
    raise exception 'hours_too_many';
  end if;
  a_start := (new.date - date '2000-01-01') * 1440 + extract(epoch from new.opens)::bigint / 60;
  for o in select * from app.hours_exceptions e
           where e.location_id = new.location_id and e.id <> new.id and not e.closed
             and e.date between new.date - 1 and new.date + 1 loop
    if private.spans_overlap(
         a_start, private.interval_minutes(new.opens, new.closes),
         (o.date - date '2000-01-01') * 1440 + extract(epoch from o.opens)::bigint / 60,
         private.interval_minutes(o.opens, o.closes), 1000000000) then
      raise exception 'hours_overlap';
    end if;
  end loop;
  return new;
end $$;
comment on function private.validate_hours_exception() is
  'Keeps one row set per (location, date): a closed_all_day row (closed = true) is the only row '
  'of its date; special hours hold up to three non-overlapping intervals, counting the spill of '
  'a cross-midnight interval into the next date. Raises hours_invalid, hours_too_many, hours_overlap.';

create trigger validate_hours_exception before insert or update on app.hours_exceptions
  for each row execute function private.validate_hours_exception();

------------------------------------------------------------------------------------------------
-- Open-at predicate
------------------------------------------------------------------------------------------------

create function private.location_open_at(p_location_id uuid, p_at timestamptz)
returns boolean
language sql stable set search_path = '' as $$
  with here as (
    select (p_at at time zone l.tz) as local,
           exists (select 1 from app.business_hours b where b.location_id = l.id) as has_weekly
    from app.locations l
    where l.id = p_location_id
  ),
  -- Today and yesterday (local dates): yesterday's overnight period can still be running.
  days as (
    select h.local::date - k as day, k as days_back, h.local::time as t, h.has_weekly
    from here h, generate_series(0, 1) k
  ),
  periods as (
    -- A date exception replaces that date's weekly hours; closed exceptions contribute nothing.
    select d.days_back, d.t, e.opens, e.closes
    from days d
    join app.hours_exceptions e on e.location_id = p_location_id and e.date = d.day and not e.closed
    union all
    select d.days_back, d.t, b.opens, b.closes
    from days d
    join app.business_hours b on b.location_id = p_location_id and b.weekday = extract(dow from d.day)
    where not exists (select 1 from app.hours_exceptions e
                      where e.location_id = p_location_id and e.date = d.day)
    union all
    -- No weekly hours configured: open all day unless an exception says otherwise.
    select d.days_back, d.t, time '00:00', time '24:00'
    from days d
    where not d.has_weekly
      and not exists (select 1 from app.hours_exceptions e
                      where e.location_id = p_location_id and e.date = d.day)
  )
  select exists (
    select 1 from periods p
    where (p.days_back = 0 and p.t >= p.opens and (p.t < p.closes or p.closes < p.opens))
       or (p.days_back = 1 and p.closes < p.opens and p.t < p.closes)
  )
$$;
comment on function private.location_open_at(uuid, timestamptz) is
  'True when p_at falls inside the location''s opening hours in its own timezone. A location '
  'with no weekly hours is open all day. A hours_exceptions row for a local date replaces that '
  'date''s weekly hours (closed = shut all day). closes < opens runs past midnight into the next '
  'date, and belongs to the weekday it opens on. False for an unknown location. The only hours rule.';

create function private.location_next_change(p_location_id uuid, p_at timestamptz)
returns timestamptz
language sql stable set search_path = '' as $$
  with loc as (
    select l.tz, (p_at at time zone l.tz)::date as today from app.locations l where l.id = p_location_id
  ),
  days as (
    select loc.tz, loc.today + k as day from loc, generate_series(-1, 14) k
  ),
  -- Every instant the state could flip: local midnights and the start and end of each interval.
  local_edges as (
    select d.tz, d.day + t.edge as local_at
    from days d
    join lateral (
      select e.opens - time '00:00' as edge from app.hours_exceptions e
        where e.location_id = p_location_id and e.date = d.day and not e.closed
      union all
      select (e.closes - time '00:00') + case when e.closes < e.opens then interval '1 day' else interval '0' end from app.hours_exceptions e
        where e.location_id = p_location_id and e.date = d.day and not e.closed
      union all
      select b.opens - time '00:00' from app.business_hours b
        where b.location_id = p_location_id and b.weekday = extract(dow from d.day)
      union all
      select (b.closes - time '00:00') + case when b.closes < b.opens then interval '1 day' else interval '0' end from app.business_hours b
        where b.location_id = p_location_id and b.weekday = extract(dow from d.day)
      union all
      select interval '0'
    ) t on true
  ),
  -- A repeated local hour (clocks going back) resolves to its second pass, so also try an hour earlier.
  candidates as (
    select e.local_at at time zone e.tz as at from local_edges e
    union
    select (e.local_at at time zone e.tz) - interval '1 hour' from local_edges e
  )
  select min(c.at) from candidates c
  where c.at > p_at
    and private.location_open_at(p_location_id, c.at) <> private.location_open_at(p_location_id, p_at)
$$;
comment on function private.location_next_change(uuid, timestamptz) is
  'The first instant after p_at at which private.location_open_at flips, looking 14 local days '
  'ahead; null when it never does (open or shut around the clock) or the location is unknown.';

create or replace function private.within_hours(p_location_id uuid, p_at timestamptz default now())
returns boolean
language sql stable set search_path = '' as $$
  select private.location_open_at(p_location_id, p_at)
$$;
comment on function private.within_hours(uuid, timestamptz) is
  'Alias of private.location_open_at kept for the accepting predicate (queue_not_accepting_reason).';

revoke all on function
  private.spans_overlap(bigint, bigint, bigint, bigint, bigint),
  private.interval_minutes(time, time),
  private.validate_business_hours(),
  private.validate_hours_exception(),
  private.location_open_at(uuid, timestamptz),
  private.location_next_change(uuid, timestamptz)
from public, anon, authenticated;

-- The validation triggers run as the writer, so they need the two pure helpers.
grant execute on function
  private.spans_overlap(bigint, bigint, bigint, bigint, bigint),
  private.interval_minutes(time, time)
to authenticated;
