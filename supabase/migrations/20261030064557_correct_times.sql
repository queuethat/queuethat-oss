-- 2A-ST12 (#145): api.correct_visit_times (feature S-18).
--
-- A forgotten "complete" must not poison reports forever, but a correction is never a silent
-- update: it is a times_corrected event carrying the before and after values and the reason.

-- redefines api.correct_visit_times from 20261030045508_api_contracts_2a.sql
create or replace function api.correct_visit_times(
  p_visit_id uuid,
  p_called_at timestamptz,
  p_serving_at timestamptz,
  p_finished_at timestamptz,
  p_reason text,
  p_expected_version int,
  p_idempotency_key uuid
) returns api.visit_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  claim record;
  v_reason text := nullif(btrim(p_reason), '');
  v_called timestamptz;
  v_serving timestamptz;
  v_finished timestamptz;
  result api.visit_row;
begin
  select * into v from app.visits where id = p_visit_id;
  if not found or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if p_expected_version is null or p_idempotency_key is null or v_reason is null
     or length(v_reason) > 500 then
    raise exception 'invalid_input';
  end if;
  -- Managers correct any visit of the location; staff only visits they acted on today.
  if not private.has_role(v.org_id, v.location_id, 'manager')
     and not (v.service_day = private.service_day(v.location_id)
              and exists (select 1 from app.visit_events e
                          where e.visit_id = v.id and e.actor_kind = 'staff'
                            and e.actor_id = (select auth.uid())
                            and e.type in ('call', 'recall', 'start', 'complete', 'no_show')
                            and e.undone_by_event_id is null)) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  select * into claim from private.claim_idempotent(v.org_id, 'correct_visit_times', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.visit_row, claim.response);
  end if;

  select * into v from app.visits where id = p_visit_id for update;
  if v.version <> p_expected_version then
    raise exception 'stale_visit';
  end if;
  if v.status not in ('served', 'no_show') then
    raise exception 'illegal_transition' using detail = format('correct times of a %s visit', v.status);
  end if;

  -- A null argument leaves that time as it is.
  v_called := coalesce(p_called_at, v.called_at);
  v_serving := coalesce(p_serving_at, v.serving_at);
  v_finished := coalesce(p_finished_at, v.finished_at);
  if (v.status = 'no_show' and p_serving_at is not null) or v_called < v.joined_at
     or v_serving < coalesce(v_called, v.joined_at)
     or v_finished < coalesce(v_serving, v_called, v.joined_at)
     or greatest(v_called, v_serving, v_finished) > now() then
    raise exception 'invalid_times';
  end if;

  if (v_called, v_serving, v_finished) is not distinct from (v.called_at, v.serving_at, v.finished_at) then
    result := private.visit_row(v.id);
    result.last_event_id := null;
    perform private.save_idempotent('correct_visit_times', p_idempotency_key, to_jsonb(result));
    return result;
  end if;

  perform private.set_actor('staff', (select auth.uid()), 'times_corrected', v_reason,
    jsonb_build_object(
      'before', jsonb_build_object('called_at', v.called_at, 'serving_at', v.serving_at, 'finished_at', v.finished_at),
      'after', jsonb_build_object('called_at', v_called, 'serving_at', v_serving, 'finished_at', v_finished),
      'excluded', false));
  update app.visits set called_at = v_called, serving_at = v_serving, finished_at = v_finished
  where id = v.id;
  perform private.bump_queue_version(v.queue_id);

  result := private.visit_row(v.id);
  perform private.save_idempotent('correct_visit_times', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
comment on function api.correct_visit_times(uuid, timestamptz, timestamptz, timestamptz, text, int, uuid) is
  'Corrects the called, serving and finished times of a served or no_show visit so reports stay '
  'true; a null time is left as it is. A reason is required and is recorded, with the before and '
  'after times, on a times_corrected event (payload excluded = false so analytics can still '
  'filter). Managers of the location correct any visit; staff only visits they called, started or finished (not undone) in '
  'the current service day. Times must satisfy joined_at <= called_at <= serving_at <= finished_at '
  'and not lie in the future; a no_show visit has no serving time (invalid_times). Raises invalid_input without a reason (or over 500 '
  'characters), version or key, stale_visit, illegal_transition for a visit that is not finished, '
  'permission_denied (42501) for staff who did not handle the visit, not_found for unknown or '
  'foreign visits. No change is a no-op (last_event_id null). Idempotent per key. '
  'Implemented in 2A-ST12 (#145).';

notify pgrst, 'reload schema';
