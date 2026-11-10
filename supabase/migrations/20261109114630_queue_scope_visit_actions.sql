-- M2b-1 (#1329): the queue scope from M1/M2 also binds undo, assignment, notes and priority.
-- With organizations.scope_staff_to_lines off nothing changes. With it on, a scoped staff member gets
-- not_found for a visit outside their queue_ids; unscoped staff and managers are unaffected.
-- Only the staff has_role test changes, to private.has_queue_access; signatures, grants and comments stay.
--
-- Alternatives (rule 7): one scope check inside a shared helper called by every staff function (rejected:
-- each function loads its own visit row first, so the check belongs beside that lookup) vs replacing the
-- has_role test in each entry point (chosen, as in M2).

-- redefines api.undo_event from 20261030064300_auto_no_show.sql
create or replace function api.undo_event(p_event_id bigint, p_idempotency_key uuid) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  e app.visit_events;
  v app.visits;
  prior app.visits;
  claim record;
  result api.visit_row;
begin
  select * into e from app.visit_events where id = p_event_id;
  if found then
    select * into v from app.visits where id = e.visit_id;
  end if;
  if v.id is null or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'undo_event', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  -- Lock the visit, then re-read the event: an undo or action that committed meanwhile shows.
  select * into v from app.visits where id = e.visit_id for update;
  select * into e from app.visit_events where id = p_event_id;
  -- Reversible: a staff action (or support's, through a grant) (not joins, undos, edits or system expiry) that is still the
  -- visit's latest event and under 10 minutes old.
  if (e.actor_kind not in ('staff', 'platform')
      and not (e.actor_kind = 'system' and e.type = 'no_show' and e.reason = 'grace_expired'))
     or e.type not in ('call', 'recall', 'start', 'requeue', 'complete', 'no_show', 'cancel',
                       'remove', 'reinstate', 'check_in', 'moved', 'transferred')
     or e.undone_by_event_id is not null
     or e.occurred_at < now() - interval '10 minutes'
     or e.id <> (select max(x.id) from app.visit_events x where x.visit_id = v.id) then
    raise exception 'undo_not_allowed';
  end if;

  prior := private.undo_target(v, e);
  if e.type in ('moved', 'transferred') then
    prior.sort_key := private.restore_sort_key(prior, e);
  end if;
  perform private.set_actor('staff', (select auth.uid()), 'undo', null,
                            jsonb_build_object('undoes_event_id', e.id, 'undoes_type', e.type));
  update app.visits
  set status = prior.status,
      queue_id = prior.queue_id,
      service_id = prior.service_id,
      sort_key = prior.sort_key,
      ticket_number = prior.ticket_number,
      display_ticket = prior.display_ticket,
      counter_id = prior.counter_id,
      call_count = prior.call_count,
      called_at = prior.called_at,
      serving_at = prior.serving_at,
      assigned_staff_id = prior.assigned_staff_id,
      finished_at = prior.finished_at
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);
  if prior.queue_id <> v.queue_id then
    perform private.bump_queue_version(prior.queue_id);
  end if;

  result := private.visit_row(v.id);
  update app.visit_events set undone_by_event_id = result.last_event_id where id = e.id;
  perform private.save_idempotent('undo_event', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

-- redefines api.assign_visit from 20261030063127_call_next_resources.sql
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
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
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

-- redefines api.update_visit_notes from 20261030073600_notes_history.sql
create or replace function api.update_visit_notes(
  p_visit_id uuid,
  p_notes text,
  p_tags text[],
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_notes text := nullif(btrim(p_notes), '');
  v_tags text[];
  v_changed text[] := '{}';
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or length(p_notes) > 2000
     or length(v_notes) > 1000 or cardinality(p_tags) > 50 then
    raise exception 'invalid_input';
  end if;
  if p_tags is not null then
    -- Trimmed, blanks dropped, duplicates (ignoring case) dropped, first spelling and order kept.
    select coalesce(array_agg(d.t order by d.o), '{}') into v_tags
    from (
      select distinct on (lower(btrim(u.x))) btrim(u.x) as t, u.o
      from unnest(p_tags) with ordinality as u(x, o)
      where btrim(u.x) <> ''
      order by lower(btrim(u.x)), u.o
    ) d;
    if not private.valid_tags(v_tags) then
      raise exception 'invalid_input';
    end if;
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'update_visit_notes', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  -- Retention has cleared this visit; text added now would never be cleared again.
  if v.anonymized_at is not null then
    raise exception 'invalid_input';
  end if;

  -- A null argument leaves that field as it is; '' or '{}' clears it.
  if p_notes is not null and v_notes is distinct from v.notes then
    v_changed := v_changed || array['notes'];
  end if;
  if p_tags is not null and v_tags is distinct from v.tags then
    v_changed := v_changed || array['tags'];
  end if;
  if cardinality(v_changed) = 0 then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('update_visit_notes', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'notes_updated', null,
                            jsonb_build_object('changed', to_jsonb(v_changed)));
  update app.visits
  set notes = case when p_notes is not null then v_notes else notes end,
      tags = case when p_tags is not null then v_tags else tags end
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('update_visit_notes', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

-- redefines api.set_visit_priority from 20261030170056_priority_classes.sql
create or replace function api.set_visit_priority(
  p_visit_id uuid,
  p_priority_class_id uuid,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  pc app.priority_classes;
  claim record;
  v_key bigint;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_queue_access(v.org_id, v.queue_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  if p_priority_class_id is not null then
    select * into pc from app.priority_classes
    where id = p_priority_class_id and org_id = v.org_id and location_id = v.location_id and active;
    if not found then
      raise exception 'not_found';
    end if;
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'set_visit_priority', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status <> 'waiting' then
    raise exception 'illegal_transition' using detail = format('priority from %s', v.status);
  end if;

  if v.priority_class_id is not distinct from p_priority_class_id then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('set_visit_priority', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  v_key := v.sort_key;
  if not v.manually_ordered then
    v_key := private.priority_sort_key(v.queue_id, v.service_day, v.id, v.joined_at, pc.offset_minutes);
  end if;
  perform private.set_actor('staff', (select auth.uid()), 'priority_changed', null,
    jsonb_build_object('from_priority_class_id', v.priority_class_id,
                       'to_priority_class_id', p_priority_class_id,
                       'from_sort_key', v.sort_key, 'to_sort_key', v_key));
  update app.visits set priority_class_id = p_priority_class_id, sort_key = v_key where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('set_visit_priority', p_idempotency_key, to_jsonb(result));
  return result;
end $$;

