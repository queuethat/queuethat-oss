-- SMS message frame (plan S1, messaging review M1/M2). The database composes every guest SMS as
-- "{business}: <body> <footer>" when a row is claimed, so a tenant who edits a template edits only the
-- middle: the business name and the STOP/HELP wording cannot be deleted, mistyped or go stale when the
-- wording changes. The system defaults therefore hold the bare body, in English and Spanish. Applies to
-- SMS rows of a visit (alerts, the code, the join and confirmation replies); HELP keeps its own text and
-- appointment SMS (not yet declared on the toll-free form) are untouched. {location_name} is filled from
-- the visit's location when the row is claimed, as before.
-- Alternative: validate on save that the body carries the name and "Reply STOP" (rejected: tenants would be
-- told to type boilerplate and a wording change needs a data migration across every tenant row).
-- Spanish defaults avoid accented a, i, o, u: outside GSM-7 they would turn a 1-segment text into 70-char
-- segments. The Spanish wording needs a native check before launch (plan D5).
create function private.sms_footer(p_locale text) returns text
language sql immutable set search_path = '' as $$
  select case when p_locale = 'es' then 'Responde STOP para cancelar, AYUDA para ayuda.'
              else 'Reply STOP to opt out, HELP for help.' end
$$;
comment on function private.sms_footer(text) is 'The opt-out and help line closing every framed SMS, in the template''s locale (es, else en).';
revoke all on function private.sms_footer(text) from public, anon, authenticated;

create function private.sms_compose(p_body text, p_locale text) returns text
language sql immutable set search_path = '' as $$
  select '{location_name}: ' || btrim(coalesce(p_body, '')) || ' ' || private.sms_footer(p_locale)
$$;
comment on function private.sms_compose(text, text) is
  'The text of a guest SMS: the business name, the template body, then the opt-out and help line. {location_name} is filled by the dispatcher.';
revoke all on function private.sms_compose(text, text) from public, anon, authenticated;

-- System defaults hold only the body now (version bump keeps notifications.template_version honest).
update app.notification_templates t
set body = v.body, version = t.version + 1
from (values
  ('almost_up', 'You''re almost up ({ticket}). Please head back now.'),
  ('called', 'It''s your turn: {ticket}. [Please go to {counter}.]'),
  ('reply_verify', 'your code is {code}. It expires in 10 minutes.'),
  ('reply_join', 'You''re in line at {queue_name}, ticket {ticket}, number {position}. Reply L to leave.'),
  ('reply_confirm_number', 'Reply YES to get text updates about your visit. Msg & data rates may apply.')
) v (trigger, body)
where t.org_id is null and t.queue_id is null and t.channel = 'sms' and t.locale = 'en' and t.trigger = v.trigger;

insert into app.notification_templates (trigger, channel, locale, category, subject, body) values
  ('almost_up', 'sms', 'es', 'transactional', null, 'Ya casi llega tu turno ({ticket}). Regresa ahora, por favor.'),
  ('called', 'sms', 'es', 'transactional', null, 'Es tu turno: {ticket}. [Ve a {counter}.]'),
  ('reply_verify', 'sms', 'es', 'transactional', null, 'tu codigo es {code}. Vence en 10 minutos.'),
  ('reply_join', 'sms', 'es', 'transactional', null, 'Estas en la fila de {queue_name}: ticket {ticket}, numero {position}. Responde L para salir.'),
  ('reply_confirm_number', 'sms', 'es', 'transactional', null, 'Responde YES para recibir mensajes sobre tu visita. Pueden aplicar tarifas de mensajes y datos.')
on conflict do nothing;

