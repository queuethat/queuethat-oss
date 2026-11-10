-- redefines api.call_next from 20261025001300_staff_transitions.sql
-- Fix: the pick locked with FOR UPDATE SKIP LOCKED, which conflicts with the FOR KEY SHARE that a
-- foreign-key check takes on the visit row (the almost_up notification insert, for one). A
-- guest's row held that way was skipped, so a staff tablet called the second guest over the
-- first. FOR NO KEY UPDATE still excludes a concurrent caller (it conflicts with itself) and the
-- UPDATE below changes no key column, but it does not conflict with FOR KEY SHARE.
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
  -- NO KEY UPDATE, not UPDATE: a foreign-key check's KEY SHARE on the row must not make us skip it.
  select v.id into v_id
  from app.visits v
  where v.queue_id = q.id
    and v.status = 'waiting'
    and v.service_day = private.service_day(q.location_id)
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
  'Calls the first waiting visit of the queue''s current service day, by position, to '
  'p_counter_id (or to no counter when null) and returns it, or null when nobody is waiting. '
  'Concurrent callers always get different visits; repeating a key returns the first result, '
  'including a null one. Raises not_found for a queue or counter outside the caller''s locations '
  '(staff or above), invalid_input without a key. Implemented in V2 (#31).';

