-- 3-SMS6 (#355): two-way SMS commands. After the carrier keywords, a lone C / OK / COMING confirms
-- the sender's place and L / LEAVE leaves it; anything else gets one hint every 10 minutes.
-- Expand-only. CANCEL is an opt-out keyword and never a command.

alter table app.inbound_messages drop constraint inbound_messages_handled_as_check;
alter table app.inbound_messages add constraint inbound_messages_handled_as_check
  check (handled_as in ('stop', 'start', 'help', 'confirm', 'leave', 'join', 'unhandled', 'stored'));

-- The command words. Kept equal to packages/domain/src/sms/commands.ts by a drift test.
create function private.inbound_command_kind(p_body text) returns text
language sql immutable set search_path = '' as $$
  select k.kind
  from (values
    ('confirm'::text, array['C', 'OK', 'COMING']),
    ('leave'::text, array['L', 'LEAVE'])
  ) as k(kind, words)
  where upper(regexp_replace(coalesce(p_body, ''), '[^A-Za-z0-9]', '', 'g')) = any (k.words)
$$;
comment on function private.inbound_command_kind(text) is
  'confirm or leave when the whole message is a two-way command word; null otherwise. Carrier '
  'keywords are checked first and share no word with this list.';

-- System replies; an org can override any of them like other templates.
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple'));
insert into app.notification_templates (trigger, channel, body) values
  ('reply_confirmed', 'sms', 'Thanks, we''ll keep your place. See you soon!'),
  ('reply_left', 'sms', 'You''ve left the queue. Reply STOP to stop receiving messages.'),
  ('reply_commands', 'sms', 'Reply C if you''re on your way, L to leave the queue, or STOP to stop messages.'),
  ('reply_multiple', 'sms', 'You''re in more than one queue. Open the link in your latest message to choose.');

-- redefines private.template_variables from 20261030214739_inbound_keywords.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array['business_name', 'support_contact']
    when p_trigger like 'reply\_%' then array[]::text[]
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served',
                       'joined', 'no_show_warning') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- redefines api.outbox_still_relevant from 20261030214737_whatsapp_rules.sql
