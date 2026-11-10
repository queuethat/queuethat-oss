-- Unverified typed phones get no texts: the contact-less branch of visit_recipients skipped the
-- verified_at guard the contact branch already had. Fixes tests/e2e/visit-journey.spec.ts.

-- redefines private.visit_recipients from 20261102040630_sms_alert_templates.sql
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
