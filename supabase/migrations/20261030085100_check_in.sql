-- 2A-CHK1 (#149): check-in of expected visits for staff and guests (feature J-6).
--
-- 'expected' is the state of a visit that exists for an appointment but is not in the line yet:
-- it has no position, no ETA and is never called. Checking in moves it to 'waiting' at the place
-- its scheduled_at earns it, or at the end of the line when the guest is late. Creating expected
-- visits (booking, slots, reminders) belongs to the appointments epic, which reuses
-- visits.scheduled_at.

alter table app.visits add column scheduled_at timestamptz;
alter table app.queues
  add column late_tolerance_minutes int not null default 10
  check (late_tolerance_minutes between 0 and 240);
-- Staff read the schedule (the day's timeline); displays and kiosks never read visits.
grant select (scheduled_at) on app.visits to authenticated;

-- redefines app.staff_visits from 20261030073600_notes_history.sql
create or replace view app.staff_visits with (security_invoker = true) as
select
  v.id, v.org_id, v.location_id, v.queue_id, v.service_id, v.service_day,
  v.ticket_prefix, v.ticket_number, v.display_ticket, v.status, v.sort_key,
  v.party_size, v.guest_name, v.guest_id, v.contact_id, v.locale, v.source,
  v.counter_id, v.assigned_staff_id, v.call_count, v.eta_quoted_low, v.eta_quoted_high,
  v.joined_at, v.called_at, v.serving_at, v.finished_at, v.version,
  v.guest_phone_e164, v.guest_email,
  private.allowed_actions(v.status) as allowed_actions,
  v.assigned_counter_id,
  v.group_key,
  v.notes,
  v.tags,
  v.scheduled_at
from app.visits v;

/**
 * Where a checked-in visit goes and whether it is late. On time (up to late_tolerance_minutes
 * after scheduled_at): right behind the last waiting visit whose own time (scheduled_at for
 * appointments, joined_at for walk-ins) is not later than its scheduled_at. Late, or without a
 * schedule: the end of the line, as if it had joined now.
 */
create function private.check_in_place(p_visit app.visits, out new_sort_key bigint, out late boolean)
language plpgsql volatile set search_path = '' as $$
declare
  v_tolerance int;
  v_after uuid;
begin
  select q.late_tolerance_minutes into v_tolerance from app.queues q where q.id = p_visit.queue_id;
  late := p_visit.scheduled_at is not null
          and now() > p_visit.scheduled_at + make_interval(mins => v_tolerance);
  if p_visit.scheduled_at is null or late then
    select w.id into v_after
    from app.visits w
    where w.queue_id = p_visit.queue_id and w.service_day = p_visit.service_day
      and w.status = 'waiting' and w.id <> p_visit.id
    order by w.sort_key desc, w.id desc
    limit 1;
  else
    select w.id into v_after
    from app.visits w
    where w.queue_id = p_visit.queue_id and w.service_day = p_visit.service_day
      and w.status = 'waiting' and w.id <> p_visit.id
      and coalesce(w.scheduled_at, w.joined_at) <= p_visit.scheduled_at
    order by w.sort_key desc, w.id desc
    limit 1;
  end if;
  select pl.new_sort_key into new_sort_key
  from private.place_in_queue(p_visit.queue_id, p_visit.service_day, p_visit.id, v_after) pl;
end $$;
comment on function private.check_in_place(app.visits) is
  'The sort_key a checked-in expected visit takes, and whether it is late. Not exposed.';
revoke all on function private.check_in_place(app.visits) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- Staff check-in: api.transition_visit action check_in
------------------------------------------------------------------------------------------------

-- redefines api.transition_visit from 20261030063127_call_next_resources.sql
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
  v_sort bigint;
  v_late boolean;
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

  -- Checking in files the visit by its schedule (or at the end when late).
  if p_action = 'check_in' then
    perform private.set_actor('staff', (select auth.uid()), 'check_in');
    select cp.new_sort_key, cp.late into v_sort, v_late from private.check_in_place(v) cp;
  end if;

  perform private.set_actor('staff', (select auth.uid()), p_action::text, v_reason,
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
-- Guest check-in: api.guest_act action check_in
------------------------------------------------------------------------------------------------

-- redefines api.guest_act from 20261030075000_guest_act_snooze.sql
create or replace function api.guest_act(p_token text, p_action api.guest_action, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  q app.queues;
  v_after uuid;
  v_sort bigint;
  v_requeue boolean;
  v_late boolean;
begin
  if p_action is null then
    raise exception 'invalid_input';
  end if;
  -- A snooze or a check-in reorders the queue, which locks the queue row; take it before the visit's, the order
  -- every other reorder uses, so two guests (or a guest and a staff move) cannot deadlock.
  if p_action in ('need_more_time', 'check_in') then
    perform 1 from app.queues where id = (private.visit_by_token(p_token)).queue_id for update;
  end if;
  v := private.visit_by_token(p_token, true);

  -- One branch per api.guest_action value. Each must be safe to repeat by itself: guests have no
  -- auth.uid(), so the staff idempotency table cannot hold their keys.
  case p_action
    when 'leave' then
      if v.status = 'cancelled' then
        return private.visit_status(v);
      end if;
      if not 'leave' = any (private.guest_actions(v.status)) then
        raise exception 'illegal_transition' using detail = format('leave from %s', v.status);
      end if;
      perform private.set_actor('guest', null, 'cancel');
      update app.visits set status = 'cancelled', finished_at = now()
      where id = v.id
      returning * into v;
    when 'on_my_way' then
      if p_idempotency_key is null then
        raise exception 'invalid_input';
      end if;
      if v.status not in ('waiting', 'called') then
        raise exception 'illegal_transition' using detail = format('on_my_way from %s', v.status);
      end if;
      -- Once per call: tapping again (or retrying) changes nothing and writes no second event.
      if exists (select 1 from app.visit_events e
                 where e.visit_id = v.id and e.type = 'on_my_way'
                   and (e.payload ->> 'call_count')::int = v.call_count) then
        return private.visit_status(v);
      end if;
      select * into q from app.queues where id = v.queue_id;
      perform private.set_actor('guest', null, 'on_my_way', null,
        jsonb_build_object('call_count', v.call_count, 'idempotency_key', p_idempotency_key));
      update app.visits
      set grace_until = case when status = 'called' and grace_until is not null
                             then grace_until + make_interval(mins => q.grace_minutes) else grace_until end
      where id = v.id
      returning * into v;
    when 'need_more_time' then
      if p_idempotency_key is null then
        raise exception 'invalid_input';
      end if;
      if v.status not in ('waiting', 'called') then
        raise exception 'illegal_transition' using detail = format('need_more_time from %s', v.status);
      end if;
      -- A repeated key is the same tap: no second snooze.
      if exists (select 1 from app.visit_events e
                 where e.visit_id = v.id and e.type in ('snoozed', 'requeue')
                   and e.payload ->> 'idempotency_key' = p_idempotency_key::text) then
        return private.visit_status(v);
      end if;
      select * into q from app.queues where id = v.queue_id;
      if v.snooze_count >= q.max_snoozes then
        raise exception 'snooze_limit_reached';
      end if;
      v_requeue := v.status = 'called';

      -- The guest files behind the next snooze_places waiting guests (all of them if fewer). A
      -- waiting guest counts those behind; a called guest, those waiting now.
      select w.id into v_after
      from app.visits w
      where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
        and w.id <> v.id and (v_requeue or (w.sort_key, w.id) > (v.sort_key, v.id))
      order by w.sort_key, w.id
      offset q.snooze_places - 1 limit 1;
      if v_after is null then
        select w.id into v_after
        from app.visits w
        where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
          and w.id <> v.id and (v_requeue or (w.sort_key, w.id) > (v.sort_key, v.id))
        order by w.sort_key desc, w.id desc
        limit 1;
      end if;
      if v_after is null and not v_requeue then
        return private.visit_status(v); -- nobody behind: nothing to give up, nothing used
      end if;

      v_sort := v.sort_key;
      if v_after is not null then
        v_sort := (select pl.new_sort_key
                   from private.place_in_queue(v.queue_id, v.service_day, v.id, v_after) pl);
      end if;
      perform private.set_actor('guest', null, case when v_requeue then 'requeue' else 'snoozed' end,
        case when v_requeue then 'need_more_time' end,
        jsonb_build_object('from_sort_key', v.sort_key, 'to_sort_key', v_sort,
                           'snooze_count', v.snooze_count + 1, 'idempotency_key', p_idempotency_key));
      update app.visits
      set sort_key = v_sort,
          snooze_count = snooze_count + 1,
          status = case when v_requeue then 'waiting' else status end,
          counter_id = case when v_requeue then null else counter_id end
      where id = v.id
      returning * into v;
    when 'check_in' then
      -- Repeating it, or a visit already in the line, changes nothing.
      if v.status in ('waiting', 'called', 'serving') then
        return private.visit_status(v);
      end if;
      if v.status <> 'expected' then
        raise exception 'illegal_transition' using detail = format('check_in from %s', v.status);
      end if;
      if v.scheduled_at is null or now() < v.scheduled_at - interval '30 minutes' then
        raise exception 'check_in_not_allowed';
      end if;
      perform private.set_actor('guest', null, 'check_in');
      select cp.new_sort_key, cp.late into v_sort, v_late from private.check_in_place(v) cp;
      perform private.set_actor('guest', null, 'check_in', null,
                                jsonb_strip_nulls(jsonb_build_object('late', case when v_late then true end)));
      update app.visits set status = 'waiting', sort_key = v_sort
      where id = v.id
      returning * into v;
  end case;

  perform private.bump_queue_version(v.queue_id);
  return private.visit_status(v);
end $$;
comment on function api.guest_act(text, api.guest_action, uuid) is
  'Applies a guest action to the token''s visit and returns the new status. leave moves waiting or '
  'called to cancelled (a guest-actor cancel event); leaving again returns cancelled without '
  'error or a new event. on_my_way (waiting or called) records an event and, for a called guest, '
  'extends grace_until by the queue''s grace_minutes, once per call. need_more_time files a waiting '
  'guest behind the next snooze_places guests (a called guest goes back to waiting the same way), '
  'at most max_snoozes times per visit: then snooze_limit_reached and nothing changes; with nobody '
  'behind it changes nothing. Both need a non-null p_idempotency_key (invalid_input otherwise) and '
  'a repeated key changes nothing. '
  'Raises not_found as get_visit_status does, invalid_input without an action, illegal_transition '
  'when the action no longer applies (e.g. already served). check_in turns an expected visit into a waiting one from 30 minutes before its '
  'scheduled_at, at the place the schedule earns or at the end of the line when late (repeating it, '
  'or a visit already in the line, is a no-op); check_in_not_allowed before that window. '
  'Check-in implemented in 2A-CHK1 (#149).';

notify pgrst, 'reload schema';
