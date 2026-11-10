-- 2B-G4 follow-up: api.visit_status.chat_version is null while the queue has chat off, so the status
-- page can hide a chat button that could only answer chat_disabled. No type or signature change.

-- redefines private.visit_status from 20261030180718_join_later.sql
create or replace function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         case when q.max_snoozes = 0
              then array_remove(private.guest_actions(p_visit.status), 'need_more_time'::api.guest_action)
              else private.guest_actions(p_visit.status) end,
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
         p_visit.arrive_after
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
  'snoozes_left; need_more_time is not offered when the queue allows no snoozes; on_the_way is '
  'true after on_my_way for the current call; companions is the party''s [{id, first_name}], '
  'for the token holder only; chat_version is the highest chat message id, null when the queue has '
  'chat off (so clients hide chat), and unread_staff_messages the staff messages not yet fetched.';

notify pgrst, 'reload schema';
