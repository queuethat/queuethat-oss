-- 2A-Q2 (#101): call_next honours service-to-resource mapping and waiting-guest assignment (Q-4, Q-18).
-- Signatures are unchanged (Phase-0 / 2A-API2 contracts); only bodies and one private helper change.
--
-- redefines api.call_next from 20261029231933_call_next_no_key_update.sql
-- redefines api.transition_visit from 20261025001300_staff_transitions.sql
-- redefines api.assign_visit from 20261030045508_api_contracts_2a.sql

------------------------------------------------------------------------------------------------
-- The one eligibility rule
------------------------------------------------------------------------------------------------

create function private.visit_eligible(
  p_service_id uuid,
  p_assigned_counter_id uuid,
  p_assigned_staff_id uuid,
  p_counter_id uuid,
  p_actor uuid
) returns boolean
language sql stable set search_path = '' as $$
  select
    -- Assignment: unassigned, or assigned to this counter, or assigned to this person.
    ((p_assigned_counter_id is null and p_assigned_staff_id is null)
      or p_assigned_counter_id = p_counter_id
      or p_assigned_staff_id = p_actor)
    -- Mapping: a service with no mapped resources is served by anyone.
    and (p_service_id is null
      or not exists (select 1 from app.service_resources sr where sr.service_id = p_service_id)
      or exists (
        select 1
        from app.service_resources sr
        join app.counters c on c.id = sr.counter_id and c.active and c.archived_at is null
        where sr.service_id = p_service_id
          and (sr.counter_id = p_counter_id
               or (c.kind = 'staff' and c.member_user_id = p_actor))))
$$;
comment on function private.visit_eligible(uuid, uuid, uuid, uuid, uuid) is
  'Whether a waiting visit may be offered to p_actor serving at p_counter_id: it is unassigned or '
  'assigned to that counter or person, and its service has no mapped resources or p_counter_id (or '
  'a staff resource of p_actor) is one of them. The single owner of this rule; call_next filters '
  'with it and transition_visit uses it to flag overrides.';
revoke all on function private.visit_eligible(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- call_next: only the pick changes
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

  -- SKIP LOCKED: a concurrent caller holding the first eligible visit makes us take the next one.
  -- NO KEY UPDATE, not UPDATE: a foreign-key check's KEY SHARE on the row must not make us skip it.
  select v.id into v_id
  from app.visits v
  where v.queue_id = q.id
    and v.status = 'waiting'
    and v.service_day = private.service_day(q.location_id)
    and private.visit_eligible(v.service_id, v.assigned_counter_id, v.assigned_staff_id,
                               p_counter_id, (select auth.uid()))
  order by v.sort_key, v.id
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
  'waiting. Eligible: unassigned or assigned to that counter or to the caller, and the service '
  'has no mapped resources or the counter (or a staff resource of the caller) is mapped to it. '
  'Concurrent callers always get different visits; repeating a key returns the first result, '
  'including a null one. Raises not_found for a queue or counter outside the caller''s locations '
  '(staff or above), invalid_input without a key. Implemented in V2 (#31), 2A-Q2 (#101).';

------------------------------------------------------------------------------------------------
-- transition_visit: a staff call on a specific visit overrides eligibility, and says so
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
  v_override boolean;
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

  -- Staff may call any waiting visit by hand; when call_next would not have offered it, the
  -- event says so (override = true).
  v_override := p_action = 'call' and not private.visit_eligible(
    v.service_id, v.assigned_counter_id, v.assigned_staff_id, v_counter, (select auth.uid()));

  perform private.set_actor('staff', (select auth.uid()), p_action::text, v_reason,
                            jsonb_strip_nulls(jsonb_build_object('counter_id', v_counter,
                                                                 'previous_counter_id', v.counter_id,
                                                                 'override', case when v_override then true end)));
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
  'clears the counter. A call ignores assignment and service mapping (staff override) and '
  'records override=true in the event payload when call_next would not have offered the visit. '
  'p_reason is recorded on the event. Repeating a key returns the first '
  'result. Raises not_found for a visit or counter outside the caller''s locations (no existence '
  'leak), invalid_input when remove has no reason or a reason is over 500 characters, '
  'stale_visit when p_expected_version is not current (refetch and retry; nothing changes), '
  'illegal_transition when the action is not allowed from the current status. Implemented in '
  'V2 (#31), 2A-Q2 (#101).';

------------------------------------------------------------------------------------------------
-- assign_visit
------------------------------------------------------------------------------------------------

create or replace function api.assign_visit(
  p_visit_id uuid, p_counter_id uuid, p_staff_user_id uuid, p_expected_version int, p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  if p_counter_id is not null and not exists (
    select 1 from app.counters c
    where c.id = p_counter_id and c.org_id = v.org_id and c.location_id = v.location_id
      and c.active and c.archived_at is null
  ) then
    raise exception 'not_found';
  end if;
  if p_staff_user_id is not null and not exists (
    select 1 from app.memberships m
    where m.org_id = v.org_id and m.user_id = p_staff_user_id
      and (m.location_ids is null or v.location_id = any (m.location_ids))
  ) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'assign_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('assign from %s', v.status);
  end if;

  -- Assigning what is already assigned is a no-op, not an event.
  if v.assigned_counter_id is distinct from p_counter_id
     or v.assigned_staff_id is distinct from p_staff_user_id then
    perform private.set_actor('staff', (select auth.uid()), 'assigned', null,
                              jsonb_build_object('counter_id', p_counter_id,
                                                 'staff_user_id', p_staff_user_id,
                                                 'previous_counter_id', v.assigned_counter_id,
                                                 'previous_staff_user_id', v.assigned_staff_id));
    update app.visits
    set assigned_counter_id = p_counter_id, assigned_staff_id = p_staff_user_id
    where id = v.id;
    perform private.bump_queue_version(v.queue_id);
  end if;

  result := private.visit_row(v.id);
  perform private.save_idempotent('assign_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.assign_visit(uuid, uuid, uuid, int, uuid) is
  'Assigns a waiting visit to a counter, a staff member or both; both null unassigns. Records an '
  'assigned event (nothing when the assignment is unchanged). Staff of the location; the counter '
  'must be active and in the location, the member must cover it. call_next then offers the visit '
  'only to that counter or person. Raises not_found for a visit, counter or member outside the '
  'caller''s reach (no existence leak), stale_visit, illegal_transition unless the visit is '
  'waiting, invalid_input without a version or key. Idempotent per key. Implemented by 2A-Q2 (#101).';
