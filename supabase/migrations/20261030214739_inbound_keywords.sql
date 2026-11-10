-- 3-CG8 (#333): inbound STOP/START/HELP take effect in the webhook call that carries them.
-- Expand-only. process_inbound_message replaces its 3-API1 stub; the keyword logic extends
-- private.apply_inbound_keyword from 2P-NTF10 (dev simulator keeps calling it).

-- The whole-message keyword sets. Kept equal to packages/domain/src/sms/keywords.ts by a drift test.
create function private.inbound_keyword_kind(p_body text) returns text
language sql immutable set search_path = '' as $$
  select k.kind
  from (values
    ('optout'::text, array['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']),
    ('optin'::text, array['START', 'UNSTOP', 'YES']),
    ('help'::text, array['HELP', 'INFO'])
  ) as k(kind, words)
  where upper(regexp_replace(coalesce(p_body, ''), '[^A-Za-z0-9]', '', 'g')) = any (k.words)
$$;
comment on function private.inbound_keyword_kind(text) is
  'optout, optin or help when the whole message, uppercased with everything but letters and digits '
  'dropped, is a carrier keyword; null otherwise.';

-- HELP names the business and how to reach it.
update app.notification_templates
set body = 'Queue notifications from {business_name}. Reply STOP to stop receiving them. Questions: {support_contact}'
where org_id is null and trigger = 'help' and channel = 'sms';

-- redefines private.template_variables from 20261030115003_notify_triggers_2a.sql
create or replace function private.template_variables(p_trigger text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_trigger = 'broadcast' then array['ticket', 'eta_range']
    when p_trigger = 'help' then array['business_name', 'support_contact']
    when p_trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'removed', 'served',
                       'joined', 'no_show_warning') then
      array['guest_first_name', 'ticket', 'queue_name', 'location_name', 'counter', 'eta_range',
            'status_link', 'appointment_time', 'business_phone', 'unsubscribe_url', 'position']
  end
$$;

-- redefines private.apply_inbound_keyword from 20261030080001_inbound_messages.sql
create or replace function private.apply_inbound_keyword(p_inbound_id bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.inbound_messages;
  v app.visits;
  t app.notification_templates;
  o app.organizations;
  kind text;
begin
  select * into m from app.inbound_messages where id = p_inbound_id;
  if not found then
    raise exception 'not_found';
  end if;
  kind := private.inbound_keyword_kind(m.body);

  if kind = 'optout' then
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

  if kind = 'optin' then
    -- Only a STOP the guest sent is lifted; a bounce or a manual block stays.
    delete from app.suppressions
    where org_id = m.org_id and channel = 'sms' and value = m.from_value_e164 and reason = 'stop';
    -- The guest's own text is the evidence. Without a known contact there is nothing to attach it to.
    if m.matched_contact_id is not null and not exists (
         select 1 from app.consents c where c.contact_id = m.matched_contact_id and c.channel = 'sms'
           and c.purpose = 'transactional' and c.status = 'granted') then
      insert into app.consents (org_id, contact_id, channel, purpose, status, source,
                                consent_text_version, consent_text_hash)
      values (m.org_id, m.matched_contact_id, 'sms', 'transactional', 'granted', 'inbound',
              'keyword-start-1', encode(sha256(convert_to('inbound START keyword', 'UTF8')), 'hex'));
    end if;
    return 'start';
  end if;

  if kind = 'help' then
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
    select * into o from app.organizations where id = v.org_id;
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                   template_version, category, dedupe_key, vars)
    values (v.org_id, v.id, 'sms', coalesce(v.contact_id, v.id), 'help', t.version, t.category,
            -- At most one help reply per visit per hour, however many HELPs arrive.
            'help:' || v.id || ':' || floor(extract(epoch from now()) / 3600),
            jsonb_build_object('business_name', coalesce(o.legal_name, o.name),
                               'support_contact', coalesce(o.support_contact, '')))
    on conflict (dedupe_key) do nothing;
    return 'help';
  end if;

  return 'stored';
end $$;
comment on function private.apply_inbound_keyword(bigint) is
  'Opt-out keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT) suppress the '
  'sender''s number for the org''s SMS and revoke its granted SMS consents (revoked_via sms_stop). '
  'START, UNSTOP or YES lifts a STOP suppression and records a transactional consent for a known '
  'contact (source inbound). HELP or INFO queues the help template, with the business name and '
  'support contact, to that number''s latest visit, at most once an hour. Anything else is only '
  'stored. Returns stop, start, help or stored. Idempotent.';

-- redefines api.process_inbound_message from 20261030210404_api_contracts_3.sql
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
    v_handled := 'unhandled';
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
  'applies its keyword in the same call. handled_as is stop, start, help or unhandled (anything '
  'else; command and join handling extend this). A replay returns the first result. Raises '
  'invalid_input for a non-SMS channel, bad sender, empty or oversized body, not_found for an '
  'unknown org. Implemented in 3-CG8 (#333).';
