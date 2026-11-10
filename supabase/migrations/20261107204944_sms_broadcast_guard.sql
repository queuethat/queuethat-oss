-- #1202 (messaging review M2): "Message everyone" is free text a manager types, and over the shared
-- toll-free number one shop's "20% off today" is filtered or reported against every shop. Until the
-- program is declared and a content control exists:
--  * the SMS leg of a broadcast is OFF for orgs that send through the platform number, behind a
--    deployment switch (platform_sms_broadcast_enabled, default false) that an operator can flip or
--    revert at any time (the kill switch). Push, console and email broadcasts are unchanged.
--  * when the switch is on, a body that reads like a promotion (percent, sale, discount, coupon, a
--    link) is refused with invalid_input / DETAIL promotional.
-- Orgs on their own provider are unaffected.
alter table private.deployment_settings add column platform_sms_broadcast_enabled boolean not null default false;

create function private.platform_sms_mode(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select s.mode = 'platform' from app.provider_settings s
                   where s.org_id = p_org_id and s.channel = 'sms'), false)
$$;
revoke all on function private.platform_sms_mode(uuid) from public, anon, authenticated;

create function private.sms_broadcast_allowed(p_org_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select not private.platform_sms_mode(p_org_id)
         or coalesce((select d.platform_sms_broadcast_enabled from private.deployment_settings d), false)
$$;
comment on function private.sms_broadcast_allowed(uuid) is
  'False when the org sends SMS through the platform number and the deployment has not switched platform SMS broadcast on.';
revoke all on function private.sms_broadcast_allowed(uuid) from public, anon, authenticated;

create function private.broadcast_promo_like(p_body text) returns boolean
language sql immutable set search_path = '' as $$
  select p_body ~* '(%|\m(sale|discounts?|promo(tion)?s?|coupons?|offers?|deals?|free|off|bogo|http|https|www)\M|\.(com|ca|net|org|io)\M)'
$$;
comment on function private.broadcast_promo_like(text) is
  'Conservative screen for text that reads like a promotion or carries a link. Errs toward refusing.';
revoke all on function private.broadcast_promo_like(text) from public, anon, authenticated;

-- redefines private.visit_recipients from 20261102073800_typed_phone_needs_verification.sql
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

-- redefines api.send_queue_message from 20261030073601_queue_broadcast.sql
create or replace function api.send_queue_message(p_queue_id uuid, p_body text, p_idempotency_key uuid)
returns api.broadcast_result
language plpgsql volatile security definer set search_path = '' as $$
declare
  q app.queues;
  uid uuid := (select auth.uid());
  blocked text;
  claim record;
  v_body text := btrim(coalesce(p_body, ''));
  bad text;
  b app.queue_broadcasts;
  w app.visits;
  eta record;
  vars jsonb;
  n_recipients int := 0;
  n_suppressed int := 0;
  result api.broadcast_result;
begin
  select * into q from app.queues where id = p_queue_id and archived_at is null;
  if not found or not private.has_role(q.org_id, q.location_id, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(q.org_id, q.location_id, 'manager') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  blocked := private.write_blocked_reason(q.org_id, 'staff', uid);
  if blocked is not null then
    raise exception '%', blocked using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(v_body) not between 1 and 320 then
    raise exception 'invalid_input';
  end if;
  if private.template_malformed(v_body) then
    raise exception 'unknown_variable' using detail = 'malformed placeholder';
  end if;
  select u into bad from unnest(private.template_used_variables(v_body)) u
  where u <> all (private.template_variables('broadcast')) order by u limit 1;
  if bad is not null then
    raise exception 'unknown_variable' using detail = bad;
  end if;

  -- Over the shared number a promotion is filtered or reported against every business, so text that
  -- reads like one is refused when this org's broadcasts may go out by SMS at all.
  if private.sms_broadcast_allowed(q.org_id) and private.platform_sms_mode(q.org_id)
     and private.broadcast_promo_like(v_body) then
    raise exception 'invalid_input' using detail = 'promotional';
  end if;

  select * into claim from private.claim_idempotent(q.org_id, 'send_queue_message', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.broadcast_result, claim.response);
  end if;
  -- One sender at a time per queue, so concurrent calls cannot all see 5 and pass the cap.
  perform pg_advisory_xact_lock(hashtextextended(q.id::text, 0));
  if (select count(*) from app.queue_broadcasts x
      where x.queue_id = q.id and x.created_at > now() - interval '1 hour') >= 6 then
    raise exception 'rate_limited';
  end if;

  insert into app.queue_broadcasts (org_id, queue_id, body, sent_by)
  values (q.org_id, q.id, v_body, uid)
  returning * into b;

  for w in
    select * from app.visits x
    where x.queue_id = q.id and x.service_day = private.service_day(q.location_id)
      and x.status in ('waiting', 'called')
    order by x.sort_key, x.id
  loop
    select * into eta from private.visit_eta(w.id);
    vars := jsonb_build_object('message',
      regexp_replace(regexp_replace(v_body, '\{\{\s*ticket\s*\}\}', w.display_ticket, 'g'),
                     '\{\{\s*eta_range\s*\}\}',
                     coalesce(eta.eta_low || '–' || eta.eta_high || ' min', 'a few minutes'), 'g'));
    perform private.enqueue_notification(w, null, 'broadcast', 'broadcast:' || b.id, vars);
    if exists (select 1 from app.notifications nn
               where nn.visit_id = w.id and nn.dedupe_key like 'broadcast:' || b.id || ':%') then
      n_recipients := n_recipients + 1;
    else
      n_suppressed := n_suppressed + 1;
    end if;
  end loop;

  update app.queue_broadcasts set recipients = n_recipients, suppressed = n_suppressed where id = b.id;
  result := (b.id, n_recipients, n_suppressed);
  perform private.save_idempotent('send_queue_message', p_idempotency_key, to_jsonb(result));
  return result;
end $$;
