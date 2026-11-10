-- #492: staff see when a queue has hit its hourly online-join ceiling (#482), and admins can set
-- it (1 to 1000). The rule moves into app.online_joins_paused_until, a computed column the staff
-- console reads under RLS, and take_join_slot calls the same function.

alter table app.queues
  add constraint queues_online_joins_per_hour_max check (online_joins_per_hour <= 1000);

/**
 * When online joins to this queue open again, or null while they are open. Counts the queue's
 * online visits in the last hour, not counting visits staff removed: at online_joins_per_hour,
 * it is the moment the oldest of the newest online_joins_per_hour joins turns an hour old.
 */
-- SECURITY INVOKER on purpose: called by staff (as a computed column or over /rpc with any row
-- they craft), it counts only visits RLS lets them see; inside join_core it runs as the definer.
create function app.online_joins_paused_until(p_queue app.queues) returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select j.joined_at + interval '1 hour'
  from (
    select v.joined_at from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.status <> 'removed'
      and v.joined_at > now() - interval '1 hour'
    order by v.joined_at desc
    offset p_queue.online_joins_per_hour - 1
    limit 1
  ) j
$$;
comment on function app.online_joins_paused_until(app.queues) is
  'Computed column: null while the queue takes online joins under its hourly ceiling; otherwise '
  'when it will take them again (online joins meanwhile get rate_limited, DETAIL queue_total). '
  'Visits staff removed do not count. Every join and removal bumps the queue version, so the '
  'loc: signal refreshes it; it clears on its own at the time it returns. Reads visits with the '
  'caller''s rights: staff see their own queues only.';
revoke all on function app.online_joins_paused_until(app.queues) from public, anon;
grant execute on function app.online_joins_paused_until(app.queues) to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- redefines private.take_join_slot from 20261025004800_join_device_key.sql
-- take_join_slot: the 004800 body with the hourly check delegated to app.online_joins_paused_until
------------------------------------------------------------------------------------------------

/**
 * Rate limits for one join, taken inside join_core under its per-queue lock. Raises rate_limited
 * with DETAIL client, network, queue, queue_total or device; otherwise records the join so later calls count
 * it (the row rolls back with the join if anything after this fails). Staff adds are not limited.
 */
create or replace function private.take_join_slot(p_queue app.queues, p_source text, p_device_key text default null)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  -- A person joins one queue a few times at most. Venue Wi-Fi puts many guests behind one IP, and
  -- each phone has its own device key; the network cap stops one client minting device keys.
  per_client_online constant int := 10;
  per_network_online int := (select s.per_network_joins from private.deployment_settings s);
  per_client_window constant interval := interval '10 minutes';
  v_client bytea := private.client_key(p_device_key);
  v_network bytea := private.client_key();
  v_recent int;
  v_queue_recent int;
begin
  if p_source = 'staff' then
    return;
  end if;

  -- Each kiosk gets join_rate_per_min to itself, so online floods never reach the front desk.
  if p_source = 'kiosk' then
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - interval '1 minute')
       >= p_queue.join_rate_per_min then
      raise exception 'rate_limited' using detail = 'device';
    end if;
  else
    -- Online: per client (IP and device) first, then per network (IP).
    select count(*) into v_recent from private.join_log l
    where l.queue_id = p_queue.id and l.client_key = v_client and l.at > now() - per_client_window;
    if v_recent >= per_client_online then
      raise exception 'rate_limited' using detail = 'client';
    end if;
    if (select count(*) from private.join_log l
        where l.queue_id = p_queue.id and l.network_key = v_network and l.at > now() - per_client_window)
       >= per_network_online then
      raise exception 'rate_limited' using detail = 'network';
    end if;
    -- Then, while the queue gets more than join_rate_per_min online joins a minute, each client
    -- gets one: anyone who joined in the window waits, but a guest who has not still gets in.
    -- Unknown callers count as having joined. The newcomer exemption stops at three times the
    -- rate, because fresh IPv6 /64s and device keys are cheap.
    select count(*) into v_queue_recent from app.visits v
    where v.queue_id = p_queue.id and v.source = 'online' and v.joined_at > now() - interval '1 minute';
    if v_queue_recent >= 3 * p_queue.join_rate_per_min
       or ((v_client is null or v_recent > 0) and v_queue_recent >= p_queue.join_rate_per_min) then
      raise exception 'rate_limited' using detail = 'queue';
    end if;
    -- Finally the total for the hour, whoever is asking (app.online_joins_paused_until owns the
    -- rule, so the staff banner and this check cannot disagree).
    if app.online_joins_paused_until(p_queue) is not null then
      raise exception 'rate_limited' using detail = 'queue_total';
    end if;
  end if;

  if v_client is not null then
    insert into private.join_log (queue_id, client_key, network_key) values (p_queue.id, v_client, v_network);
  end if;
end $$;
