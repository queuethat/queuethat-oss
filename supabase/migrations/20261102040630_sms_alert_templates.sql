-- Guests who tick the SMS opt-in are promised texts about their visit: a heads-up when they are
-- almost up and a message when it is their turn. Until now only push, email, console and telegram
-- had those default templates, and private.resolve_template returns nothing for a channel without
-- one, so no SMS alert was ever queued. Add the English defaults. Each names the sender
-- ("QueueThat:") and carries the STOP line carriers and the Twilio toll-free review expect on
-- every message. Transactional only: nothing promotional. Other locales fall back to English.
--
-- No `joined` text: a join confirmation would double the reply_join text-to-join guests already
-- get, and the outbox cannot carry the status link (the token is never stored, I-7).
--
-- Because this is the first time a guest-typed number can be texted by these triggers, an
-- unverified number is not texted: see the visit_recipients redefinition below.
insert into app.notification_templates (trigger, channel, locale, category, subject, body) values
  ('almost_up', 'sms', 'en', 'transactional', null,
   'QueueThat: You''re almost up ({ticket}). Please head back now. Reply STOP to opt out.'),
  ('called', 'sms', 'en', 'transactional', null,
   'QueueThat: It''s your turn: {ticket}. [Please go to {counter}.] Reply STOP to opt out.')
on conflict do nothing;

-- redefines private.visit_recipients from 20261031035430_joined_verified_only.sql
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
