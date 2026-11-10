-- #1204 (messaging review M3): staff can attach any phone number to a consent by ticking an attestation,
-- and it was texted from the shared number with no proof from the number's owner (a guest-typed
-- number needs a code). Over the platform number a staff-typed number now gets one confirmation text
-- ("reply YES") when staff capture consent, and receives alerts only after its owner answers YES
-- (api.apply_platform_sms_event kind 'confirm', from the provider webhook, service role only).
-- Own-provider SMS is unchanged. Alternatives: a cap on attestations per day (weaker: the harm lands on
-- the shared sender); a code the staff member reads out (needs a new anon RPC).
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number'));
-- redefines notification_templates_trigger_check from 20261103021943_booking_confirmation_mail.sql
insert into app.notification_templates (trigger, channel, body) values
  ('reply_confirm_number', 'sms',
   '{location_name}: reply YES to get text updates about your visit. Msg & data rates may apply. Reply STOP to opt out.');

-- redefines private.visit_recipients from 20261107204944_sms_broadcast_guard.sql
create or replace function private.visit_recipients(p_visit app.visits, p_trigger text)
returns table (channel app.notification_channel, ref uuid)
language sql stable set search_path = '' as $$
  select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    -- A guest who joined on WhatsApp is answered there.
    select case when gc.channel = 'email' then 'email'
                when p_visit.source = 'whatsapp' then 'whatsapp' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
      -- A number typed at the join form and ticked for texts is only the guest's word for it
      -- (api.guest_grant_consent does not prove the phone). Texts reach it once the guest has
      -- entered the code sent to it (verified_at). Staff and import contacts, and a guest who
      -- joined on WhatsApp (they messaged first), are not typed-in numbers.
      and not (gc.channel = 'phone' and gc.created_source in ('online', 'kiosk')
               and p_visit.source <> 'whatsapp' and gc.verified_at is null)
      -- Over the shared number a staff-typed number is only staff's word for it (the attestation is not the
      -- owner's consent): it is texted once the guest has replied YES to the confirmation (verified_at).
      and not (gc.channel = 'phone' and gc.created_source = 'staff' and p_visit.source <> 'whatsapp'
               and gc.verified_at is null and private.platform_sms_mode(p_visit.org_id))
      -- "Message everyone" is not sent by SMS over the shared number unless the deployment allows it.
      and not (gc.channel = 'phone' and p_visit.source <> 'whatsapp' and p_trigger = 'broadcast'
               and not private.sms_broadcast_allowed(p_visit.org_id))
    union all
    -- A Telegram chat the guest linked from the status page (#252): its contact is the recipient.
    select 'telegram'::app.notification_channel, l.contact_id
    from app.channel_link_codes l
    where l.visit_id = p_visit.id and l.channel = 'telegram' and l.used_at is not null
      and l.contact_id is not null
    union all
    -- Online and kiosk joins keep what the guest typed on the visit (join_hardening); the visit
    -- itself is the recipient, so recipient_ref is the visit id. The address is unverified, so
    -- only the org's earliest live visit with it is mailed: repeated joins with someone else's
    -- address (or +tag and dot variants of it, canonical_email) send one visit's messages, not one
    -- per join.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
      -- Free text from staff never goes to an address a guest only typed (nobody verified it).
      and p_trigger <> 'broadcast'
      -- A number typed at the online or kiosk join form is texted only through its verified contact
      -- (first branch). Before that the visit has no contact row, so without this line the number
      -- would be texted the moment a consent tick lands (almost_up fires at join, #1127 follow-up).
      and not (ch.channel = 'sms' and p_visit.source in ('online', 'kiosk'))
      -- Nor does the automatic join message to a typed email (a typed phone still gets it: a
      -- text-to-join guest texted from that number).
      and not (p_trigger = 'joined' and ch.channel = 'email')
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
$$;

-- redefines api.staff_capture_consent from 20261030214030_staff_attestation.sql
create or replace function api.staff_capture_consent(p_visit_id uuid, p_channel text, p_attested boolean, p_text_version int, p_idempotency_key uuid) returns api.consent_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  v app.visits;
  v_claim record;
  v_contact uuid;
  v_guest uuid;
  c app.consents;
begin
  if p_channel is null or p_channel not in ('sms', 'whatsapp') or p_text_version is null or p_text_version < 1
     or p_idempotency_key is null or p_attested is null then
    raise exception 'invalid_input';
  end if;
  select * into v from app.visits where id = p_visit_id;
  if v.id is null or not private.has_role(v.org_id, v.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not p_attested then
    raise exception 'attestation_required';
  end if;
  if v.status not in ('expected', 'waiting', 'called', 'serving') or v.guest_phone_e164 is null and v.contact_id is null then
    raise exception 'invalid_input';
  end if;

  select * into v_claim from private.claim_idempotent(v.org_id, 'staff_capture_consent', p_idempotency_key);
  if v_claim.replay then
    return private.consent_row_of((v_claim.response ->> 'id')::uuid);
  end if;

  select gc.id, gc.guest_id into v_contact, v_guest
  from app.guest_contacts gc
  where gc.org_id = v.org_id and gc.id = v.contact_id and gc.channel = 'phone';
  if v_contact is null then
    select gc.id, gc.guest_id into v_contact, v_guest
    from app.guest_contacts gc
    where gc.org_id = v.org_id and gc.channel = 'phone' and gc.value = v.guest_phone_e164;
  end if;

  if exists (select 1 from app.suppressions sp
             where sp.org_id = v.org_id and sp.channel = p_channel::app.notification_channel
               and sp.value = coalesce(v.guest_phone_e164, (select gc.value from app.guest_contacts gc where gc.id = v_contact))) then
    raise exception 'contact_suppressed';
  end if;

  if v_contact is null then
    v_guest := coalesce(v.guest_id, gen_random_uuid());
    insert into app.guests (id, org_id, first_name)
    values (v_guest, v.org_id, left(v.guest_name, 60))
    on conflict (id) do nothing;
    insert into app.guest_contacts (org_id, guest_id, channel, value, created_source)
    values (v.org_id, v_guest, 'phone', v.guest_phone_e164, 'staff')
    returning id into v_contact;
  end if;

  if v.contact_id is distinct from v_contact then
    perform private.set_actor('staff', (select auth.uid()), null, 'consent_captured');
    update app.visits set contact_id = v_contact, guest_id = coalesce(guest_id, v_guest) where id = v.id;
  end if;

  select * into c from app.consents x
  where x.contact_id = v_contact and x.channel = p_channel::app.notification_channel and x.purpose = 'transactional'
  order by x.captured_at desc limit 1;
  if c.id is null or c.status <> 'granted' then
    insert into app.consents (org_id, contact_id, channel, purpose, status, source, consent_text_version,
                              consent_text_hash, captured_by_user_id, attested_at, attestation_text_version)
    values (v.org_id, v_contact, p_channel::app.notification_channel, 'transactional', 'granted', 'staff',
            p_text_version::text, encode(sha256(convert_to('staff-attestation:v' || p_text_version, 'UTF8')), 'hex'),
            (select auth.uid()), now(), p_text_version)
    returning * into c;
  end if;
  -- Over the shared number the attested number is asked once to confirm: its owner replies YES.
  -- (The reply is a one-time text to a number whose owner has not yet agreed to anything else.)
  -- At most 20 confirmations per org per hour and 2 per number per day across all orgs, so a tenant cannot
  -- use the shared sender to text numbers it picked. Over a cap the attestation is still recorded; the
  -- number just stays unconfirmed. One per contact per UTC day, so a dead or unanswered one can be asked again.
  if p_channel = 'sms' and private.platform_sms_mode(v.org_id)
     and exists (select 1 from app.guest_contacts gc where gc.id = v_contact and gc.verified_at is null)
     and (select count(*) from app.notifications n where n.org_id = v.org_id and n.template_key = 'reply_confirm_number'
          and n.created_at > now() - interval '1 hour') < 20
     and (select count(*) from app.notifications n join app.guest_contacts cc on cc.id = n.recipient_ref
          where n.template_key = 'reply_confirm_number' and n.created_at > now() - interval '1 day'
            and cc.value = (select gc.value from app.guest_contacts gc where gc.id = v_contact)) < 2 then
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version, category, dedupe_key)
    select v.org_id, v.id, 'sms', v_contact, 'reply_confirm_number', t.version, t.category,
           'reply_confirm_number:' || v_contact || ':' || (now() at time zone 'UTC')::date
    from private.resolve_template(v.org_id, v.queue_id, 'reply_confirm_number', 'sms', v.locale) t
    on conflict (dedupe_key) do nothing;
  end if;
  perform private.save_idempotent('staff_capture_consent', p_idempotency_key, jsonb_build_object('id', c.id));
  return private.consent_row_of(c.id);
end $$;

-- redefines api.apply_platform_sms_event from 20261102085037_platform_sms_auto_pause.sql
create or replace function api.apply_platform_sms_event(p_kind text, p_phone text default null, p_provider_message_id text default null,
                                             p_status text default null, p_error_code text default null) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if p_kind = 'status' then
    if coalesce(p_provider_message_id, '') = '' or coalesce(p_status, '') = '' then raise exception 'invalid_input'; end if;
    -- only a message sent through a platform-mode org can be reported on this route
    select n.org_id into v_org from app.notifications n
    join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
    where n.provider = 'twilio' and n.provider_message_id = left(p_provider_message_id, 200) and n.channel = 'sms'
    limit 1;
    if v_org is null then return false; end if;
    return api.apply_delivery_status(v_org, 'twilio', p_provider_message_id, p_status, p_error_code);
  elsif p_kind = 'confirm' then
    -- A YES from a number we asked to confirm: the owner of that number answered, so the contact the
    -- last confirmation went to is verified. Only a confirmation sent in the last 3 days counts.
    if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_input'; end if;
    -- Every platform-org contact for that number that was asked in the last 3 days: the owner answered for all.
    update app.guest_contacts gc set verified_at = now()
    where gc.verified_at is null and gc.channel = 'phone' and gc.value = p_phone
      and exists (
        select 1 from app.notifications n
        join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
        where n.recipient_ref = gc.id and n.org_id = gc.org_id and n.template_key = 'reply_confirm_number'
          and n.status = 'sent' and n.sent_at > now() - interval '3 days');
    return found;
  elsif p_kind in ('stop', 'start') then
    if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid_input'; end if;
    if p_kind = 'stop' then
      -- A STOP answers the last text this sender sent that number: it counts against that one business only
      -- (not every business that texted the number lately), so one number cannot blame several tenants.
      insert into private.platform_sms_stops (org_id, phone)
      select x.org_id, p_phone from (
        select n.org_id
        from app.guest_contacts gc
        join app.notifications n on n.org_id = gc.org_id and n.recipient_ref = gc.id
        join app.provider_settings s on s.org_id = n.org_id and s.channel = 'sms' and s.mode = 'platform'
        where gc.channel = 'phone' and gc.value = p_phone and n.channel = 'sms' and n.status = 'sent'
          and n.sent_at > now() - interval '3 days'
        order by n.sent_at desc limit 1) x;
      insert into app.suppressions (org_id, channel, value, reason)
      select s.org_id, 'sms', p_phone, 'platform_stop' from app.provider_settings s
      where s.channel = 'sms' and s.mode = 'platform'
      on conflict (org_id, channel, value) do nothing;
    else
      -- only a stop given to this sender; an org's own stop, a bounce, complaint or manual block stays
      delete from app.suppressions x using app.provider_settings s
      where x.org_id = s.org_id and s.channel = 'sms' and s.mode = 'platform'
        and x.channel = 'sms' and x.value = p_phone and x.reason = 'platform_stop';
    end if;
    return true;
  end if;
  raise exception 'invalid_input';
end $$;
