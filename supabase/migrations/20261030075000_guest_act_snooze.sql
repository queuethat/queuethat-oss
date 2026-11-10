-- 2A-GST1 (#122): guest_act on_my_way and need_more_time (G-4).
-- Snoozed and "on my way" are events, not states (technical-design.md 4.1). "Need more time" is also
-- the WCAG 2.2.1 extension for the automatic no-show limit (2A-Q6). Anyone holding the token can
-- snooze, so the effect is bounded: queues.max_snoozes per visit, each moving the guest back by
-- queues.snooze_places.
--
-- Alternative rejected: separate guest_snooze / guest_on_my_way RPCs. guest_act already carries every
-- guest action (technical-design.md 3.5) and the enum values exist since 2A-API1.

alter table app.queues
  add column snooze_places int not null default 2 check (snooze_places between 1 and 20),
  add column max_snoozes int not null default 2 check (max_snoozes between 0 and 10);
comment on column app.queues.snooze_places is
  'How many waiting guests a snoozing guest lets go ahead of them.';
comment on column app.queues.max_snoozes is
  'How many times one visit may snooze (need_more_time); 0 turns snoozing off.';

-- Hidden from API roles until the console needs it (visit_columns.test.sql).
alter table app.visits add column snooze_count int not null default 0;

------------------------------------------------------------------------------------------------
-- Which guest actions a status offers
------------------------------------------------------------------------------------------------

-- redefines private.guest_actions from 20261025000600_api_contracts.sql
create or replace function private.guest_actions(p_status api.visit_state) returns api.guest_action[]
language sql immutable set search_path = '' as $$
  select case p_status
    when 'waiting' then array['leave', 'need_more_time']::api.guest_action[]
    when 'called' then array['leave', 'on_my_way', 'need_more_time']::api.guest_action[]
    else '{}'::api.guest_action[] end
$$;
comment on function private.guest_actions(api.visit_state) is
  'Guest actions available in p_status. Clients show a button only when this contains its action; '
  'whether a snooze is still allowed (max_snoozes) is answered by guest_act with snooze_limit_reached.';

------------------------------------------------------------------------------------------------
-- place_in_queue: a renumber keeps the caller's actor (a guest), not always staff
------------------------------------------------------------------------------------------------

-- redefines private.place_in_queue from 20261030055124_move_transfer.sql
create or replace function private.place_in_queue(
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
    -- The caller's actor when it set one (a guest snoozing); a staff move sets its actor afterwards.
    perform private.set_actor(
      coalesce(nullif(current_setting('app.actor_kind', true), ''), 'staff')::app.actor_kind,
      case when coalesce(nullif(current_setting('app.actor_kind', true), ''), 'staff') = 'staff'
           then coalesce(nullif(current_setting('app.actor_id', true), '')::uuid, (select auth.uid()))
           else nullif(current_setting('app.actor_id', true), '')::uuid end,
      'renumbered', null, jsonb_build_object('caused_by_visit_id', p_visit_id));
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
  'Writes nothing for the visit itself; the caller sets the actor and updates it. A renumber is '
  'recorded under the actor the caller already set (a guest), else staff. Not exposed.';

------------------------------------------------------------------------------------------------
-- guest_act
------------------------------------------------------------------------------------------------

-- redefines api.guest_act from 20261030045508_api_contracts_2a.sql
create or replace function api.guest_act(p_token text, p_action api.guest_action, p_idempotency_key uuid)
returns api.visit_status
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  q app.queues;
  v_after uuid;
  v_sort bigint;
  v_requeue boolean;
begin
  if p_action is null then
    raise exception 'invalid_input';
  end if;
  -- A snooze reorders the queue, which locks the queue row; take it before the visit's, the order
  -- every other reorder uses, so two guests (or a guest and a staff move) cannot deadlock.
  if p_action = 'need_more_time' then
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
      raise exception 'not_implemented';
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
  'a repeated key changes nothing. check_in is reserved and raises not_implemented until 2A-CHK1. '
  'Raises not_found as get_visit_status does, invalid_input without an action, illegal_transition '
  'when the action no longer applies (e.g. already served).';
