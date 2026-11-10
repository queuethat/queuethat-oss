-- 3-EM3 (#349): marketing email carries the org's legal name and postal address, and its
-- unsubscribe link withdraws marketing consent only.
--
--   * claim_outbox adds org_legal_name and org_postal_address to the vars of marketing rows, so the
--     dispatcher can build the CAN-SPAM footer and refuse (missing_postal_address) without a new
--     entry point. Signatures are unchanged.
--   * unsubscribe_outbox on a marketing row revokes that contact's marketing consent (the enqueue
--     trigger then suppresses the next marketing send); it adds no suppression, so a `called`
--     email still arrives. A transactional row behaves as before.

-- redefines api.claim_outbox from 20261030100001_appointment_reminders.sql
create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

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
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, t.body, case when n.category = 'marketing' then
              n.vars || jsonb_build_object('org_legal_name', o.legal_name, 'org_postal_address', o.postal_address)
              else n.vars end,
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
         null::text -- tokens are stored hashed, so no message can link to the status page
  from claimed n
  join app.organizations o on o.id = n.org_id
  cross join lateral (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
  -- Account mail has no visit or appointment, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.appointments ap on ap.id = n.appointment_id
  left join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
  left join lateral private.resolve_template(n.org_id, coalesce(v.queue_id, ap.queue_id), n.template_key, n.channel,
                                             coalesce(v.locale, ap.locale, o.default_locale)) t on true;
end $$;
comment on function api.claim_outbox(int, int) is
  'Leases up to p_limit due outbox rows for p_lease_seconds and returns them rendered-ready: template, '
  'vars, recipient and the policy facts (consent, suppression, location tz). Marketing rows also carry '
  'org_legal_name and org_postal_address in vars. Service role only. Raises invalid_input.';

-- redefines api.unsubscribe_outbox from 20261030100001_appointment_reminders.sql
create or replace function api.unsubscribe_outbox(p_outbox_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_address text;
begin
  select * into n from app.notifications where id = p_outbox_id;
  if not found then
    raise exception 'not_found';
  end if;
  -- Push has its own off switch (the browser), and account mail is the member's own sign-in.
  if n.channel = 'push' or (n.visit_id is null and n.appointment_id is null) then
    return;
  end if;
  -- Marketing stops by withdrawing marketing consent; the transactional mail the guest still
  -- needs (called, almost_up) keeps flowing. Any other category stops the whole address below.
  if n.category = 'marketing' then
    update app.consents
    set status = 'revoked', revoked_at = now(), revoked_via = 'unsubscribe_link'
    where org_id = n.org_id and contact_id = n.recipient_ref and channel = n.channel
      and purpose = 'marketing' and status = 'granted' and revoked_at is null;
    return;
  end if;
  v_address := private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id);
  if v_address is null then
    return;
  end if;
  insert into app.suppressions (org_id, channel, value, reason)
  values (n.org_id, n.channel,
          case when n.channel = 'email' then private.canonical_email(v_address) else v_address end, 'stop')
  on conflict (org_id, channel, value) do nothing;
end $$;
comment on function api.unsubscribe_outbox(uuid) is
  'Stops mail for outbox row p_outbox_id: a marketing row revokes that contact''s marketing consent '
  '(transactional mail continues); any other guest row suppresses the org''s address on that channel '
  '(and its +tag and Gmail-dot variants), from the next claim on. Idempotent. A push or account-mail '
  'row changes nothing. Raises not_found. Service role only: the unsubscribe Edge Function calls it '
  'after checking the link''s signature.';
