-- 3-CG6 (#331): what the join and status pages need to offer and record text consent.
--
--   * The consent text names the business as the guest's pages know it: the location's name and
--     contact (api.get_location_public, api.get_visit_info), so the client renders and hashes the
--     same words the server does.
--   * api.visit_status says whether texts are on for the guest's number, so the status page can
--     offer to turn them on without a second read: none (no number), off (a number, no granted
--     consent) or on.

-- redefines private.render_consent_text from 20261030220117_consent_texts.sql
create or replace function private.render_consent_text(
  p_location_id uuid, p_channel app.notification_channel, p_purpose app.message_category, p_locale text, p_version int
) returns text
language sql stable set search_path = '' as $$
  select replace(replace(t.body, '{{business_name}}', l.name), '{{support_contact}}', coalesce(l.contact, l.name))
  from app.consent_texts t
  join app.locations l on l.id = p_location_id
  where t.channel = p_channel and t.purpose = p_purpose and t.locale = p_locale and t.version = p_version
$$;
comment on function private.render_consent_text(uuid, app.notification_channel, app.message_category, text, int) is
  'The exact opt-in text shown for a location: the published body with the location name and its contact (or its name) filled in; null when that version is not published. The consent hash is the sha256 hex of this text.';

create function private.text_consent_state(p_visit app.visits) returns text
language sql stable set search_path = '' as $$
  select case
    when p_visit.guest_phone_e164 is null and p_visit.contact_id is null then 'none'
    when coalesce((select c.status = 'granted' and c.revoked_at is null
                   from app.consents c
                   where c.contact_id = p_visit.contact_id and c.channel = 'sms' and c.purpose = 'transactional'
                   order by c.captured_at desc limit 1), false) then 'on'
    else 'off'
  end
$$;
revoke all on function private.text_consent_state(app.visits) from public, anon, authenticated;
comment on function private.text_consent_state(app.visits) is
  'none: the visit has no number; on: the number has a granted sms consent; off: a number without one.';

alter type api.visit_status add attribute text_consent text;

-- redefines private.visit_status from 20261030194410_join_later_leave.sql
create or replace function private.visit_status(p_visit app.visits) returns api.visit_status
language sql stable set search_path = '' as $$
  select p_visit.display_ticket, p_visit.status, pos.n, pos.n - 1,
         e.eta_state, e.eta_low, e.eta_high,
         case when p_visit.status in ('called', 'serving') then c.label end,
         p_visit.call_count, p_visit.called_at, q.name, l.name, q.pulse_id,
         case when q.max_snoozes = 0
              then array_remove(private.guest_actions(p_visit.status), 'need_more_time'::api.guest_action)
              else private.guest_actions(p_visit.status) end
         -- Joined for later (J-13): may leave before their time.
         || case when p_visit.status = 'expected' and p_visit.arrive_after is not null
                 then array['leave']::api.guest_action[] else '{}'::api.guest_action[] end,
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
         private.text_consent_state(p_visit)
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
  'chat off (so clients hide chat), and unread_staff_messages the staff messages not yet fetched, and text_consent is none, off or on for texts about this visit.';
