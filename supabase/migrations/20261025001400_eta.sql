-- V5 (#34): wait-time estimate v1 (technical-design.md 8; ETA module in 3.5).
--
-- private.eta_at is the only place that knows the formula and the degradation rules. It returns
-- (eta_state, eta_low, eta_high); clients format that triple with formatEta in packages/domain
-- and never re-derive it. visit_eta and queue_eta are the two ways callers ask for it, and the
-- quote_eta trigger stores the range quoted at join on every visit (W-4 cannot be backfilled).

-- Appended for a range too long or too wide to show truthfully (Riz, 2026-10-25). Additive: no
-- 0600 signature changes.
alter type api.eta_state add value 'uncertain';

create function private.eta_range_state(p_low int, p_high int) returns api.eta_state
language plpgsql immutable set search_path = '' as $$
begin
  return case
    when p_low >= 60 then 'over_hour'
    when p_high > 120 or (p_high > 45 and p_high > 4 * p_low) then 'uncertain'
    else 'ok'
  end;
end $$;
comment on function private.eta_range_state(int, int) is
  'How a computed range is shown: over_hour when even the low end is an hour or more; uncertain '
  'when the range runs past 120 minutes, or past 45 with its high end more than 4 times its '
  'low end (so a short 5-35 still shows); otherwise ok.';

create function private.eta_at(
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
  v_mean numeric;
  v_sigma numeric;
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

  v_mean := (v_ahead_work + v_busy_work) / q.servers_on_duty;
  v_sigma := 0.5 * v_avg * sqrt(v_ahead + 1) / q.servers_on_duty;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;
comment on function private.eta_at(uuid, bigint) is
  'The wait estimate, in minutes until service starts, for a guest placed after every waiting '
  'visit of the queue whose sort_key is below p_before (null = behind all of them). States, '
  'first match wins: hidden (show_eta off), paused, unstaffed (servers_on_duty = 0), next '
  '(nobody waiting ahead), then over_hour, uncertain or ok by private.eta_range_state. hidden, '
  'paused and unstaffed carry no numbers; the others carry low and high in multiples of 5 with '
  'high >= low + 5 (kept for uncertain too, so the quote records them). All nulls for an '
  'unknown queue.';

create function private.visit_eta(
  p_visit_id uuid,
  out eta_state api.eta_state,
  out eta_low int,
  out eta_high int
)
language sql stable set search_path = '' as $$
  select e.eta_state, e.eta_low, e.eta_high
  from app.visits v, private.eta_at(v.queue_id, v.sort_key) e
  where v.id = p_visit_id and v.status = 'waiting'
$$;
comment on function private.visit_eta(uuid) is
  'The current estimate for a waiting visit, as private.eta_at. All nulls once the visit is no '
  'longer waiting, or for an unknown visit. api.get_visit_status reports it.';

create function private.queue_eta(
  p_queue_id uuid,
  out eta_state api.eta_state,
  out eta_low int,
  out eta_high int
)
language sql stable set search_path = '' as $$
  select e.eta_state, e.eta_low, e.eta_high from private.eta_at(p_queue_id, null) e
$$;
comment on function private.queue_eta(uuid) is
  'The estimate for someone joining the queue now, as private.eta_at behind every waiting visit. '
  'api.get_location_public reports it per queue.';

------------------------------------------------------------------------------------------------
-- The quoted range, stored on every visit at insert
------------------------------------------------------------------------------------------------

create function private.quote_eta() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'waiting' then
    select e.eta_low, e.eta_high into new.eta_quoted_low, new.eta_quoted_high
    from private.eta_at(new.queue_id, new.sort_key) e;
  else
    new.eta_quoted_low := null;
    new.eta_quoted_high := null;
  end if;
  return new;
end $$;
comment on function private.quote_eta() is
  'BEFORE INSERT on app.visits: sets eta_quoted_low/high to the range a new waiting visit is '
  'quoted (null when the queue shows no number, or for an expected visit). Callers cannot supply '
  'them. Every join entry point inserts through private.join_core, so all of them get it.';

create trigger quote_eta before insert on app.visits
  for each row execute function private.quote_eta();

revoke all on function private.eta_range_state(int, int) from public, anon, authenticated;
revoke all on function private.eta_at(uuid, bigint) from public, anon, authenticated;
revoke all on function private.visit_eta(uuid) from public, anon, authenticated;
revoke all on function private.queue_eta(uuid) from public, anon, authenticated;
revoke all on function private.quote_eta() from public, anon, authenticated;
