-- V3 (#32): api.undo_event, the staff "undo" for a mis-tap (technical-design.md 3.5, 4.1).
--
-- Undo never deletes or edits history. It applies the inverse of the visit's latest event as a
-- new 'undo' event (private.guard_visit lets the 'undo' action restore any status) and marks the
-- original event undone_by_event_id. Every visit change writes exactly one event, so "the event
-- is the visit's latest" is the same check as "visit.version has not changed since".

/**
 * The visit columns as they were just before event p_event, given that p_event is the visit's
 * latest event and p_visit its current row. Status comes from the event; the columns an action
 * sets are rebuilt from the action's semantics and the effective (not undone) events before it.
 */
create function private.undo_target(p_visit app.visits, p_event app.visit_events)
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
  return prior;
end $$;
comment on function private.undo_target(app.visits, app.visit_events) is
  'The visit as it was before p_event (its latest event): previous status, counter, call_count, '
  'called_at, serving_at, assigned staff and finished_at. sort_key is never changed by a staff '
  'action, so the place in line comes back as it was.';
revoke all on function private.undo_target(app.visits, app.visit_events) from public, anon, authenticated;

------------------------------------------------------------------------------------------------
-- api.undo_event (signature and grants from S5, 20261025000600_api_contracts.sql)
------------------------------------------------------------------------------------------------

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
  -- Reversible: a staff action (not joins, undos, edits or system expiry) that is still the
  -- visit's latest event and under 10 minutes old.
  if e.actor_kind <> 'staff'
     or e.type not in ('call', 'recall', 'start', 'requeue', 'complete', 'no_show', 'cancel',
                       'remove', 'reinstate', 'check_in')
     or e.undone_by_event_id is not null
     or e.occurred_at < now() - interval '10 minutes'
     or e.id <> (select max(x.id) from app.visit_events x where x.visit_id = v.id) then
    raise exception 'undo_not_allowed';
  end if;

  prior := private.undo_target(v, e);
  perform private.set_actor('staff', (select auth.uid()), 'undo', null,
                            jsonb_build_object('undoes_event_id', e.id, 'undoes_type', e.type));
  update app.visits
  set status = prior.status,
      counter_id = prior.counter_id,
      call_count = prior.call_count,
      called_at = prior.called_at,
      serving_at = prior.serving_at,
      assigned_staff_id = prior.assigned_staff_id,
      finished_at = prior.finished_at
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  update app.visit_events set undone_by_event_id = result.last_event_id where id = e.id;
  perform private.save_idempotent('undo_event', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.undo_event(bigint, uuid) is
  'Reverses a staff action on a visit (call, recall, start, requeue, complete, no_show, cancel, '
  'remove, reinstate, check_in) by writing a compensating ''undo'' event and restoring the '
  'previous status, counter, call count and timestamps; the place in line is unchanged, so a '
  'visit called by mistake is waiting where it was. The original event gets undone_by_event_id. '
  'Returns the updated row. Repeating a key returns the first result. Raises not_found for an '
  'event outside the caller''s locations (staff or above; no existence leak), invalid_input '
  'without a key, undo_not_allowed when the event is not the visit''s latest (anything changed '
  'since, including an earlier undo), is older than 10 minutes, or is not a staff action. '
  'Implemented in V3 (#32).';
