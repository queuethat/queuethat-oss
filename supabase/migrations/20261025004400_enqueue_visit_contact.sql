-- #458 part 1: online and kiosk joins keep the guest's email and phone on the visit
-- (20261025004110_join_hardening) instead of a guest_contacts row, so enqueue found no recipient and
-- those guests got nothing. Enqueue now falls back to the visit's own email and phone, with the
-- visit id as recipient_ref, and claim_outbox resolves and suppression-checks that address.
-- Consent (decision 20 on #398): the email typed at join covers transactional mail about that
-- visit; the phone typed at join does not cover SMS, which needs explicit consent (TCPA).

-- redefines private.enqueue_notification from 20261025002000_enqueue_notifications.sql
create or replace function private.enqueue_notification(
  p_visit app.visits,
  p_event_id bigint,
  p_trigger text,
  p_scope text
) returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, event_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_visit.org_id, p_visit.id, p_event_id, r.channel, r.ref, p_trigger, t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object('ticket', p_visit.display_ticket, 'counter', c.label)),
         concat_ws(':', p_scope, r.channel, r.ref)
  from (
    select 'push'::app.notification_channel as channel, s.id as ref
    from app.push_subscriptions s
    where s.visit_id = p_visit.id
    union all
    select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
    from app.guest_contacts gc
    where gc.id = p_visit.contact_id and gc.org_id = p_visit.org_id
    union all
    -- Online and kiosk joins keep what the guest typed on the visit (join_hardening); the visit
    -- itself is the recipient, so recipient_ref is the visit id.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_notification(app.visits, bigint, text, text) is
  'Queues p_trigger for every recipient of the visit that has a template: push subscriptions, and '
  'the visit''s contact, or without one the email and phone typed at join (recipient_ref = visit '
  'id). Snapshots the template version and {ticket, counter}. Idempotent per (p_scope, channel, '
  'recipient).';

-- redefines api.claim_outbox from 20261025003800_account_emails.sql
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
        consent_id = case when n.channel = 'push' or n.visit_id is null then null else (
          select c.id from app.consents c
          where c.contact_id = n.recipient_ref and c.channel = n.channel and c.purpose = n.category
          order by c.captured_at desc limit 1) end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, o.default_locale), t.subject, t.body, n.vars,
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when n.visit_id is null then
                (select jsonb_build_object('kind', 'address', 'value', u.email)
                 from auth.users u where u.id = n.recipient_ref and u.email is not null)
              when n.recipient_ref = n.visit_id then
                (select jsonb_build_object('kind', 'address', 'value', a.value)
                 from (select case n.channel when 'email' then v.guest_email else v.guest_phone_e164 end) a (value)
                 where a.value is not null)
              else
                (select jsonb_build_object('kind', 'address', 'value', gc.value)
                 from app.guest_contacts gc where gc.id = n.recipient_ref and gc.org_id = n.org_id)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or n.visit_id is null
           -- Decision 20 (#398): an email typed at join consents to transactional mail about
           -- that visit only. The visit row (source, joined_at) is the record, and relevance ends
           -- it with the visit. SMS needs its own explicit consent (TCPA); marketing never rides.
           or (n.recipient_ref = n.visit_id and n.channel = 'email' and n.category = 'transactional')
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and exists (
           select 1 from app.suppressions sp
           where sp.org_id = n.org_id and sp.channel = n.channel
             and sp.value = case when n.visit_id is null
                                 then (select u.email from auth.users u where u.id = n.recipient_ref)
                                 when n.recipient_ref = n.visit_id
                                 then case n.channel when 'email' then v.guest_email else v.guest_phone_e164 end
                                 else (select gc.value from app.guest_contacts gc where gc.id = n.recipient_ref)
                            end),
         l.tz, n.attempts,
         null::text -- tokens are stored hashed, so no message can link to the status page
  from claimed n
  join app.organizations o on o.id = n.org_id
  -- Account mail has no visit, so no location time zone either.
  left join app.visits v on v.id = n.visit_id
  left join app.locations l on l.id = v.location_id
  left join lateral private.resolve_template(n.org_id, v.queue_id, n.template_key, n.channel,
                                             coalesce(v.locale, o.default_locale)) t on true;
end $$;
comment on function api.claim_outbox(int, int) is
  'Leases up to p_limit (1-200) due notifications for p_lease_seconds (1-600) and returns them with '
  'recipient (null once deleted; the visit''s own email or phone for recipient_ref = visit id), template, consent and suppression facts and the location time '
  'zone. An email typed at join counts as consent for transactional mail about that visit; a phone '
  'typed at join does not consent to SMS. Account mail (no visit) goes to the member''s sign-in email, counts as '
  'consented, and has no location time zone. Concurrent dispatchers never receive the same row. '
  'A row whose lease expires is due again and counts as an attempt; at the sixth it is marked '
  'dead. Raises invalid_input. Implemented in N3 (#69).';
