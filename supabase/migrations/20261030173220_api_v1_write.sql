-- 2B-I4 (#309): api_v1 write endpoints. Writes reuse the console's logic so the API can never do
-- what staff cannot: joins go through private.join_core (source 'api'), transitions through the same
-- state-machine step api.transition_visit uses (now private.transition_core, parameterised by actor).
-- The event actor is the API key (actor_kind 'api_key', actor_id = key id).

alter type app.actor_kind add value if not exists 'api_key';

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'app.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%''kiosk''%''appointment''%';
  execute format('alter table app.visits drop constraint %I', c);
  alter table app.visits add constraint visits_source_check
    check (source in ('online', 'staff', 'kiosk', 'appointment', 'api'));
end $$;

-- Idempotency for callers that are not a signed-in user: the actor is passed in (the API key id),
-- so keys are namespaced by key id.
create function private.claim_idempotent_for(p_org_id uuid, p_actor_id uuid, p_rpc text, p_key uuid,
                                             out replay boolean, out response jsonb)
language plpgsql volatile set search_path = '' as $$
begin
  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, p_actor_id, p_rpc, p_key)
  on conflict do nothing;
  if found then
    replay := false;
    return;
  end if;
  replay := true;
  select k.response into response
  from app.idempotency_keys k
  where k.actor_id = p_actor_id and k.rpc = p_rpc and k.key = p_key;
end $$;
comment on function private.claim_idempotent_for(uuid, uuid, text, uuid) is
  'private.claim_idempotent for an explicit actor (an API key id). Errors roll the claim back.';

create function private.save_idempotent_for(p_actor_id uuid, p_rpc text, p_key uuid, p_response jsonb)
returns void language sql volatile set search_path = '' as $$
  update app.idempotency_keys set response = p_response
  where actor_id = p_actor_id and rpc = p_rpc and key = p_key
