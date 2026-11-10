-- V2 (#31): staff call-next and every staff transition (technical-design.md 3.4, 3.5, 4.1).
--
-- api.call_next and api.transition_visit are the visit engine's staff entry points. The state
-- machine itself stays in app.visit_transitions and private.guard_visit; this file adds the
-- pieces both functions share and V3/V4 reuse: the staff idempotency claim, the computed
-- position, the api.visit_row builder and the queue version bump.

------------------------------------------------------------------------------------------------
-- Staff idempotency (app.idempotency_keys)
------------------------------------------------------------------------------------------------

/**
 * Claims (caller, p_rpc, p_key) for this transaction. replay is false for the first call, which
 * must then do the work and store its result with private.save_idempotent(). A concurrent call
 * with the same key waits here until the first commits, then gets replay true and its response.
 */
create function private.claim_idempotent(
  p_org_id uuid,
  p_rpc text,
  p_key uuid,
  out replay boolean,
  out response jsonb
)
language plpgsql volatile set search_path = '' as $$
begin
  insert into app.idempotency_keys (org_id, actor_id, rpc, key)
  values (p_org_id, (select auth.uid()), p_rpc, p_key)
  on conflict do nothing;
  if found then
    replay := false;
    return;
  end if;
  replay := true;
  select k.response into response
  from app.idempotency_keys k
  where k.actor_id = (select auth.uid()) and k.rpc = p_rpc and k.key = p_key;
end $$;
comment on function private.claim_idempotent(uuid, text, uuid) is
  'Claims the caller''s (rpc, key). replay = false: first call, do the work and save the result. '
  'replay = true: return response (null when the first call returned null). Errors roll the claim '
  'back with everything else, so a failed call can be retried with the same key.';

create function private.save_idempotent(p_rpc text, p_key uuid, p_response jsonb)
returns void
language sql volatile set search_path = '' as $$
  update app.idempotency_keys
  set response = p_response
  where actor_id = (select auth.uid()) and rpc = p_rpc and key = p_key
$$;
comment on function private.save_idempotent(text, uuid, jsonb) is
  'Stores the response a claimed (rpc, key) returns on replay.';

------------------------------------------------------------------------------------------------
-- Position and the staff row
------------------------------------------------------------------------------------------------

create function private.visit_position(p_visit app.visits) returns int
language sql stable set search_path = '' as $$
  select case when p_visit.status = 'waiting' then (
    select count(*)::int + 1
    from app.visits w
    where w.queue_id = p_visit.queue_id
      and w.service_day = p_visit.service_day
      and w.status = 'waiting'
      and (w.sort_key, w.id) < (p_visit.sort_key, p_visit.id)
  ) end
$$;
comment on function private.visit_position(app.visits) is
  '1-based place among the queue''s waiting visits of the same service day, ordered by '
  '(sort_key, id), which is the order call_next calls them in. Null when not waiting. The only '
  'position rule; position is never stored.';

create function private.visit_row(p_visit_id uuid) returns api.visit_row
language sql stable set search_path = '' as $$
  select v.id, v.queue_id, v.service_id, s.name, v.display_ticket, v.status, v.sort_key,
         private.visit_position(v), v.party_size, v.guest_name, v.source, v.counter_id, c.label,
         v.call_count, v.joined_at, v.called_at, v.serving_at, v.finished_at, v.eta_quoted_low,
         v.eta_quoted_high, v.version, private.allowed_actions(v.status),
         (select max(e.id) from app.visit_events e where e.visit_id = v.id)
  from app.visits v
  left join app.services s on s.id = v.service_id
  left join app.counters c on c.id = v.counter_id
  where v.id = p_visit_id
$$;
comment on function private.visit_row(uuid) is
  'The api.visit_row staff functions return for a visit: computed position, allowed_actions, and '
  'last_event_id = the visit''s latest event (the one the calling function just wrote).';

/** Signals a change to everyone following the queue (staff lists, display, guest pulse). */
create function private.bump_queue_version(p_queue_id uuid) returns void
language sql volatile set search_path = '' as $$
  update app.queues set version = version + 1 where id = p_queue_id
$$;
comment on function private.bump_queue_version(uuid) is
  'Increments queues.version. Every function that changes a visit calls it once, last, so the '
  'queue row lock is held only until commit.';

-- A version bump is not a configuration change: audit queues only when something else changed,
-- otherwise every call would write an audit row.
drop trigger audit_row on app.queues;
create trigger audit_row after insert or delete on app.queues
  for each row execute function private.audit_row();
create trigger audit_row_update after update on app.queues
  for each row
  when ((to_jsonb(old) - 'version' - 'updated_at') is distinct from (to_jsonb(new) - 'version' - 'updated_at'))
  execute function private.audit_row();

revoke all on function private.claim_idempotent(uuid, text, uuid) from public, anon, authenticated;
revoke all on function private.save_idempotent(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.visit_position(app.visits) from public, anon, authenticated;
revoke all on function private.visit_row(uuid) from public, anon, authenticated;
revoke all on function private.bump_queue_version(uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.call_next (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

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

  -- SKIP LOCKED: a concurrent caller holding the first waiting visit makes us take the next one.
  select v.id into v_id
  from app.visits v
  where v.queue_id = q.id
    and v.status = 'waiting'
    and v.service_day = private.service_day(q.location_id)
  order by v.sort_key, v.id
  limit 1
  for update skip locked;

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
  'Calls the first waiting visit of the queue''s current service day, by position, to '
  'p_counter_id (or to no counter when null) and returns it, or null when nobody is waiting. '
  'Concurrent callers always get different visits; repeating a key returns the first result, '
  'including a null one. Raises not_found for a queue or counter outside the caller''s locations '
  '(staff or above), invalid_input without a key. Implemented in V2 (#31).';

------------------------------------------------------------------------------------------------
-- api.transition_visit (signature and grants from S5)
------------------------------------------------------------------------------------------------

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
  claim record;
  v_reason text := nullif(btrim(p_reason), '');
  v_counter uuid;
  v_target api.visit_state;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
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

  select * into claim from private.claim_idempotent(v.org_id, 'transition_visit', p_idempotency_key);
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

  perform private.set_actor('staff', (select auth.uid()), p_action::text, v_reason,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', v_counter,
                                                                 'previous_counter_id', v.counter_id)));
  update app.visits
  set status = v_target,
      counter_id = v_counter,
      call_count = call_count + case when p_action in ('call', 'recall') then 1 else 0 end,
      called_at = case when p_action = 'call' then now() else called_at end,
      serving_at = case when p_action = 'start' then now() else serving_at end,
      assigned_staff_id = case when p_action = 'start' then (select auth.uid()) else assigned_staff_id end,
      finished_at = case when v_target in ('served', 'no_show', 'cancelled', 'removed') then now()
                         when v_target = 'waiting' then null
                         else finished_at end
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('transition_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.transition_visit(uuid, api.visit_action, int, uuid, uuid, text) is
  'Applies one staff action from the visit''s allowed_actions (call, recall, start, requeue, '
  'complete, no_show, cancel, remove, reinstate, check_in) and returns the updated row. call and '
  'recall add to call_count and take p_counter_id (default: the current counter); call sets '
  'called_at, start sets serving_at and assigns the caller; served, no_show, cancelled and '
  'removed set finished_at; back to waiting (requeue, reinstate) keeps the place in line and '
  'clears the counter. p_reason is recorded on the event. Repeating a key returns the first '
  'result. Raises not_found for a visit or counter outside the caller''s locations (no existence '
  'leak), invalid_input when remove has no reason or a reason is over 500 characters, '
  'stale_visit when p_expected_version is not current (refetch and retry; nothing changes), '
  'illegal_transition when the action is not allowed from the current status. Implemented in '
  'V2 (#31).';
