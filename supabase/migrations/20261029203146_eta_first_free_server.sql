-- #548: wait quotes ran 3 to 6 minutes long whenever more than one server was on duty. The
-- mean assumed every server must clear its share of the work ahead before this guest starts,
-- but the guest takes the first chair that frees. Body copied from 20261025001400_eta.sql; only
-- v_mean changes. Same signature, states and rounding; private.visit_eta and queue_eta call it
-- unchanged. Evidence: pnpm simulate:day (4 servers, seed 1) in the PR.

-- redefines private.eta_at from 20261025001400_eta.sql
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

  -- (work ahead + busy) / servers is when the servers would clear everything ahead on average,
  -- but a guest starts as soon as one server frees after the last guest ahead has started, while
  -- the other servers are still mid-service: on average (servers - 1) / servers of half a
  -- service earlier (#548). With one server nothing changes.
  v_mean := greatest(0, (v_ahead_work + v_busy_work) / q.servers_on_duty
                        - (q.servers_on_duty - 1) * v_avg / (2 * q.servers_on_duty));
  v_sigma := 0.5 * v_avg * sqrt(v_ahead + 1) / q.servers_on_duty;
  eta_low := (round(greatest(0, v_mean - v_sigma) / 5) * 5)::int;
  eta_high := greatest((ceil((v_mean + v_sigma) / 5) * 5)::int, eta_low + 5);

  eta_state := case when v_ahead = 0 then 'next' else private.eta_range_state(eta_low, eta_high) end;
end $$;
