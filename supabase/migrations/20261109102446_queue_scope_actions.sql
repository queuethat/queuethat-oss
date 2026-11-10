-- M2 (#1289): the queue scope from M1 now binds the staff actions and the staff-only reads.
-- With organizations.scope_staff_to_lines off (the default) nothing changes. With it on, a staff member who
-- has memberships.queue_ids gets not_found for a queue or visit outside that list; unscoped staff,
-- managers and above are unaffected. Transfer needs access to both the source and the target queue, so a
-- scoped member cannot push a guest into a line they cannot see; unscoped callers can transfer anywhere.
--
-- Alternatives (rule 7): a check inside private.transition_core (rejected: one core serves guests,
-- devices and the API too, and the scope is a staff rule) vs the check beside each staff entry point's
-- existing has_role test, delegated to private.has_queue_access (chosen).
--
-- Signatures, grants and comments are unchanged: create or replace keeps them.
-- redefines api.call_next from 20261031023511_custom_roles.sql
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
  if not found or not private.has_queue_access(q.org_id, q.id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_permission(q.org_id, q.location_id, 'visits.call') then
    raise exception 'permission_denied' using errcode = '42501';
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
  order by coalesce(v.assigned_counter_id = p_counter_id, false) desc,
           (v.scheduled_at is null
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

-- redefines api.transition_visit from 20261031023511_custom_roles.sql
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
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  -- Custom roles (4-RBAC1) can withhold calling and taking a guest off the line (remove, cancel); every other action stays staff-level.
  if (p_action in ('call', 'recall') and not private.has_permission(v.org_id, v.location_id, 'visits.call'))
     or (p_action in ('remove', 'cancel') and not private.has_permission(v.org_id, v.location_id, 'visits.remove')) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  return private.transition_core(p_visit_id, p_action, p_expected_version, p_idempotency_key,
                                 p_counter_id, p_reason, 'staff', (select auth.uid()));
end $$;

-- redefines api.transfer_visit from 20261030055124_move_transfer.sql
create or replace function api.transfer_visit(
  p_visit_id uuid,
  p_to_queue_id uuid,
  p_to_service_id uuid,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  tq app.queues;
  claim record;
  pl record;
  v_service uuid;
  v_after uuid;
  v_from_after uuid;
  v_sort bigint;
  v_number int;
  v_display text;
  v_renumbered boolean := false;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_to_queue_id is null or p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  select * into tq from app.queues
  where id = p_to_queue_id and org_id = v.org_id and location_id = v.location_id
    and archived_at is null;
  if not found or not private.has_queue_access(v.org_id, tq.id, 'staff')
     or (p_to_service_id is not null and not exists (
       select 1 from app.services s
       where s.id = p_to_service_id and s.org_id = v.org_id and s.queue_id = tq.id and s.active)) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'transfer_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('transfer from %s', v.status);
  end if;

  -- Services belong to one queue: moving queues without naming a service leaves it unset.
  v_service := case when p_to_service_id is not null then p_to_service_id
                    when tq.id = v.queue_id then v.service_id end;
  v_sort := v.sort_key;
  v_number := v.ticket_number;
  v_display := v.display_ticket;

  if tq.id = v.queue_id and v_service is not distinct from v.service_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('transfer_visit', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select w.id into v_from_after
  from app.visits w
  where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
    and (w.sort_key, w.id) < (v.sort_key, v.id)
  order by w.sort_key desc, w.id desc
  limit 1;

  if tq.id <> v.queue_id then
    if private.queue_not_accepting_reason(tq.id) is not null then
      raise exception 'queue_not_accepting';
    end if;
    -- Filed behind the last waiting visit that joined before this one.
    select w.id into v_after
    from app.visits w
    where w.queue_id = tq.id and w.service_day = v.service_day and w.status = 'waiting'
      and (w.joined_at, w.id) < (v.joined_at, v.id)
    order by w.sort_key desc, w.id desc
    limit 1;
    select * into pl from private.place_in_queue(tq.id, v.service_day, v.id, v_after);
    v_sort := pl.new_sort_key;
    v_renumbered := pl.renumbered;

    -- The ticket stays unless the target queue issues the same prefix (its counter would hand the
    -- same number out later) or already holds this number; then the target issues the next one.
    if tq.ticket_prefix = v.ticket_prefix or exists (
      select 1 from app.visits t
      where t.queue_id = tq.id and t.service_day = v.service_day
        and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v.ticket_number) then
      loop
        v_number := private.next_ticket(tq.id, v.ticket_prefix, v.service_day);
        exit when not exists (
          select 1 from app.visits t
          where t.queue_id = tq.id and t.service_day = v.service_day
            and t.ticket_prefix = v.ticket_prefix and t.ticket_number = v_number);
      end loop;
      v_display := v.ticket_prefix || lpad(v_number::text, greatest(3, length(v_number::text)), '0');
    end if;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'transferred', null,
    jsonb_build_object('from_queue_id', v.queue_id, 'to_queue_id', tq.id,
                       'from_service_id', v.service_id, 'to_service_id', v_service,
                       'from_sort_key', v.sort_key, 'to_sort_key', v_sort,
                       'from_after_visit_id', v_from_after, 'to_after_visit_id', v_after,
                       'from_ticket_number', v.ticket_number, 'to_ticket_number', v_number,
                       'from_display_ticket', v.display_ticket, 'to_display_ticket', v_display,
                       'renumbered', v_renumbered));
  update app.visits
  set queue_id = tq.id, service_id = v_service, sort_key = v_sort,
      ticket_number = v_number, display_ticket = v_display
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  if tq.id <> v.queue_id then
    perform private.bump_queue_version(tq.id);
  end if;

  result := private.visit_row(v.id);
  perform private.save_idempotent('transfer_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

-- redefines api.move_visit from 20261030170056_priority_classes.sql
create or replace function api.move_visit(
  p_visit_id uuid,
  p_after_visit_id uuid,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  a app.visits;
  claim record;
  pl record;
  v_from_after uuid;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or p_after_visit_id = p_visit_id then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'move_visit', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('move from %s', v.status);
  end if;

  if p_after_visit_id is not null then
    select * into a from app.visits
    where id = p_after_visit_id and org_id = v.org_id and queue_id = v.queue_id;
    if not found then
      raise exception 'not_found';
    end if;
    if a.status <> 'waiting' or a.service_day <> v.service_day then
      raise exception 'stale_visit';
    end if;
  end if;

  select w.id into v_from_after
  from app.visits w
  where w.queue_id = v.queue_id and w.service_day = v.service_day and w.status = 'waiting'
    and (w.sort_key, w.id) < (v.sort_key, v.id)
  order by w.sort_key desc, w.id desc
  limit 1;

  -- Already right behind p_after_visit_id (or already first): nothing to do, no event.
  if v_from_after is not distinct from p_after_visit_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('move_visit', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  select * into pl from private.place_in_queue(v.queue_id, v.service_day, v.id, p_after_visit_id);
  perform private.set_actor('staff', (select auth.uid()), 'moved', null,
    jsonb_build_object('from_sort_key', v.sort_key, 'to_sort_key', pl.new_sort_key,
                       'from_after_visit_id', v_from_after, 'to_after_visit_id', p_after_visit_id,
                       'renumbered', pl.renumbered));
  update app.visits set sort_key = pl.new_sort_key, manually_ordered = true where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('move_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;


-- Staff-only reads that name a visit follow the visit's queue (M1 covered visits and visit_answers).
-- Rows without a visit (account notifications, payments for an appointment) keep their old scope.
drop policy payments_select on app.payments;
create policy payments_select on app.payments for select to authenticated
  using (case when visit_id is null then (select private.has_role(org_id, location_id, 'staff'))
              else exists (select 1 from app.visits v
                           where v.id = visit_id and v.org_id = payments.org_id
                             and (select private.has_queue_access(v.org_id, v.queue_id, 'staff'))) end);

-- Replaces policy notifications_select from 20261025003800_account_emails.sql
drop policy notifications_select on app.notifications;
create policy notifications_select on app.notifications for select to authenticated
  using (case when visit_id is null then (select private.has_role(org_id, null, 'admin'))
              else exists (select 1 from app.visits v
                           where v.id = visit_id and v.org_id = notifications.org_id
                             and (select private.has_queue_access(v.org_id, v.queue_id, 'staff'))) end);

drop policy visit_feedback_select on app.visit_feedback;
create policy visit_feedback_select on app.visit_feedback for select to authenticated
  using (exists (select 1 from app.visits v
                 where v.id = visit_id and v.org_id = visit_feedback.org_id
                   and (select private.has_queue_access(v.org_id, v.queue_id, 'staff'))));
