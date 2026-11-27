-- Gap 2 of the appointment vs walk-in follow-ups: the guest status page can tell an appointment guest that
-- they are late for their time (check in now and they go to the back) or were moved back after a late check-in.
-- The database decides; the client only renders late_state.
-- redefines private.visit_status from 20261122040341_guest_snooze_when_near.sql

alter type api.visit_status add attribute late_state text;

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
                 then array['undo_leave']::api.guest_action[] else '{}'::api.guest_action[] end,
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
  'chat off (so clients hide chat), and unread_staff_messages the staff messages not yet fetched, and text_consent is none, off or on for texts about this visit. guest_actions adds undo_leave for 10 minutes after the guest''s own leave. '
  'late_state is late (an appointment guest not checked in past the queue''s late tolerance), moved_back (checked in after it, so placed at the end of the line) or null.';

notify pgrst, 'reload schema';
