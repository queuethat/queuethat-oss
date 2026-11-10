-- 2B-ORG5 (#269): staff shifts (ORG-16). A shift is one tstzrange, so 22:00-02:00 and a night
-- over the DST change are single rows with a correct length in real hours. Listing groups by the
-- service day (location tz and day boundary) the shift starts in.
-- redefines private.eta_at from 20261030113000_learned_durations.sql
-- redefines api.list_shifts from 20261030162713_api_contracts_2b.sql
-- The ETA's server count moves into private.eta_servers (the one place that decides it): active
-- presence (2B-S1, #271) will slot in first, then the scheduled count, then servers_on_duty.

create extension if not exists btree_gist with schema extensions;

alter table app.queues add column use_shift_schedule boolean not null default false;
comment on column app.queues.use_shift_schedule is
  'ETA servers = staff on shift now (app.staff_shifts) when any, instead of servers_on_duty.';

create table app.staff_shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  user_id uuid not null,
  counter_id uuid,
  during tstzrange not null check (
    not isempty(during) and lower_inf(during) is false and upper_inf(during) is false
    and upper(during) - lower(during) <= interval '24 hours'),
  note text check (length(note) <= 200),
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id) on delete cascade,
  foreign key (org_id, location_id, counter_id) references app.counters (org_id, location_id, id),
  foreign key (org_id, user_id) references app.memberships (org_id, user_id) on delete cascade,
  -- One person cannot work two shifts at once, at any location.
  exclude using gist (user_id with =, during with &&)
);
create index staff_shifts_location_idx on app.staff_shifts using gist (location_id, during);

create trigger forbid_org_change before update on app.staff_shifts
  for each row execute function private.forbid_org_change();
create trigger audit_row after insert or update or delete on app.staff_shifts
  for each row execute function private.audit_row();

alter table app.staff_shifts enable row level security;
create policy staff_shifts_select on app.staff_shifts for select to authenticated
  using ((select private.has_role(org_id, location_id, 'staff')));
create policy staff_shifts_insert on app.staff_shifts for insert to authenticated
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy staff_shifts_update on app.staff_shifts for update to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')))
  with check ((select private.has_role(org_id, location_id, 'manager')));
create policy staff_shifts_delete on app.staff_shifts for delete to authenticated
  using ((select private.has_role(org_id, location_id, 'manager')));
revoke all on app.staff_shifts from public, anon, authenticated;
grant select, insert, update, delete on app.staff_shifts to authenticated;

create or replace function api.list_shifts(p_location_id uuid, p_from_day date, p_to_day date)
returns setof api.shift_row
language plpgsql stable security definer set search_path = '' as $$
declare
  org uuid;
