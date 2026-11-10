-- 2P-APT13 (#169): unified list fairness (ADR 0010). Checked-in appointments and walk-ins sort by
-- virtual arrival; a walk-in over its max delay goes before appointments in call_next; ETA can
-- reserve time for expected guests who will check in ahead.

alter table app.queues
  add column early_checkin_minutes int not null default 10 check (early_checkin_minutes between 0 and 240),
  add column max_walkin_delay_minutes int not null default 15 check (max_walkin_delay_minutes between 0 and 240),
  -- The simulator (scripts/simulate-day.ts --scenario mixed) says quoting with reserved time is worse on
  -- average, so it is a queue choice, off by default.
  add column eta_reserves_appointments boolean not null default false;

/** When a waiting visit entered the line for ordering: joined_at for walk-ins, else its check-in time moved by early/late rules. */
create function private.virtual_arrival(p_visit app.visits, p_tolerance int, p_early int) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_visit.scheduled_at is null then p_visit.joined_at
              when c.at > p_visit.scheduled_at + make_interval(mins => p_tolerance) then c.at
              else least(c.at, p_visit.scheduled_at - make_interval(mins => p_early)) end
  from (select coalesce((select max(e.occurred_at) from app.visit_events e
                         where e.visit_id = p_visit.id and e.type = 'check_in'), p_visit.joined_at) as at) c
$$;
comment on function private.virtual_arrival(app.visits, int, int) is
  'The time a waiting visit sorts by (ADR 0010). Not exposed.';
revoke all on function private.virtual_arrival(app.visits, int, int) from public, anon, authenticated;

-- redefines private.check_in_place from 20261030085100_check_in.sql
create or replace function private.check_in_place(p_visit app.visits, out new_sort_key bigint, out late boolean)
language plpgsql volatile set search_path = '' as $$
declare
  v_tolerance int;
  v_early int;
  v_after uuid;
  v_virtual timestamptz;
begin
  select q.late_tolerance_minutes, q.early_checkin_minutes into v_tolerance, v_early
  from app.queues q where q.id = p_visit.queue_id;
  late := p_visit.scheduled_at is not null
          and now() > p_visit.scheduled_at + make_interval(mins => v_tolerance);
  -- Virtual arrival: on time sorts as if it joined early_checkin_minutes before its start (never
  -- before it actually arrived); late beyond grace, or unscheduled, is a walk-in arriving now.
  v_virtual := case when p_visit.scheduled_at is null or late then now()
                    else least(now(), p_visit.scheduled_at - make_interval(mins => v_early)) end;
  select w.id into v_after
  from app.visits w
  where w.queue_id = p_visit.queue_id and w.service_day = p_visit.service_day
    and w.status = 'waiting' and w.id <> p_visit.id
    -- late or unscheduled: behind everyone, as a walk-in arriving now would be
    and (p_visit.scheduled_at is null or late or private.virtual_arrival(w, v_tolerance, v_early) <= v_virtual)
  order by w.sort_key desc, w.id desc
  limit 1;
  select pl.new_sort_key into new_sort_key
  from private.place_in_queue(p_visit.queue_id, p_visit.service_day, p_visit.id, v_after) pl;
end $$;

-- redefines api.call_next from 20261030063127_call_next_resources.sql
create or replace function api.call_next(p_queue_id uuid, p_counter_id uuid, p_idempotency_key uuid)
returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  claim record;
  v_id uuid;
  result api.visit_row;
begin
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into q from app.queues where id = p_queue_id;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_counter_id is not null and not exists (
    select 1 from app.counters c
    where c.id = p_counter_id and c.org_id = q.org_id and c.location_id = q.location_id
      and c.archived_at is null
  ) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'call_next', p_idempotency_key);
  if claim.replay then
    return case when claim.response is null or claim.response = 'null' then null
                else jsonb_populate_record(null::api.visit_row, claim.response) end;
  end if;

  -- SKIP LOCKED: a concurrent caller holding the first eligible visit makes us take the next one.
  -- NO KEY UPDATE, not UPDATE: a foreign-key check's KEY SHARE on the row must not make us skip it.
  select v.id into v_id
  from app.visits v
  where v.queue_id = q.id
    and v.status = 'waiting'
    and v.service_day = private.service_day(q.location_id)
    and private.visit_eligible(v.service_id, v.assigned_counter_id, v.assigned_staff_id,
                               p_counter_id, (select auth.uid()))
  -- A walk-in that has waited past its quote plus the queue's max delay goes before appointments
  -- (ADR 0010 guard); otherwise by position.
  -- The wait counts from the last time the guest entered the line (join, snooze, requeue, move,
  -- reinstate), so a snooze or a step back is not undone by the guard.
  order by (v.scheduled_at is null
            and now() > greatest(v.joined_at, coalesce((select max(e.occurred_at) from app.visit_events e
                                                         where e.visit_id = v.id and e.to_status = 'waiting'
                                                           and e.type in ('requeue', 'snoozed', 'moved', 'reinstate', 'undo', 'transferred')), v.joined_at))
                        + make_interval(mins => coalesce(v.eta_quoted_high, 0) + q.max_walkin_delay_minutes)) desc,
           v.sort_key, v.id
  limit 1
  for no key update skip locked;

  if v_id is null then
    perform private.save_idempotent('call_next', p_idempotency_key, null);
    return null;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'call', null,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', p_counter_id)));
  update app.visits
  set status = 'called', called_at = now(), call_count = call_count + 1, counter_id = p_counter_id
  where id = v_id;
  perform private.bump_queue_version(q.id);

  result := private.visit_row(v_id);
  perform private.save_idempotent('call_next', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

comment on function api.call_next(uuid, uuid, uuid) is
  'Calls the first eligible waiting visit of the queue''s current service day, by position, to '
  'p_counter_id (or to no counter when null) and returns it, or null when nobody eligible is '
  'waiting. A walk-in that has waited longer than its quote plus queues.max_walkin_delay_minutes '
  '(counted from when it last entered the line) goes first. Eligible: unassigned or assigned to that '
  'counter or to the caller, and the service has no mapped resources or the counter (or a staff resource '
  'of the caller) is mapped to it. Concurrent callers always get different visits; repeating a key returns '
  'the first result, including a null one. Raises not_found for a queue or counter outside the caller''s '
  'locations (staff or above), invalid_input without a key. Implemented in V2 (#31), 2A-Q2 (#101), ADR 0010.';

-- redefines private.eta_at from 20261030110000_wait_override.sql
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
  v_busy_work numeric;
  v_reserved numeric := 0;
  v_mean numeric;
  v_sigma numeric;
  v_total int;
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
  -- Counter sessions do not exist yet; when they do, active sessions replace servers_on_duty here.
  if q.servers_on_duty = 0 then
    eta_state := 'unstaffed';
    return;
  end if;

  select coalesce(avg(s.expected_minutes), 10) into v_default
  from app.services s
  where s.queue_id = q.id and s.active;

  select count(*), coalesce(sum(coalesce(s.expected_minutes, v_default)), 0),
         coalesce(avg(coalesce(s.expected_minutes, v_default)), v_default)
  into v_ahead, v_ahead_work, v_avg
  from app.visits v
  left join app.services s on s.id = v.service_id
  where v.queue_id = q.id and v.status = 'waiting'
    and (p_before is null or v.sort_key < p_before);

  -- Guests being called or served still hold a server: what is left of their expected time,
  -- but never less than a fifth of it.
  select coalesce(sum(greatest(
           0.2 * coalesce(s.expected_minutes, v_default),
           coalesce(s.expected_minutes, v_default)
             - extract(epoch from now() - coalesce(v.serving_at, v.called_at, now())) / 60)), 0)
  into v_busy_work
  from app.visits v
  left join app.services s on s.id = v.service_id
  where v.queue_id = q.id and v.status in ('called', 'serving');

  -- Expected guests who will check in ahead of this one (their virtual arrival, ADR 0010, is not
  -- later than when this guest would start) take server time too. Each one found pushes the start
  -- later, so look again; three rounds settle any realistic day. Off unless the queue opts in.
  if q.eta_reserves_appointments then
    for i in 1..3 loop
      select coalesce(sum(coalesce(s.expected_minutes, v_default)), 0) into v_reserved
      from app.visits x
      left join app.services s on s.id = x.service_id
      where x.queue_id = q.id and x.status = 'expected' and x.scheduled_at is not null
        and x.scheduled_at - make_interval(mins => q.early_checkin_minutes)
            <= now() + ((v_ahead_work + v_busy_work + v_reserved) / q.servers_on_duty)::float8 * interval '1 minute'
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

  v_mean := greatest(0, (v_ahead_work + v_busy_work) / q.servers_on_duty
                        - (q.servers_on_duty - 1) * v_avg / (2 * q.servers_on_duty));
  v_sigma := 0.5 * v_avg * sqrt(v_ahead + 1) / q.servers_on_duty;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;