-- redefines api.claim_outbox from 20261107204030_quiet_hours_reply_exempt.sql
create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Quiet hours (3-CG9): a non-urgent row whose location is outside its send window waits for the
  -- next opening instead of being claimed, so a deferral costs no attempt and no dispatcher call.
  -- Urgent: called, the HELP reply, the one-time code and every reply to an inbound text (reply_*). Push (the guest's own device, actively waiting) and account mail
  -- (no location) are exempt, matching policy.ts.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(l.id, now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and x.channel <> 'push' and not private.is_urgent_template(x.template_key)
        for update of x skip locked) w
  where n.id = w.id and w.opens > now();

  update app.notifications
  set status = 'dead', error_code = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= private.outbox_max_attempts();

  return query
  with due as (
    select n.id
    from app.notifications n
    where (n.status in ('queued', 'failed') and n.next_attempt_at <= now())
       or (n.status = 'claimed' and n.locked_until < now())
    order by n.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update app.notifications n
    set status = 'claimed',
        locked_until = now() + make_interval(secs => p_lease_seconds),
        attempts = n.attempts + case when n.status = 'claimed' then 1 else 0 end,
        consent_id = case when n.channel = 'push' or (n.visit_id is null and n.appointment_id is null) then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end,
        recipient_hash = case when n.channel <> 'push' and (n.visit_id is not null or n.appointment_id is not null) then
          encode(sha256(convert_to(private.canonical_email(
            private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)), 'UTF8')), 'hex')
        end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, case when n.channel = 'sms' and n.visit_id is not null and n.template_key <> 'help'
              then private.sms_compose(t.body, t.locale) else t.body end,
         (case when n.category = 'marketing' then
              base.vars || jsonb_build_object('org_legal_name', o.legal_name, 'org_postal_address', o.postal_address)
              else base.vars end) || jsonb_build_object('org_hide_product_branding', o.hide_product_branding),
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when a.value is not null then jsonb_build_object('kind', 'address', 'value', a.value)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or (n.visit_id is null and n.appointment_id is null)
           -- Decision 20 (#398): an email typed at join consents to transactional mail about
           -- that visit only. The visit row (source, joined_at) is the record, and relevance ends
           -- it with the visit. SMS needs its own explicit consent (TCPA); marketing never rides.
           or (n.recipient_ref = coalesce(n.visit_id, n.appointment_id) and n.channel = 'email' and n.category = 'transactional')
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and (
           -- The org's own list, plus bounces and complaints from any org: the address is dead
           -- or unwilling everywhere.
           exists (select 1 from app.suppressions sp
                   where sp.channel = n.channel and private.canonical_email(sp.value) = private.canonical_email(a.value)
                     and (sp.org_id = n.org_id or sp.reason in ('bounce', 'complaint')))
           -- Guest messages per address across the platform, so joins at many venues with one
           -- typed address can't flood it. Rows other batches hold count too; rows in this
           -- batch don't, so one batch can overshoot.
           or (n.recipient_hash is not null and (
                 select count(*) from app.notifications s
                 where s.recipient_hash = n.recipient_hash and s.status in ('claimed', 'sent')
                   and s.updated_at > now() - interval '1 day') >= private.address_daily_cap())),
         l.tz, n.attempts,
         -- A visit's token is stored hashed, so no message can link to its status page. An appointment
         -- email gets a one-off manage link instead: minted here, stored only as a hash, shown nowhere
         -- but this return value. A retry mints another and keeps the first (it may already be in a delivered mail).
         case when n.channel = 'email' and n.appointment_id is not null and n.template_key like 'appointment\_%'
              then private.mint_manage_path(n.appointment_id, n.id) end
  from claimed n
  join app.organizations o on o.id = n.org_id
  cross join lateral (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
  -- Account mail has no visit or appointment, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
  -- The business's name is not stored on the row, so the join confirmation said "us". Fill it here
  -- from the location; a value the row already carries (appointments set their own) wins.
  cross join lateral (select jsonb_strip_nulls(jsonb_build_object('location_name', l.name)) || n.vars) base (vars)
  left join lateral private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, n.channel,
                                             coalesce(v.locale, ap.locale, o.default_locale)) t on true;
end $$;