begin
  select l.org_id into org from app.locations l where l.id = p_location_id;
  if org is null or not private.has_role(org, p_location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_from_day is null or p_to_day is null or p_to_day < p_from_day or p_to_day - p_from_day > 62 then
    raise exception 'invalid_input';
  end if;
  return query
    select s.id, s.location_id, s.user_id, s.counter_id, d.service_day,
           lower(s.during), upper(s.during), s.note
    from app.staff_shifts s
    cross join lateral (select private.service_day(s.location_id, lower(s.during)) as service_day) d
    where s.location_id = p_location_id
      and s.during && tstzrange((p_from_day - 2)::timestamptz, (p_to_day + 3)::timestamptz)
      and d.service_day between p_from_day and p_to_day
    order by lower(s.during), s.id;
end $$;
comment on function api.list_shifts(uuid, date, date) is
  'Staff shifts of a location whose start falls on a service day in [p_from_day, p_to_day] (the '
  'location''s time zone and day boundary), oldest first; a shift across midnight appears once, on '
  'the day it starts. Members of the location. Raises not_found (unknown or foreign location), '
  'invalid_input (null days, a reversed range or more than 63 days).';

create function private.scheduled_servers(p_location_id uuid, p_at timestamptz default now())
returns int
language sql stable set search_path = '' as $$
  select count(distinct s.user_id)::int
  from app.staff_shifts s
  where s.location_id = p_location_id and s.during @> p_at
$$;
comment on function private.scheduled_servers(uuid, timestamptz) is
  'People whose shift at the location covers the instant.';
revoke all on function private.scheduled_servers(uuid, timestamptz) from public, anon, authenticated;

create function private.eta_servers(p_queue_id uuid) returns int
language sql stable set search_path = '' as $$
  select case
    when q.use_shift_schedule and private.scheduled_servers(q.location_id) > 0
      then private.scheduled_servers(q.location_id)
    else q.servers_on_duty
  end
  from app.queues q where q.id = p_queue_id
$$;
comment on function private.eta_servers(uuid) is
  'How many servers the ETA divides by. Order: staff on shift now when the queue uses the shift '
  'schedule and anyone is scheduled, else servers_on_duty. Null for an unknown queue.';
revoke all on function private.eta_servers(uuid) from public, anon, authenticated;
grant execute on function private.scheduled_servers(uuid, timestamptz), private.eta_servers(uuid)
  to authenticated, service_role;

create or replace function private.eta_at(
  p_queue_id uuid,
  p_before bigint,
  out eta_state api.eta_state,
  out eta_low int,
  out eta_high int
)
language plpgsql stable set search_path = '' as $$
declare
  q app.queues;
  -- Minutes for a visit with no service: the queue's active services on average, else the
  -- services.expected_minutes default.
  v_default numeric;
  v_ahead int;
  v_ahead_work numeric;
  v_avg numeric;
  v_sd numeric;
  v_busy_work numeric;
  v_mean numeric;
  v_sigma numeric;
  v_total int;
  v_reserved numeric := 0;
  v_servers int;
begin
  select * into q from app.queues where id = p_queue_id;
  if not found then
    return;
  end if;
  if not q.show_eta then
    eta_state := 'hidden';
    return;
  end if;
  if q.manual_state = 'paused' then
    eta_state := 'paused';
    return;
  end if;
  -- Presence (2B-S1) and shifts (2B-ORG5) are resolved in private.eta_servers.
  v_servers := private.eta_servers(q.id);
  if v_servers = 0 then
    eta_state := 'unstaffed';
    return;
  end if;

  select coalesce(avg(s.expected_minutes), 10) into v_default
  from app.services s
  where s.queue_id = q.id and s.active;

  -- 2A-Q10: minutes and spread per visit are learned from history when there is enough of it.
  select count(*), coalesce(sum(coalesce(sm.minutes, v_default)), 0),
         coalesce(avg(coalesce(sm.minutes, v_default)), v_default),
         coalesce(avg(coalesce(sm.sd, 0.5 * v_default)), 0.5 * v_default)
  into v_ahead, v_ahead_work, v_avg, v_sd
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status = 'waiting'
    and (p_before is null or v.sort_key < p_before);

  -- Guests being called or served still hold a server: what is left of their expected time,
  -- but never less than a fifth of it.
  select coalesce(sum(greatest(
           0.2 * coalesce(sm.minutes, v_default),
           coalesce(sm.minutes, v_default)
             - extract(epoch from now() - coalesce(v.serving_at, v.called_at, now())) / 60)), 0)
  into v_busy_work
  from app.visits v
  left join lateral private.service_minutes(v.service_id) sm on true
  where v.queue_id = q.id and v.status in ('called', 'serving');

  -- Expected guests who will check in ahead of this one (their virtual arrival, ADR 0010, is not
  -- later than when this guest would start) take server time too. Each one found pushes the start
  -- later, so look again; three rounds settle any realistic day. Off unless the queue opts in.
  if q.eta_reserves_appointments then
    for i in 1..3 loop
      select coalesce(sum(coalesce((private.service_minutes(x.service_id)).minutes, v_default)), 0) into v_reserved
      from app.visits x
      where x.queue_id = q.id and x.status = 'expected' and x.scheduled_at is not null
        and x.scheduled_at - make_interval(mins => q.early_checkin_minutes)
            <= now() + ((v_ahead_work + v_busy_work + v_reserved) / v_servers)::float8 * interval '1 minute'
        and x.scheduled_at + make_interval(mins => q.no_show_after_minutes) > now();
    end loop;
    v_ahead_work := v_ahead_work + v_reserved;
  end if;

  -- (work ahead + busy) / servers is when the servers would clear everything ahead on average,
  -- but a guest starts as soon as one server frees after the last guest ahead has started, while
  -- the other servers are still mid-service: on average (servers - 1) / servers of half a
  -- service earlier (#548). With one server nothing changes.
  -- 2A-Q11: a manual override replaces the formula until it expires. It is the wait for the whole
  -- line, shared out by place: guest n of n waiting is told the override, earlier guests less.
  if q.wait_override_minutes is not null and q.wait_override_until > now() then
    select count(*)::int into v_total from app.visits v where v.queue_id = q.id and v.status = 'waiting';
    v_mean := q.wait_override_minutes::numeric * (v_ahead + 1) / greatest(v_total, v_ahead + 1);
    eta_low := (round(0.75 * v_mean / 5) * 5)::int;
    eta_high := greatest((ceil(1.25 * v_mean / 5) * 5)::int, eta_low + 5);
    eta_state := case when v_ahead = 0 then 'next' else 'override' end;
    return;
  end if;

  v_mean := greatest(0, (v_ahead_work + v_busy_work) / v_servers
                        - (v_servers - 1) * v_avg / (2 * v_servers));
  v_sigma := v_sd * sqrt(v_ahead + 1) / v_servers;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;

comment on function private.eta_at(uuid, bigint) is
  'The wait estimate, in minutes until service starts, for a guest placed after every waiting '
  'visit of the queue whose sort_key is below p_before (null = behind all of them). States, '
  'first match wins: hidden (show_eta off), paused, unstaffed (private.eta_servers = 0); then, while '
  'an unexpired staff override is set, next (nobody ahead) or override (the override minutes x '
  '(ahead + 1) / people waiting, +/-25%, in multiples of 5); otherwise next (nobody waiting ahead), '
  'then over_hour, uncertain or ok by private.eta_range_state. Minutes per guest are the learned '
  'median of the service (local hour, else whole day, at least 20 samples; see '
  'private.service_minutes) else services.expected_minutes, and the range widens with the learned '
  'spread. hidden, paused and unstaffed carry no numbers; the others carry low and high in multiples '
  'of 5 with high >= low + 5. All nulls for an unknown queue.';