create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select (case
      -- A cancelled event's message is about the cancellation; it stands while the booking is cancelled.
      when n.appointment_id is not null and n.template_key = 'event_cancelled' then ap.status = 'cancelled'
      -- A slot offer is worth sending only while the guest's offer is still open.
      when n.appointment_id is not null and n.template_key = 'slot_offer' then
        ap.status::text = 'offered' and exists (select 1 from app.slot_waitlist w
                                                where w.appointment_id = ap.id and w.status = 'offered' and w.offer_expires_at > now())
      -- An appointment message goes only while the booking stands at the time it was queued for,
      -- and a reminder that quiet hours would hold back past the start is dropped, not sent late.
      when n.appointment_id is not null then
        ap.status = 'booked' and ap.starts_at > now()
        and floor(extract(epoch from ap.starts_at))::bigint = (n.vars ->> 'starts_epoch')::bigint
        and (n.channel = 'push' or n.template_key <> 'appointment_reminder'
             or private.quiet_hours_end(now(), l.tz) < ap.starts_at)
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- A reply to the guest's own HELP is not an alert: no preference or visit state applies.
      when n.template_key = 'help' or n.template_key like 'reply\_%' then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- The warning is about the current call: gone once the guest is served, left or was recalled.
      when n.template_key = 'no_show_warning' then v.status = 'called'
        and not exists (select 1 from app.visit_events l2
                        where l2.visit_id = v.id and l2.id > n.event_id and l2.type in ('call', 'recall'))
      -- Removal and service are about what happened; they stand unless the staff undid them.
      when n.template_key = 'removed' then v.status = 'removed' and e.undone_by_event_id is null
      when n.template_key = 'served' then v.status = 'served' and e.undone_by_event_id is null
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end)
    -- WhatsApp: consent, the 24 h window and an approved template are checked again at send time.
    and (n.channel <> 'whatsapp' or coalesce((
           select d.mode is not null
           from private.whatsapp_decision(n.org_id, n.recipient_ref, n.category, coalesce(v.queue_id, ap.queue_id),
                                          coalesce(v.locale, ap.locale, 'en'), n.template_key) d), false))
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.appointments ap on ap.id = n.appointment_id
    left join app.locations l on l.id = ap.location_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed or eta_changed once the guest is no longer waiting, called and no_show_warning after the guest moved on or was called again (called also after an undo), removed and served unless the staff undid them, a joined message for a finished visit, an appointment message whose booking changed (an event_cancelled message instead needs the booking cancelled), or an unknown id. Account mail and replies to a guest''s own text (help, reply_*) are always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 (#173), re-notify in 2P-NTF3 (#175), the remaining triggers in 2A-NT1 (#132), events in 2B-A3 (#278), a slot_offer message while its offer is open in 2B-A1 (#276), replies in 3-SMS6 (#355).';

create function private.enqueue_inbound_reply(p_visit app.visits, p_key text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t app.notification_templates;
begin
  select * into t from private.resolve_template(p_visit.org_id, p_visit.queue_id, p_key, 'sms', p_visit.locale);
  if not found then
    return;
  end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, dedupe_key)
  -- At most one of each reply per visit every 10 minutes, however fast the guest texts.
  values (p_visit.org_id, p_visit.id, 'sms', coalesce(p_visit.contact_id, p_visit.id), p_key, t.version, t.category,
          p_key || ':' || p_visit.id || ':' || floor(extract(epoch from now()) / 600))
  on conflict (dedupe_key) do nothing;
end $$;
revoke all on function private.enqueue_inbound_reply(app.visits, text) from public, anon, authenticated;

create function private.apply_inbound_command(p_inbound_id bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  v app.visits;
  q app.queues;
  n int;
  cmd text;
begin
  select * into m from app.inbound_messages where id = p_inbound_id;
  if not found then
    raise exception 'not_found';
  end if;
  cmd := private.inbound_command_kind(m.body);

  -- The sender's live places in THIS org only; another org's visit is never read.
  select count(*) into n from app.visits x
  where x.org_id = m.org_id and x.status in ('waiting', 'called')
    and (x.contact_id = m.matched_contact_id or (x.contact_id is null and x.guest_phone_e164 = m.from_value_e164))
    and (m.matched_contact_id is not null or x.contact_id is null);
  if n = 0 then
    return 'unhandled';
  end if;
  select x.* into v from app.visits x
  where x.org_id = m.org_id and x.status in ('waiting', 'called')
    and (x.contact_id = m.matched_contact_id or (x.contact_id is null and x.guest_phone_e164 = m.from_value_e164))
    and (m.matched_contact_id is not null or x.contact_id is null)
  order by x.joined_at desc, x.id limit 1;
  -- Queue row before visit row, the order every reorder uses, so this cannot deadlock with call_next.
  perform 1 from app.queues where id = v.queue_id for update;
  select x.* into v from app.visits x where x.id = v.id and x.status in ('waiting', 'called') for update;
  if not found then
    return 'unhandled'; -- it moved on while we waited for the lock
  end if;
  if n > 1 then
    -- Which place? Only the guest's status links can say; act on none (J-15).
    perform private.enqueue_inbound_reply(v, 'reply_multiple');
    return 'unhandled';
  end if;

  if cmd = 'confirm' then
    -- Once per call, like the status page's "I'm on my way" button.
    if not exists (select 1 from app.visit_events e
                   where e.visit_id = v.id and e.type = 'on_my_way' and (e.payload ->> 'call_count')::int = v.call_count) then
      select * into q from app.queues where id = v.queue_id;
      perform private.set_actor('guest', null, 'on_my_way', null,
        jsonb_build_object('call_count', v.call_count, 'source', 'sms'));
      update app.visits
      set grace_until = case when status = 'called' and grace_until is not null
                             then grace_until + make_interval(mins => q.grace_minutes) else grace_until end
      where id = v.id;
      perform private.bump_queue_version(v.queue_id);
    end if;
    perform private.enqueue_inbound_reply(v, 'reply_confirmed');
    return 'confirm';
  elsif cmd = 'leave' then
    perform private.set_actor('guest', null, 'cancel', null, jsonb_build_object('source', 'sms'));
    update app.visits set status = 'cancelled', finished_at = now() where id = v.id;
    perform private.bump_queue_version(v.queue_id);
    perform private.enqueue_inbound_reply(v, 'reply_left');
    return 'leave';
  end if;

  perform private.enqueue_inbound_reply(v, 'reply_commands');
  return 'unhandled';
end $$;
comment on function private.apply_inbound_command(bigint) is
  'Applies C / OK / COMING (the guest is on their way: extends a call''s grace once per call) or '
  'L / LEAVE (cancels the visit as the guest) to the sender''s single live place in the message''s '
  'org, and queues a short reply. Several live places: acts on none and replies reply_multiple. '
  'Other text: one reply_commands hint per 10 minutes. Returns confirm, leave or unhandled.';
revoke all on function private.apply_inbound_command(bigint) from public, anon, authenticated;

-- redefines api.process_inbound_message from 20261030214739_inbound_keywords.sql
create or replace function api.process_inbound_message(p_org_id uuid, p_channel text, p_from text, p_to text,
  p_body text, p_provider text, p_provider_message_id text) returns api.inbound_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_handled text;
  v_visit uuid;
begin
  if p_channel is distinct from 'sms' or p_from is null or p_from !~ '^\+[1-9][0-9]{6,14}$'
     or length(v_body) not between 1 and 1600 or coalesce(p_provider, '') = '' or coalesce(p_provider_message_id, '') = '' then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  select * into m from app.inbound_messages
  where org_id = p_org_id and provider = p_provider and provider_message_id = p_provider_message_id;
  if found then
    -- A replay: the first answer stands.
    return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
  end if;

  insert into app.inbound_messages (org_id, from_value_e164, to_address, body, provider, provider_message_id,
                                    signature_verified, matched_contact_id)
  values (p_org_id, p_from, p_to, v_body, p_provider, p_provider_message_id, true,
          (select gc.id from app.guest_contacts gc
           where gc.org_id = p_org_id and gc.channel = 'phone' and gc.value = p_from))
  on conflict (provider, provider_message_id) where provider is not null do nothing
  returning * into m;
  if not found then
    select * into m from app.inbound_messages
    where org_id = p_org_id and provider = p_provider and provider_message_id = p_provider_message_id;
    return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
  end if;

  v_handled := private.apply_inbound_keyword(m.id);
  if v_handled = 'stored' then
    -- Not a carrier keyword: a two-way command (C / L), else left for staff.
    v_handled := private.apply_inbound_command(m.id);
  end if;
  select x.id into v_visit from app.visits x
  where x.org_id = p_org_id and x.status in ('expected', 'waiting', 'called', 'serving')
    and (x.contact_id = m.matched_contact_id or (x.contact_id is null and x.guest_phone_e164 = p_from))
    and (m.matched_contact_id is not null or x.contact_id is null)
  order by x.joined_at desc, x.id limit 1;
  update app.inbound_messages set handled_as = v_handled, visit_id = v_visit where id = m.id
  returning * into m;
  return row(m.public_id, m.handled_as, m.matched_contact_id, m.visit_id)::api.inbound_result;
end $$;
comment on function api.process_inbound_message(uuid, text, text, text, text, text, text) is
  'Service role only (provider-webhook): stores an inbound SMS once per (provider, message id) and '
  'applies it in the same call: a carrier keyword (stop, start, help), else a two-way command '
  '(confirm, leave), else unhandled. A replay returns the first result. Raises invalid_input for a '
  'non-SMS channel, bad sender, empty or oversized body, not_found for an unknown org. Implemented in '
  '3-CG8 (#333), commands in 3-SMS6 (#355).';
