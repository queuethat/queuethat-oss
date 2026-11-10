-- 2B-Q5 (#230): round-robin and least-busy counter assignment. A queue with a strategy gives each
-- new waiting visit an assigned counter (an `assigned` event, not a state); call_next then offers a
-- counter its own assigned visits before unassigned ones. The assignment is an AFTER INSERT
-- trigger, so every join path gets it without editing private.join_core.
-- redefines api.call_next from 20261030110501_unified_fairness.sql

create type app.assignment_strategy as enum ('none', 'round_robin', 'least_busy');
alter table app.queues
  add column assignment_strategy app.assignment_strategy not null default 'none',
  add column rr_cursor uuid;
comment on column app.queues.assignment_strategy is
  'How arriving visits get an assigned counter: none, round_robin over the working counters, or least_busy.';
comment on column app.queues.rr_cursor is 'The counter the last round-robin assignment went to.';

/** The counter a new visit of the queue should be assigned to, or null for none / no candidate. */
create function private.assign_counter(p_queue_id uuid, p_service_id uuid default null) returns uuid
language plpgsql volatile set search_path = '' as $$
declare
  q app.queues;
  ids uuid[];
  pick uuid;
  idx int;
begin
  select * into q from app.queues where id = p_queue_id for update;
  if not found or q.assignment_strategy = 'none' then
    return null;
  end if;

  -- Counters that can serve the service. When anyone at the location reported presence recently,
  -- only counters with an available person (at the counter, or the counter's own member) count;
  -- if that leaves nobody, every eligible counter does.
  select array_agg(c.id order by c.sort_order, c.id) into ids
  from app.counters c
  where c.location_id = q.location_id and c.active and c.archived_at is null
    and private.visit_eligible(p_service_id, null, null, c.id, c.member_user_id);
  if ids is null then
    return null;
  end if;
  if exists (select 1 from app.staff_presence p where p.location_id = q.location_id
             and p.updated_at > now() - interval '12 hours') then
    select array_agg(c.id order by c.sort_order, c.id) into ids
    from app.counters c
    where c.id = any (ids) and exists (
      select 1 from app.staff_presence p
      where p.location_id = q.location_id and p.status = 'available' and p.updated_at > now() - interval '12 hours'
        and (p.counter_id = c.id or p.user_id = c.member_user_id))
    having count(*) > 0;
    if ids is null then
      select array_agg(c.id order by c.sort_order, c.id) into ids
      from app.counters c
      where c.location_id = q.location_id and c.active and c.archived_at is null
        and private.visit_eligible(p_service_id, null, null, c.id, c.member_user_id);
    end if;
  end if;

  if q.assignment_strategy = 'round_robin' then
    idx := coalesce(array_position(ids, q.rr_cursor), 0);
    pick := ids[(idx % cardinality(ids)) + 1];
    update app.queues set rr_cursor = pick where id = q.id;
  else
    select c.id into pick
    from unnest(ids) with ordinality as u(id, ord)
    join app.counters c on c.id = u.id
    order by (select count(*) from app.visits v
              where v.assigned_counter_id = c.id and v.status in ('waiting', 'called')), u.ord
    limit 1;
  end if;
  return pick;
end $$;
comment on function private.assign_counter(uuid, uuid) is
  'The counter for a new visit under the queue''s assignment_strategy: round_robin walks the '
  'candidate counters from rr_cursor (queue row locked), least_busy takes the one with the fewest '
  'waiting or called assigned visits. Candidates are active counters that can serve the service, '
  'narrowed to those with available staff once presence is reported. Null when the strategy is none '
  'or nothing qualifies.';
revoke all on function private.assign_counter(uuid, uuid) from public, anon, authenticated;

create function private.assign_new_visit() returns trigger
language plpgsql set search_path = '' as $$
declare
  counter uuid;
  saved text[];
  names constant text[] := array['app.actor_kind', 'app.actor_id', 'app.action', 'app.reason', 'app.event_payload'];
begin
  counter := private.assign_counter(new.queue_id, new.service_id);
  if counter is null then
    return null;
  end if;
  -- The join set its own actor context; give the assignment event its own and put the join's back.
  select array_agg(coalesce(current_setting(n, true), '')) into saved from unnest(names) n;
  perform private.set_actor('system', null, 'assigned', null,
                            jsonb_build_object('counter_id', counter, 'strategy',
                              (select q.assignment_strategy from app.queues q where q.id = new.queue_id)));
  update app.visits set assigned_counter_id = counter where id = new.id;
  perform set_config(names[i], saved[i], true) from generate_subscripts(names, 1) i;
  return null;
end $$;
comment on function private.assign_new_visit() is
  'AFTER INSERT on a waiting, unassigned visit: assigns it a counter by the queue''s strategy and '
  'records an assigned event, leaving the caller''s actor context as it was.';
revoke all on function private.assign_new_visit() from public, anon, authenticated;
create trigger assign_new_visit after insert on app.visits
  for each row when (new.status = 'waiting' and new.assigned_counter_id is null and new.assigned_staff_id is null)
  execute function private.assign_new_visit();

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

comment on function api.call_next(uuid, uuid, uuid) is
  'Calls the first eligible waiting visit of the queue''s current service day, by position, to '
  'p_counter_id (or to no counter when null) and returns it, or null when nobody eligible is '
  'waiting. A walk-in that has waited longer than its quote plus queues.max_walkin_delay_minutes '
  '(counted from when it last entered the line) goes first. Eligible: unassigned or assigned to that '
  'counter or to the caller, and the service has no mapped resources or the counter (or a staff resource '
  'of the caller) is mapped to it. Concurrent callers always get different visits; repeating a key returns '
  'the first result, including a null one. Raises not_found for a queue or counter outside the caller''s '
  'locations (staff or above), invalid_input without a key. Implemented in V2 (#31), 2A-Q2 (#101), ADR 0010. A visit assigned to p_counter_id is offered before unassigned ones (2B-Q5, #230).';

