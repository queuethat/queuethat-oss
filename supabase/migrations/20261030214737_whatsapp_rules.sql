-- 3-WA2 (#359): WhatsApp is sent only with whatsapp consent, and outside the 24 h customer service
-- window only through an approved template of the matching category (utility <-> transactional).
--
--   * app.whatsapp_templates maps one of our notification templates to the template Meta approved.
--   * guest_contacts.whatsapp_window_until is set by inbound messages (3-WA3, #360) to received_at + 24 h.
--   * A whatsapp notification is decided once at enqueue (before insert trigger, so every entry point
--     is covered): no consent -> suppressed no_consent; open window and transactional -> wa_mode
--     'session'; else an approved mapping -> 'template'; else suppressed no_approved_template.
--     Marketing never rides the session window. wa_mode is the enqueue-time decision.
--   * api.outbox_still_relevant, which the dispatcher calls before every send, runs the same decision
--     again, so a consent revoked, a mapping paused or a template rejected after queueing stops the send.

alter table app.guest_contacts add column whatsapp_window_until timestamptz;
alter table app.notifications add column wa_mode text check (wa_mode in ('template', 'session'));
grant select (wa_mode) on app.notifications to authenticated;

create table app.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  template_id uuid not null references app.notification_templates (id) on delete cascade,
  wa_name text not null check (wa_name ~ '^[a-z0-9_]{1,255}$'),
  wa_language text not null check (wa_language ~ '^[a-z]{2,3}(_[A-Za-z]{2,4})?$'),
  wa_category text not null check (wa_category in ('utility', 'marketing')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paused')),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, template_id),
  unique (org_id, wa_name, wa_language)
);
create trigger forbid_org_change before update on app.whatsapp_templates
  for each row execute function private.forbid_org_change();

create function private.validate_whatsapp_template() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare t app.notification_templates;
begin
  select * into t from app.notification_templates where id = new.template_id;
  if t.id is null or t.channel <> 'whatsapp' or (t.org_id is not null and t.org_id <> new.org_id) then
    raise exception 'invalid_template';
  end if;
  -- Meta bills and polices the two categories differently; ours must match what Meta approved.
  if (t.category = 'transactional') <> (new.wa_category = 'utility') then
    raise exception 'category_mismatch';
  end if;
  return new;
end $$;
revoke all on function private.validate_whatsapp_template() from public, anon, authenticated;
comment on function private.validate_whatsapp_template() is
  'Before insert/update on whatsapp_templates: the template must be a whatsapp template of the same org '
  '(or a system default), and wa_category must match its category (utility <-> transactional, marketing '
  '<-> marketing), else invalid_template or category_mismatch.';
create trigger validate_whatsapp_template before insert or update on app.whatsapp_templates
  for each row execute function private.validate_whatsapp_template();

alter table app.whatsapp_templates enable row level security;
create policy whatsapp_templates_select on app.whatsapp_templates for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
create policy whatsapp_templates_insert on app.whatsapp_templates for insert to authenticated
  with check ((select private.has_role(org_id, null, 'admin')));
create policy whatsapp_templates_update on app.whatsapp_templates for update to authenticated
  using ((select private.has_role(org_id, null, 'admin')))
  with check ((select private.has_role(org_id, null, 'admin')));
create policy whatsapp_templates_delete on app.whatsapp_templates for delete to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
revoke all on app.whatsapp_templates from public, anon, authenticated;
grant select, insert, update, delete on app.whatsapp_templates to authenticated;

/** The rule for one whatsapp message: how it may be sent (mode) or why not (reason). */
create function private.whatsapp_decision(
  p_org uuid, p_contact uuid, p_category app.message_category, p_queue uuid, p_locale text, p_template_key text
) returns table (mode text, reason text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce((select c.status = 'granted' and c.revoked_at is null
                   from app.consents c
                   where c.org_id = p_org and c.contact_id = p_contact and c.channel = 'whatsapp' and c.purpose = p_category
                   order by c.captured_at desc limit 1), false) then
    return query select null::text, 'no_consent'::text;
  elsif p_category = 'transactional' and coalesce((select gc.whatsapp_window_until > now()
                   from app.guest_contacts gc where gc.id = p_contact and gc.org_id = p_org), false) then
    return query select 'session'::text, null::text;
  elsif exists (select 1
                from private.resolve_template(p_org, p_queue, p_template_key, 'whatsapp', p_locale) t
                join app.whatsapp_templates w on w.template_id = t.id and w.org_id = p_org
                where w.status = 'approved'
                  and w.wa_category = case p_category when 'transactional' then 'utility' else 'marketing' end) then
    return query select 'template'::text, null::text;
  else
    return query select null::text, 'no_approved_template'::text;
  end if;
end $$;
revoke all on function private.whatsapp_decision(uuid, uuid, app.message_category, uuid, text, text)
  from public, anon, authenticated;
comment on function private.whatsapp_decision(uuid, uuid, app.message_category, uuid, text, text) is
  'Mode ''session'' (free text, transactional while the contact''s 24 h window is open) or ''template'' '
  '(an approved mapping of the matching category exists), else mode null with reason no_consent or '
  'no_approved_template. Consent is the latest whatsapp consent for the category, granted and unrevoked.';

create function private.enforce_whatsapp_rules() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  d record;
  v_queue uuid;
  v_locale text;
begin
  select coalesce(v.queue_id, ap.queue_id), coalesce(v.locale, ap.locale, 'en') into v_queue, v_locale
  from (select 1) y
  left join app.visits v on v.id = new.visit_id
  left join app.appointments ap on ap.id = new.appointment_id;
  select * into d from private.whatsapp_decision(new.org_id, new.recipient_ref, new.category, v_queue,
                                                 v_locale, new.template_key);
  if d.mode is null then
    new.status := 'suppressed';
    new.error_code := d.reason;
  else
    new.wa_mode := d.mode;
  end if;
  return new;
end $$;
revoke all on function private.enforce_whatsapp_rules() from public, anon, authenticated;
comment on function private.enforce_whatsapp_rules() is
  'Before insert on notifications (after enforce_category): a queued whatsapp row is stored suppressed '
  '(no_consent, no_approved_template) unless private.whatsapp_decision allows it, and records wa_mode.';
create trigger enforce_whatsapp before insert on app.notifications
  for each row when (new.channel = 'whatsapp' and new.status = 'queued')
  execute function private.enforce_whatsapp_rules();

-- redefines api.outbox_still_relevant from 20261030172458_slot_waitlist.sql
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
      when n.template_key = 'help' then true
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
