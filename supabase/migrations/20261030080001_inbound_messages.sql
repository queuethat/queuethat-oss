-- 2P-NTF10 (#182): dev SMS. Segments in dev_inbox, app.inbound_messages and simulated STOP/HELP.
-- Expand-only. Real inbound SMS (provider signatures, retention) is phase 3; until then rows are
-- written only by the dev-sms-inbound Edge Function, which refuses unless DEV_INBOX_ENABLED=true.

alter table app.dev_inbox
  add column encoding text check (encoding in ('gsm7', 'ucs2')),
  add column segments int check (segments >= 0);

create table app.inbound_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.organizations (id) on delete cascade,
  channel app.notification_channel not null default 'sms' check (channel = 'sms'),
  from_value_e164 text not null check (from_value_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  body text not null check (length(body) between 1 and 1600),
  raw_payload jsonb not null default '{}',
  signature_verified boolean not null default false,
  matched_contact_id uuid,
  received_at timestamptz not null default now(),
  foreign key (org_id, matched_contact_id) references app.guest_contacts (org_id, id)
    on delete set null (matched_contact_id)
);
create index inbound_messages_org_idx on app.inbound_messages (org_id, received_at desc);

revoke insert, update, delete, truncate on app.inbound_messages from authenticated;
alter table app.inbound_messages enable row level security;
create policy inbound_messages_select on app.inbound_messages for select to authenticated
  using ((select private.has_role(org_id, null, 'staff')));
comment on table app.inbound_messages is
  'Replies guests sent to the venue number. Dev-only until phase 3: written by dev-sms-inbound, '
  'always signature_verified = false. Holds a phone number, so real inbound needs retention and '
  'erasure coverage first.';

------------------------------------------------------------------------------------------------
-- A 'help' reply: a system SMS template, so only HELP gives any org an SMS template
------------------------------------------------------------------------------------------------

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred'));

insert into app.notification_templates (trigger, channel, body)
values ('help', 'sms', 'Queue notifications. Reply STOP to stop receiving them. For anything else, ask the venue.');

-- redefines private.template_variables from 20261030073001_renotify.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array[]::text[]
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- redefines api.outbox_still_relevant from 20261030073001_renotify.sql
create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- A reply to the guest's own HELP is not an alert: no preference or visit state applies.
      when n.template_key = 'help' then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: the guest turned the alert off, almost_up, position_changed '
  'or eta_changed once the guest is no longer waiting, called after the call was undone, superseded by '
  'a newer call or the guest moved on, anything for a finished visit or an unknown id. Account mail '
  'and replies to HELP are always still relevant. Implemented in N2 (#68), preferences in 2P-NTF1 '
  '(#173), re-notify in 2P-NTF3 (#175), HELP in 2P-NTF10 (#182).';

------------------------------------------------------------------------------------------------
-- Keywords
------------------------------------------------------------------------------------------------

create function private.apply_inbound_keyword(p_inbound_id bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  kw text;
  v app.visits;
  t app.notification_templates;
begin
  select * into m from app.inbound_messages where id = p_inbound_id;
  if not found then
    raise exception 'not_found';
  end if;
  kw := upper(btrim(m.body, E' \t\r\n.!'));

  if kw in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT') then
    insert into app.suppressions (org_id, channel, value, reason)
    values (m.org_id, 'sms', m.from_value_e164, 'stop')
    on conflict (org_id, channel, value) do nothing;
    update app.consents
    set status = 'revoked', revoked_at = now(), revoked_via = 'sms_stop'
    where org_id = m.org_id and status = 'granted' and channel = 'sms'
      and contact_id in (select gc.id from app.guest_contacts gc
                         where gc.org_id = m.org_id and gc.channel = 'phone' and gc.value = m.from_value_e164);
    return 'stop';
  end if;

  if kw in ('HELP', 'INFO') then
    -- A notification belongs to a visit: reply to this number's most recent one in the org.
    select x.* into v
    from app.visits x
    where x.org_id = m.org_id
      and (x.contact_id = m.matched_contact_id
           or (x.contact_id is null and x.guest_phone_e164 = m.from_value_e164))
      and (m.matched_contact_id is not null or x.contact_id is null)
    order by x.joined_at desc, x.id limit 1;
    if not found then
      return 'stored';
    end if;
    select * into t from private.resolve_template(v.org_id, v.queue_id, 'help', 'sms', v.locale);
    if not found then
      return 'stored';
    end if;
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                   template_version, category, dedupe_key)
    values (v.org_id, v.id, 'sms', coalesce(v.contact_id, v.id), 'help', t.version, t.category,
            -- At most one help reply per visit per hour, however many HELPs arrive.
            'help:' || v.id || ':' || floor(extract(epoch from now()) / 3600))
    on conflict (dedupe_key) do nothing;
    return 'help';
  end if;

  return 'stored';
end $$;
comment on function private.apply_inbound_keyword(bigint) is
  'STOP, STOPALL, UNSUBSCRIBE, CANCEL, END or QUIT suppresses the sender''s number for the org''s '
  'SMS and revokes its granted SMS consents (revoked_via sms_stop). HELP or INFO queues the help '
  'template to that number''s latest visit, at most once an hour. Anything else is only stored. Returns stop, help or '
  'stored. Idempotent.';

create function api.dev_record_inbound(p_org_id uuid, p_actor uuid, p_from_e164 text, p_body text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if not exists (select 1 from app.memberships m
                 where m.org_id = p_org_id and m.user_id = p_actor and m.role >= 'staff') then
    raise exception 'not_found';
  end if;
  if p_from_e164 is null or p_from_e164 !~ '^\+[1-9][0-9]{6,14}$' or length(v_body) not between 1 and 1600 then
    raise exception 'invalid_input';
  end if;
  insert into app.inbound_messages (org_id, from_value_e164, body, raw_payload, matched_contact_id)
  values (p_org_id, p_from_e164, v_body, jsonb_build_object('simulated', true, 'by', p_actor),
          (select gc.id from app.guest_contacts gc
           where gc.org_id = p_org_id and gc.channel = 'phone' and gc.value = p_from_e164))
  returning id into v_id;
  return private.apply_inbound_keyword(v_id);
end $$;
comment on function api.dev_record_inbound(uuid, uuid, text, text) is
  'Dev simulator only. Records a reply p_actor typed for p_from_e164 and applies its keyword; '
  'returns stop, help or stored. Raises not_found when p_actor is not staff of the org, '
  'invalid_input for a bad number or empty/oversized body. Service role only: the dev-sms-inbound '
  'Edge Function, which refuses unless DEV_INBOX_ENABLED=true, is the only caller.';

revoke all on function private.apply_inbound_keyword(bigint) from public, anon, authenticated;
revoke all on function api.dev_record_inbound(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function api.dev_record_inbound(uuid, uuid, text, text) to service_role;
