-- Guest self check-in: a booked guest can check themselves in from their status page.
-- api.guest_act already accepts check_in; the window (30 minutes before the start) lived as a literal in its
-- body, so it moves into one helper that guest_act (to refuse) and visit_status (to offer) both call.
-- redefines api.guest_act from 20261102211109_guest_undo_leave.sql
-- redefines private.visit_status from 20261127005415_guest_late_state.sql

/** True while an expected, scheduled visit may be checked in by its guest. */
create function private.check_in_open(p_visit app.visits) returns boolean
language sql stable set search_path = '' as $$
  select p_visit.status = 'expected' and p_visit.scheduled_at is not null
         and now() >= p_visit.scheduled_at - interval '30 minutes'
$$;
comment on function private.check_in_open(app.visits) is
  'Whether the guest of an expected appointment visit may check in now: from 30 minutes before scheduled_at. Not exposed.';
revoke all on function private.check_in_open(app.visits) from public, anon, authenticated;

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
  ev app.visit_events;
begin
  if p_action is null then
    raise exception 'invalid_input';
  end if;
  -- A snooze or a check-in reorders the queue, which locks the queue row; take it before the visit's, the order
  -- every other reorder uses, so two guests (or a guest and a staff move) cannot deadlock.
  if p_action in ('need_more_time', 'check_in', 'undo_leave') then
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
      -- A guest who joined for later may leave before their time (J-13); an appointment may not.
      if not ('leave' = any (private.guest_actions(v.status))
              or (v.status = 'expected' and v.arrive_after is not null)) then
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
      if not private.check_in_open(v) then
        raise exception 'check_in_not_allowed';
      end if;
      perform private.set_actor('guest', null, 'check_in');
      select cp.new_sort_key, cp.late into v_sort, v_late from private.check_in_place(v) cp;
      perform private.set_actor('guest', null, 'check_in', null,
                                jsonb_strip_nulls(jsonb_build_object('late', case when v_late then true end)));
      update app.visits set status = 'waiting', sort_key = v_sort
      where id = v.id
      returning * into v;
    when 'undo_leave' then
      -- Back in the line (or a booked visit) already: repeating it changes nothing.
      if v.status in ('waiting', 'called', 'serving', 'expected') then
        return private.visit_status(v);
      end if;
      if not private.can_undo_leave(v) then
        raise exception 'illegal_transition' using detail = format('undo_leave from %s', v.status);
      end if;
      select * into ev from app.visit_events where visit_id = v.id order by id desc limit 1;
      perform private.set_actor('guest', null, 'undo', null,
        jsonb_build_object('undoes_event_id', ev.id, 'undoes_type', ev.type));
      -- The sort key is untouched, so the guest gets the old place back. A called guest goes back to waiting.
      update app.visits
      set status = case when ev.from_status = 'expected' then 'expected'::api.visit_state else 'waiting'::api.visit_state end,
          counter_id = null, finished_at = null
      where id = v.id
      returning * into v;
      update app.visit_events
      set undone_by_event_id = (select max(x.id) from app.visit_events x where x.visit_id = v.id)
      where id = ev.id;
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
  'Check-in implemented in 2A-CHK1 (#149). '
  'undo_leave takes back a leave the guest made themselves, for 10 minutes and while the visit is still of the '
  'current service day: the visit returns to waiting (or expected) at its old place and the leave event is '
  'marked undone; repeating it, or a visit already back in the line, is a no-op; once per visit, and not for a guest who left while called; illegal_transition once the '
  'window has passed, another event followed (staff removed or acted) or the visit never left.';

create or replace function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         -- need_more_time: not when snoozing is off, and not for a waiting guest who is not yet near
         -- the front (G-4): it would move them back from a place they are nowhere near losing.
         case when q.max_snoozes = 0 or (p_visit.status = 'waiting' and pos.n > 3)
              then array_remove(private.guest_actions(p_visit.status), 'need_more_time'::api.guest_action)
              else private.guest_actions(p_visit.status) end
         -- Joined for later (J-13): may leave before their time.
         || case when p_visit.status = 'expected' and p_visit.arrive_after is not null
                 then array['leave']::api.guest_action[] else '{}'::api.guest_action[] end
         -- Left by mistake: undo_leave for a few minutes (private.can_undo_leave).
         || case when private.can_undo_leave(p_visit)
                 then array['undo_leave']::api.guest_action[] else '{}'::api.guest_action[] end
         -- A booked guest may check themselves in from the window's start (private.check_in_open).
         || case when private.check_in_open(p_visit)
                 then array['check_in']::api.guest_action[] else '{}'::api.guest_action[] end,
         p_visit.version, now(),
         case when p_visit.status = 'called' then p_visit.grace_until end,
         case when p_visit.status = 'called' and p_visit.grace_until is not null
              then p_visit.grace_until - make_interval(secs => q.no_show_warning_seconds) end,
         case when p_visit.status in ('waiting', 'called') then greatest(q.max_snoozes - p_visit.snooze_count, 0) end,
         private.visit_on_the_way(p_visit.id, p_visit.status, p_visit.call_count),
         (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'first_name', k.first_name)
                                    order by k.created_at, k.id), '[]')
          from app.visit_companions k where k.visit_id = p_visit.id),
         case when q.chat_enabled then (select coalesce(max(m.id), 0) from app.visit_messages m where m.visit_id = p_visit.id) end,
         (select count(*)::int from app.visit_messages m
          where m.visit_id = p_visit.id and m.sender = 'staff' and m.read_at is null),
         p_visit.arrive_after,
         private.text_consent_state(p_visit),
         -- Appointment guests only: 'late' = not checked in and already past the queue's late tolerance
         -- (checking in now puts them at the end of the line); 'moved_back' = they checked in after it and were.
         case when p_visit.scheduled_at is null then null
              when p_visit.status = 'expected'
                   and now() > p_visit.scheduled_at + make_interval(mins => q.late_tolerance_minutes) then 'late'
              when p_visit.status in ('waiting', 'called')
                   and exists (select 1 from app.visit_events e
                               where e.visit_id = p_visit.id and e.type = 'check_in'
                                 and (e.payload ->> 'late')::boolean) then 'moved_back'
         end
  from app.queues q
  join app.locations l on l.id = q.location_id
  left join app.counters c on c.id = p_visit.counter_id
  cross join lateral (select private.visit_position(p_visit) as n) pos
  cross join lateral private.visit_eta(p_visit.id) e
  where q.id = p_visit.queue_id
$$;
comment on function private.visit_status(app.visits) is
  'The api.visit_status a guest sees for p_visit: no guest name, contact or other guests. The '
  'counter label only while called or serving; position and ETA only while waiting. While called: '
  'grace_until (arrive by) and warn_at (when to start warning); while waiting or called: '
  'snoozes_left; need_more_time is not offered when the queue allows no snoozes, nor to a waiting guest further back than third; on_the_way is '
  'true after on_my_way for the current call; companions is the party''s [{id, first_name}], '
  'for the token holder only; chat_version is the highest chat message id, null when the queue has '
  'chat off (so clients hide chat), and unread_staff_messages the staff messages not yet fetched, and text_consent is none, off or on for texts about this visit. guest_actions adds undo_leave for 10 minutes after the guest''s own leave, and check_in for a booked guest from 30 minutes before their start. '
  'late_state is late (an appointment guest not checked in past the queue''s late tolerance), moved_back (checked in after it, so placed at the end of the line) or null.';

notify pgrst, 'reload schema';