$$;
revoke all on function private.claim_idempotent_for(uuid, uuid, text, uuid),
  private.save_idempotent_for(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- redefines private.take_join_slot from 20261025005100_join_ceiling_visibility.sql
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
  -- An API key has its own per-minute budget and is a trusted integration, like staff.
  if p_source in ('staff', 'api') then
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

create function private.transition_core(
  p_visit_id uuid,
  p_action api.visit_action,
  p_expected_version int,
  p_idempotency_key uuid,
  p_counter_id uuid,
  p_reason text,
  p_actor_kind app.actor_kind,
  p_actor_id uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_reason text := nullif(btrim(p_reason), '');
  v_counter uuid;
  v_target api.visit_state;
  v_override boolean;
  v_sort bigint;
  v_late boolean;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found then
    raise exception 'not_found';
  end if;

  if p_action is null or p_expected_version is null or p_idempotency_key is null
     or length(v_reason) > 500
     or (p_action = 'remove' and v_reason is null) then
    raise exception 'invalid_input';
  end if;
  if p_counter_id is not null and not exists (
    select 1 from app.counters c
    where c.id = p_counter_id and c.org_id = v.org_id and c.location_id = v.location_id
      and c.archived_at is null
  ) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent_for(v.org_id, p_actor_id, 'transition_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;

  -- expire belongs to rollover (V7); allowed_actions never offers it to staff.
  select t.to_status into v_target
  from app.visit_transitions t
  where t.from_status = v.status and t.action = p_action and p_action <> 'expire';
  if v_target is null then
    raise exception 'illegal_transition' using detail = format('%s from %s', p_action, v.status);
  end if;

  v_counter := case
    when p_action in ('call', 'recall') then coalesce(p_counter_id, v.counter_id)
    when v_target = 'waiting' then null
    else v.counter_id
  end;

  -- Staff may call any waiting visit by hand; when call_next would not have offered it, the
  -- event says so (override = true).
  v_override := p_action = 'call' and not private.visit_eligible(
    v.service_id, v.assigned_counter_id, v.assigned_staff_id, v_counter, p_actor_id);

  -- Checking in files the visit by its schedule (or at the end when late).
  if p_action = 'check_in' then
    perform private.set_actor(p_actor_kind, p_actor_id, 'check_in');
    select cp.new_sort_key, cp.late into v_sort, v_late from private.check_in_place(v) cp;
  end if;

  perform private.set_actor(p_actor_kind, p_actor_id, p_action::text, v_reason,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', v_counter,
                                                                 'previous_counter_id', v.counter_id,
                                                                 'override', case when v_override then true end,
                                                                 'late', case when v_late then true end)));
  update app.visits
  set status = v_target,
      counter_id = v_counter,
      sort_key = coalesce(v_sort, sort_key),
      call_count = call_count + case when p_action in ('call', 'recall') then 1 else 0 end,
      called_at = case when p_action = 'call' then now() else called_at end,
      serving_at = case when p_action = 'start' then now() else serving_at end,
      assigned_staff_id = case when p_action = 'start' and p_actor_kind = 'staff' then p_actor_id else assigned_staff_id end,
      finished_at = case when v_target in ('served', 'no_show', 'cancelled', 'removed') then now()
                         when v_target = 'waiting' then null
                         else finished_at end
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent_for(p_actor_id, 'transition_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
revoke all on function private.transition_core(uuid, api.visit_action, int, uuid, uuid, text, app.actor_kind, uuid) from public, anon, authenticated;
comment on function private.transition_core(uuid, api.visit_action, int, uuid, uuid, text, app.actor_kind, uuid) is
  'The state-machine step behind api.transition_visit and api_v1.transition_visit: the caller has already authorised the actor. Idempotency is keyed by p_actor_id.';

-- redefines api.transition_visit from 20261030085100_check_in.sql
create or replace function api.transition_visit(
  p_visit_id uuid,
  p_action api.visit_action,
  p_expected_version int,
  p_idempotency_key uuid,
  p_counter_id uuid default null,
  p_reason text default null
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  return private.transition_core(p_visit_id, p_action, p_expected_version, p_idempotency_key,
                                 p_counter_id, p_reason, 'staff', (select auth.uid()));
end $$;
comment on function api.transition_visit(uuid, api.visit_action, int, uuid, uuid, text) is
  'Applies one staff action from the visit''s allowed_actions (call, recall, start, requeue, '
  'complete, no_show, cancel, remove, reinstate, check_in) and returns the updated row. call and '
  'recall add to call_count and take p_counter_id (default: the current counter); call sets '
  'called_at, start sets serving_at and assigns the caller; served, no_show, cancelled and '
  'removed set finished_at; back to waiting (requeue, reinstate) keeps the place in line and '
  'clears the counter. check_in turns an expected visit into a waiting one at the place its '
  'scheduled_at earns, or at the end of the line when it is more than the queue''s '
  'late_tolerance_minutes late (the event then carries late = true). A call outside the '
  'eligibility rules (resource, counter or staff assignment) is recorded as an override. '
  'p_reason is recorded on the event. Repeating a key returns the first result. Raises not_found '
  'for a visit or counter outside the caller''s locations (no existence leak), invalid_input '
  'when remove has no reason or a reason is over 500 characters, stale_visit when '
  'p_expected_version is not current (refetch and retry; nothing changes), illegal_transition '
  'when the action is not allowed from the current status. Implemented in V2 (#31), check_in in '
  '2A-CHK1 (#149).';

------------------------------------------------------------------------------------------------
-- api_v1 writes
------------------------------------------------------------------------------------------------

create function private.v1_visit(p_visit_id uuid) returns api_v1.visit
language sql stable security definer set search_path = '' as $$
  select v.id, v.queue_id, v.display_ticket, v.status::text, v.party_size, v.joined_at, v.called_at,
         v.serving_at, v.finished_at, greatest(v.joined_at, v.called_at, v.serving_at, v.finished_at)
  from app.visits v where v.id = p_visit_id
$$;
revoke all on function private.v1_visit(uuid) from public, anon, authenticated;

create function api_v1.create_visit(p_queue_id uuid, p_service_id uuid, p_name text, p_phone_e164 text,
                                    p_email text, p_party_size int, p_idempotency_key uuid)
returns api_v1.visit
language plpgsql volatile security definer set search_path = '' as $$
declare
  k record;
  j record;
begin
  select * into k from private.require_api_scope('visits:write');
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  if not exists (select 1 from app.queues q where q.id = p_queue_id and q.org_id = k.org_id
                 and q.archived_at is null and (k.location_ids is null or q.location_id = any (k.location_ids))) then
    raise exception 'not_found';
  end if;
  select * into j from private.join_core(
    p_queue_id, p_service_id, p_name, p_phone_e164, p_email, p_party_size, null,
    -- namespaced by key id, so two integrators can reuse a key
    md5(k.key_id::text || p_idempotency_key::text)::uuid,
    'api', 'api_key', k.key_id);
  return private.v1_visit(j.visit_id);
end $$;
comment on function api_v1.create_visit(uuid, uuid, text, text, text, int, uuid) is
  'API v1: adds a guest to a queue (source api) under the same accepting rule, capacity and block '
  'list as every entry point; repeating the idempotency key returns the same visit. Scope '
  'visits:write. Raises queue_not_accepting, capacity_reached, not_found (unknown or foreign queue '
  'or service), invalid_input. No link token is returned: API-created guests have no status page.';

create function api_v1.transition_visit(p_visit_id uuid, p_action text, p_expected_version int,
                                        p_idempotency_key uuid, p_reason text default null)
returns api_v1.visit
language plpgsql volatile security definer set search_path = '' as $$
declare
  k record;
  a api.visit_action;
begin
  select * into k from private.require_api_scope('visits:write');
  if not exists (select 1 from app.visits v join app.queues q on q.id = v.queue_id
                 where v.id = p_visit_id and v.org_id = k.org_id
                   and (k.location_ids is null or q.location_id = any (k.location_ids))) then
    raise exception 'not_found';
  end if;
  begin
    a := p_action::api.visit_action;
  exception when invalid_text_representation then
    raise exception 'invalid_input';
  end;
  perform private.transition_core(p_visit_id, a, p_expected_version, p_idempotency_key, null, p_reason,
                                  'api_key', k.key_id);
  return private.v1_visit(p_visit_id);
end $$;
comment on function api_v1.transition_visit(uuid, text, int, uuid, text) is
  'API v1: applies one action (call, start, complete, no_show, cancel, ...) with the console''s state '
  'machine; the event actor is the API key. Scope visits:write. Raises not_found, stale_visit, '
  'illegal_transition, invalid_input (unknown action, remove without a reason).';

create function api_v1.set_queue_state(p_queue_id uuid, p_state text) returns api_v1.queue
language plpgsql volatile security definer set search_path = '' as $$
declare
  k record;
  q app.queues;
  s api.queue_state;
begin
  select * into k from private.require_api_scope('queues:write');
  select * into q from app.queues where id = p_queue_id and archived_at is null and org_id = k.org_id
    and (k.location_ids is null or location_id = any (k.location_ids));
  if not found then raise exception 'not_found'; end if;
  begin
    s := p_state::api.queue_state;
  exception when invalid_text_representation then
    raise exception 'invalid_input';
  end;
  update app.queues set manual_state = s where id = q.id and manual_state <> s;
  if found then perform private.bump_queue_version(q.id); end if;
  return private.v1_queue(q.id);
end $$;
comment on function api_v1.set_queue_state(uuid, text) is
  'API v1: opens, pauses or closes a queue for every entry point; setting the current state changes '
  'nothing. Scope queues:write. Raises not_found, invalid_input.';

grant execute on function api_v1.create_visit(uuid, uuid, text, text, text, int, uuid),
  api_v1.transition_visit(uuid, text, int, uuid, text), api_v1.set_queue_state(uuid, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
