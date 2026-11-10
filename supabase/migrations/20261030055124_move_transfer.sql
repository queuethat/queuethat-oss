-- 2A-ST1 (#134): api.move_visit and api.transfer_visit, and undo for both (technical-design.md 4.1).
--
-- Order is sort_key; position is computed, never stored. A move takes a midpoint between the new
-- neighbours and renumbers the queue's waiting visits (spacing 1024) in the same transaction when
-- no gap is left. A transfer changes queue_id (and maybe service), keeps joined_at and files the
-- visit among the target queue's waiting visits by joined_at. Both are events, not states:
-- 'moved' and 'transferred' leave the status alone (private.guard_visit allows any non-action name).

------------------------------------------------------------------------------------------------
-- Placement shared by move, transfer and undo
------------------------------------------------------------------------------------------------

/**
 * The sort_key that files p_visit_id right after p_after_id (null = at the front) among the
 * waiting visits of (queue, service day), p_visit_id itself excluded. Takes the midpoint of the
 * gap; with no gap it renumbers the others to 1024, 2048, ... leaving a slot, writing one
 * 'renumbered' event per visit it touches. Locks the queue row so concurrent reorders serialize.
 */
create function private.place_in_queue(
  p_queue_id uuid,
  p_service_day date,
  p_visit_id uuid,
  p_after_id uuid,
  out new_sort_key bigint,
  out renumbered boolean
)
language plpgsql volatile set search_path = '' as $$
declare
  v_prev bigint;
  v_next bigint;
  v_rank int := 0;
begin
  perform 1 from app.queues where id = p_queue_id for update;
  renumbered := false;

  if p_after_id is null then
    select min(w.sort_key) into v_next
    from app.visits w
    where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
      and w.id <> p_visit_id;
    new_sort_key := coalesce(v_next - 1024, 1024);
    return;
  end if;

  select w.sort_key into v_prev from app.visits w where w.id = p_after_id;
  select min(w.sort_key) into v_next
  from app.visits w
  where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
    and w.id <> p_visit_id
    and (w.sort_key, w.id) > (v_prev, p_after_id);

  if v_next is null then
    new_sort_key := v_prev + 1024;
  elsif v_next - v_prev >= 2 then
    new_sort_key := v_prev + (v_next - v_prev) / 2;
  else
    -- No gap: spread the queue out again, leaving the slot after p_after_id for the visit.
    select count(*)::int into v_rank
    from app.visits w
    where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
      and w.id <> p_visit_id and (w.sort_key, w.id) <= (v_prev, p_after_id);
    perform private.set_actor('staff', (select auth.uid()), 'renumbered', null,
                              jsonb_build_object('caused_by_visit_id', p_visit_id));
    update app.visits x
    set sort_key = (o.r + case when o.r > v_rank then 1 else 0 end) * 1024
    from (
      select w.id, row_number() over (order by w.sort_key, w.id) as r
      from app.visits w
      where w.queue_id = p_queue_id and w.service_day = p_service_day and w.status = 'waiting'
        and w.id <> p_visit_id
    ) o
    where x.id = o.id;
    new_sort_key := (v_rank + 1) * 1024;
    renumbered := true;
  end if;
end $$;
comment on function private.place_in_queue(uuid, date, uuid, uuid) is
  'The sort_key for p_visit_id filed right after p_after_id (null = front) among the queue''s '
  'waiting visits of the service day, and whether it had to renumber the others to make room. '
  'Writes nothing for the visit itself; the caller sets the actor and updates it. Not exposed.';

/**
 * The sort_key an undone move or transfer goes back to: the one it had, unless that key is now
 * taken (or a renumbering made it meaningless), in which case it is filed again right after the
 * visit that preceded it. undo_not_allowed when that visit has left the line too.
 */
create function private.restore_sort_key(p_prior app.visits, p_event app.visit_events)
returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  v_key bigint := (p_event.payload ->> 'from_sort_key')::bigint;
  v_after uuid := (p_event.payload ->> 'from_after_visit_id')::uuid;
begin
  if (p_event.type = 'moved' and coalesce((p_event.payload ->> 'renumbered')::boolean, false))
     or exists (
       select 1 from app.visits w
       where w.queue_id = p_prior.queue_id and w.service_day = p_prior.service_day
         and w.status = 'waiting' and w.sort_key = v_key and w.id <> p_prior.id) then
    if v_after is not null and not exists (
      select 1 from app.visits w
      where w.id = v_after and w.queue_id = p_prior.queue_id and w.service_day = p_prior.service_day
        and w.status = 'waiting') then
      raise exception 'undo_not_allowed';
    end if;
    return (select p.new_sort_key
            from private.place_in_queue(p_prior.queue_id, p_prior.service_day, p_prior.id, v_after) p);
  end if;
  return v_key;
end $$;
comment on function private.restore_sort_key(app.visits, app.visit_events) is
  'Where an undone moved or transferred visit goes back in its queue. Not exposed.';

revoke all on function private.place_in_queue(uuid, date, uuid, uuid) from public, anon, authenticated;
revoke all on function private.restore_sort_key(app.visits, app.visit_events) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.move_visit (signature and grants from 2A-API2, 20261030045508_api_contracts_2a.sql)
------------------------------------------------------------------------------------------------

-- redefines api.move_visit from 20261030045508_api_contracts_2a.sql
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
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
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
  update app.visits set sort_key = pl.new_sort_key where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('move_visit', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.move_visit(uuid, uuid, int, uuid) is
  'Moves a waiting visit to just after p_after_visit_id in its queue (null = to the front) and '
  'returns its row; last_event_id is the moved event, which undo_event reverses for 10 minutes. '
  'The sort_key becomes the midpoint of the new neighbours; with no gap the queue''s waiting '
  'visits are renumbered in the same transaction (one renumbered event each). Already in that '
  'place is a no-op (last_event_id null). Staff of the location. Raises stale_visit when '
  'p_expected_version is old or p_after_visit_id is no longer waiting, illegal_transition unless '
  'the visit is waiting, invalid_input without a version or key or when after is the visit '
  'itself, not_found for unknown or foreign visits and for an after visit of another queue. '
  'Idempotent per key. Implemented in 2A-ST1 (#134).';

------------------------------------------------------------------------------------------------
-- api.transfer_visit (signature and grants from 2A-API2)
------------------------------------------------------------------------------------------------

-- redefines api.transfer_visit from 20261030045508_api_contracts_2a.sql
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
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_to_queue_id is null or p_expected_version is null or p_idempotency_key is null then
    raise exception 'invalid_input';
  end if;
  select * into tq from app.queues
  where id = p_to_queue_id and org_id = v.org_id and location_id = v.location_id
    and archived_at is null;
  if not found
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
comment on function api.transfer_visit(uuid, uuid, uuid, int, uuid) is
  'Moves a waiting visit to another queue of the same location, or to another service of its own '
  'queue (a transferred event, not a state), and returns its row. joined_at is kept and the visit '
  'is filed among the target''s waiting visits by it; the ticket is kept unless the target queue '
  'issues the same prefix or already holds that number, then the target issues the next one. '
  'p_to_service_id must be an active service of the target queue; null keeps the service within '
  'one queue and leaves it unset across queues. Both queues'' versions are bumped; undo_event '
  'reverses it for 10 minutes. Same queue and service is a no-op (last_event_id null). Staff of '
  'the location. Raises stale_visit, illegal_transition unless waiting, invalid_input without a '
  'queue, version or key, queue_not_accepting when the other queue takes no joins, not_found for '
  'unknown or foreign visits, queues (also archived or of another location) and services. '
  'Idempotent per key. Implemented in 2A-ST1 (#134).';

------------------------------------------------------------------------------------------------
-- Undo of moved and transferred
------------------------------------------------------------------------------------------------

-- redefines private.undo_target from 20261025001500_undo.sql
create or replace function private.undo_target(p_visit app.visits, p_event app.visit_events)
returns app.visits
language plpgsql stable set search_path = '' as $$
declare
  prior app.visits := p_visit;
begin
  prior.status := p_event.from_status;
  -- Staff events record the counter they left; call_next leaves waiting, which has none.
  prior.counter_id := (p_event.payload ->> 'previous_counter_id')::uuid;
  if p_event.type in ('call', 'recall') then
    prior.call_count := p_visit.call_count - 1;
  end if;
  if p_event.type = 'call' then
    prior.called_at := (
      select max(e.occurred_at) from app.visit_events e
      where e.visit_id = p_visit.id and e.id < p_event.id and e.type = 'call'
        and e.undone_by_event_id is null
    );
  end if;
  if p_event.type = 'start' then
    prior.serving_at := null;
    prior.assigned_staff_id := null;
  end if;
  -- Only reinstate leaves a finished status; going back restores when the visit finished.
  prior.finished_at := case when p_event.type = 'reinstate' then (
    select max(e.occurred_at) from app.visit_events e
    where e.visit_id = p_visit.id and e.id < p_event.id and e.to_status = p_event.from_status
      and e.type <> 'undo' and e.undone_by_event_id is null
  ) end;
  -- A move or transfer leaves the status alone; it goes back to the place, queue and ticket the
  -- payload recorded (api.undo_event then re-files the sort_key if that place was taken).
  if p_event.type in ('moved', 'transferred') then
    prior.counter_id := p_visit.counter_id;
    prior.finished_at := p_visit.finished_at;
    prior.sort_key := (p_event.payload ->> 'from_sort_key')::bigint;
  end if;
  if p_event.type = 'transferred' then
    prior.queue_id := (p_event.payload ->> 'from_queue_id')::uuid;
    prior.service_id := (p_event.payload ->> 'from_service_id')::uuid;
    prior.ticket_number := (p_event.payload ->> 'from_ticket_number')::int;
    prior.display_ticket := p_event.payload ->> 'from_display_ticket';
  end if;
  return prior;
end $$;
comment on function private.undo_target(app.visits, app.visit_events) is
  'The visit as it was before p_event (its latest event): previous status, counter, call_count, '
  'called_at, serving_at, assigned staff and finished_at; for moved and transferred events also '
  'sort_key, queue, service and ticket. Staff actions other than those leave sort_key alone, so '
  'the place in line comes back as it was.';
revoke all on function private.undo_target(app.visits, app.visit_events) from public, anon, authenticated;

-- redefines api.undo_event from 20261025003620_support_grants.sql
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
  if v.id is null or not private.has_role(v.org_id, v.location_id, 'staff') then
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
  if e.actor_kind not in ('staff', 'platform')
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
comment on function api.undo_event(bigint, uuid) is
  'Reverses a staff action on a visit (call, recall, start, requeue, complete, no_show, cancel, '
  'remove, reinstate, check_in, moved, transferred) by writing a compensating ''undo'' event and '
  'restoring the previous status, counter, call count and timestamps; the place in line is '
  'unchanged, so a visit called by mistake is waiting where it was. A moved or transferred visit '
  'goes back to its queue, service, ticket and place (filed after its old predecessor if the '
  'exact place was taken). The original event gets undone_by_event_id. '
  'Returns the updated row. Repeating a key returns the first result. Raises not_found for an '
  'event outside the caller''s locations (staff or above; no existence leak), invalid_input '
  'without a key, undo_not_allowed when the event is not the visit''s latest (anything changed '
  'since, including an earlier undo), is older than 10 minutes, is not a staff action '
  '(support actions through a grant count as staff actions), or a moved or renumbered place '
  'cannot be restored because its old predecessor left the line. '
  'Implemented in V3 (#32), extended in 2A-ST1 (#134).';

notify pgrst, 'reload schema';
