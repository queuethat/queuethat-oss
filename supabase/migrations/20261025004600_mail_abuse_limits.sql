-- Security review of #468 (MEDIUM): an email typed at join is unverified, so one person could join
-- many times with someone else's address and have venues mail it. Three limits:
-- 1. Per org, only the earliest live visit with an address is mailed at it (enqueue).
-- 2. Across the platform, an address gets at most private.address_daily_cap() guest messages a day
--    (claim_outbox reports it suppressed).
-- 3. A bounce or complaint (report_outbox_result gone) writes a suppression, and those suppress the
--    address in every org.
-- All three compare private.canonical_email(), so victim+1@gmail.com and v.ictim@gmail.com count as
-- victim@gmail.com; mail still goes to the address as typed. Unsubscribe links come in #349.

alter table app.notifications add column recipient_hash text;
comment on column app.notifications.recipient_hash is
  'sha256 hex of private.canonical_email() of the resolved email or phone, set at claim time for guest '
  'messages; counts sends per inbox across orgs without storing the address.';

create function private.canonical_email(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(lower(btrim(p_value)), '');
  v_local text;
  v_domain text;
begin
  if v is null or v !~ '^[^@]+@[^@]+$' then
    return v;
  end if;
  v_local := split_part(v, '@', 1);
  v_domain := rtrim(split_part(v, '@', 2), '.');
  -- A local part that is only a tag, or only dots, is kept whole rather than left empty.
  v_local := coalesce(nullif(split_part(v_local, '+', 1), ''), v_local);
  if v_domain in ('gmail.com', 'googlemail.com') then
    v_domain := 'gmail.com';
    v_local := coalesce(nullif(replace(v_local, '.', ''), ''), v_local);
  end if;
  return v_local || '@' || v_domain;
end $$;
comment on function private.canonical_email(text) is
  'The inbox an email reaches, for matching only (never as a delivery address): trimmed and '
  'lowercased, no +tag in the local part, no trailing dots on the domain, and for gmail.com and '
  'googlemail.com no local-part dots and gmail.com. A value that is not one local@domain (a phone, '
  'say) comes back trimmed and lowercased. The one canonical form for abuse limits and blocks '
  '(contact_block_hash, #465), so they cannot drift.';

create index notifications_recipient_sent_idx on app.notifications (recipient_hash, updated_at)
  where status in ('claimed', 'sent') and recipient_hash is not null;
create index suppressions_key_idx on app.suppressions (channel, private.canonical_email(value));
create index visits_live_email_idx on app.visits (org_id, private.canonical_email(guest_email), joined_at)
  where guest_email is not null and status in ('expected', 'waiting', 'called', 'serving');
create index visits_live_phone_idx on app.visits (org_id, guest_phone_e164, joined_at)
  where guest_phone_e164 is not null and status in ('expected', 'waiting', 'called', 'serving');

create function private.address_daily_cap() returns int language sql immutable set search_path = '' as $$
  select 20
$$;
comment on function private.address_daily_cap() is
  'Guest messages (email or SMS) one address may be sent in 24 hours, across all orgs.';

create function private.notification_address(
  p_channel app.notification_channel,
  p_visit_id uuid,
  p_recipient_ref uuid,
  p_org_id uuid
) returns text
language sql stable set search_path = '' as $$
  select case
    when p_channel = 'push' then null
    when p_visit_id is null then (select u.email from auth.users u where u.id = p_recipient_ref)
    when p_recipient_ref = p_visit_id then (
      select case p_channel when 'email' then v.guest_email else v.guest_phone_e164 end
      from app.visits v where v.id = p_visit_id)
    else (select gc.value from app.guest_contacts gc where gc.id = p_recipient_ref and gc.org_id = p_org_id)
  end
$$;
comment on function private.notification_address(app.notification_channel, uuid, uuid, uuid) is
  'The email or phone a non-push notification goes to, or null once its contact is gone: the '
  'member''s sign-in email for account mail, the visit''s own typed contact for recipient_ref = '
  'visit id, otherwise the guest contact.';

-- redefines private.enqueue_notification from 20261025004400_enqueue_visit_contact.sql
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
    -- itself is the recipient, so recipient_ref is the visit id. The address is unverified, so
    -- only the org's earliest live visit with it is mailed: repeated joins with someone else's
    -- address (or +tag and dot variants of it, canonical_email) send one visit's messages, not one
    -- per join.
    select ch.channel, p_visit.id
    from (values ('email'::app.notification_channel, p_visit.guest_email),
                 ('sms'::app.notification_channel, p_visit.guest_phone_e164)) ch (channel, value)
    where p_visit.contact_id is null and ch.value is not null
      and not exists (
        select 1 from app.visits o
        where o.org_id = p_visit.org_id and o.id <> p_visit.id
          and o.status in ('expected', 'waiting', 'called', 'serving')
          and case ch.channel when 'email' then private.canonical_email(o.guest_email)
                              else o.guest_phone_e164 end
              = case ch.channel when 'email' then private.canonical_email(ch.value) else ch.value end
          and (o.joined_at, o.id) < (p_visit.joined_at, p_visit.id))
  ) r
  cross join lateral private.resolve_template(p_visit.org_id, p_visit.queue_id, p_trigger,
                                              r.channel, p_visit.locale) t
  left join app.counters c on c.id = p_visit.counter_id
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_notification(app.visits, bigint, text, text) is
  'Queues p_trigger for every recipient of the visit that has a template: push subscriptions, and '
  'the visit''s contact, or without one the email and phone typed at join (recipient_ref = visit '
  'id) unless an earlier live visit in the org has the same address. Snapshots the template '
  'version and {ticket, counter}. Idempotent per (p_scope, channel, recipient).';

-- redefines api.claim_outbox from 20261025004400_enqueue_visit_contact.sql
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
          order by c.captured_at desc limit 1) end,
        recipient_hash = case when n.channel <> 'push' and n.visit_id is not null then
          encode(sha256(convert_to(private.canonical_email(
            private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)), 'UTF8')), 'hex')
        end
    from due
    where n.id = due.id
    returning n.*
  )
  select n.id, n.org_id, n.visit_id, n.channel, n.category, n.template_key, n.template_version,
         coalesce(v.locale, o.default_locale), t.subject, t.body, n.vars,
         case when n.channel = 'push' then
                (select jsonb_build_object('kind', 'push', 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
                 from app.push_subscriptions s where s.id = n.recipient_ref)
              when a.value is not null then jsonb_build_object('kind', 'address', 'value', a.value)
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
  'typed at join does not consent to SMS. Suppressed means on the org''s list, bounced or '
  'complained in any org, or already sent private.address_daily_cap() guest messages in 24 hours. '
  'Account mail (no visit) goes to the member''s sign-in email, counts as '
  'consented, and has no location time zone. Concurrent dispatchers never receive the same row. '
  'A row whose lease expires is due again and counts as an attempt; at the sixth it is marked '
  'dead. Raises invalid_input. Implemented in N3 (#69).';

-- redefines api.report_outbox_result from 20261025004300_push.sql
create or replace function api.report_outbox_result(p_outbox_id uuid, p_result jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.notifications;
  v_status text := p_result ->> 'status';
  v_code text := left(p_result ->> 'error_code', 100);
begin
  if v_status is null or v_status not in ('sent', 'failed', 'suppressed', 'gone') then
    raise exception 'invalid_input';
  end if;
  select * into n from app.notifications where id = p_outbox_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- A report for a row this dispatcher no longer holds (its lease expired) changes nothing.
  if n.status <> 'claimed' then
    return;
  end if;

  update app.notifications set
    status = case
      when v_status = 'sent' then 'sent'
      when v_status = 'suppressed' and v_code = 'quiet_hours' then 'queued'
      when v_status = 'suppressed' then 'suppressed'
      when v_status = 'failed' and coalesce((p_result ->> 'retryable')::boolean, false)
           and n.attempts + 1 < private.outbox_max_attempts() then 'failed'
      else 'dead'
    end::app.notification_status,
    attempts = n.attempts + case when v_status in ('failed', 'gone') then 1 else 0 end,
    -- 30 s, 1, 2, 4, 8 min; quiet hours look again every 15 min until the window opens.
    next_attempt_at = case
      when v_status = 'failed' then now() + interval '30 seconds' * power(2, n.attempts)
      when v_code = 'quiet_hours' then now() + interval '15 minutes'
      else n.next_attempt_at
    end,
    quiet_hours_deferred = n.quiet_hours_deferred or v_code is not distinct from 'quiet_hours',
    locked_until = null,
    provider = coalesce(left(p_result ->> 'provider', 50), n.provider),
    provider_message_id = left(p_result ->> 'provider_message_id', 200),
    error_code = case when v_status = 'gone' then coalesce(v_code, 'gone') else v_code end,
    segments = (p_result ->> 'segments')::int,
    cost_micros = (p_result ->> 'cost_micros')::bigint
  where id = n.id;

  -- A push service that answers 404/410 has dropped the subscription for good.
  if v_status = 'gone' and n.channel = 'push' then
    delete from app.push_subscriptions s where s.id = n.recipient_ref and s.org_id = n.org_id;
  end if;
  -- An email or SMS that is gone bounced hard, or the recipient complained (error_code
  -- complaint); claim_outbox honours both in every org.
  if v_status = 'gone' and n.channel <> 'push' then
    insert into app.suppressions (org_id, channel, value, reason)
    select n.org_id, n.channel, a.value, case when v_code = 'complaint' then 'complaint' else 'bounce' end
    from (select private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id)) a (value)
    where a.value is not null
    on conflict (org_id, channel, value) do nothing;
  end if;
end $$;
comment on function api.report_outbox_result(uuid, jsonb) is
  'Records a send outcome {status: sent|failed|suppressed|gone, provider, provider_message_id, '
  'error_code, retryable, segments, cost_micros} for a row the caller has claimed. A retryable '
  'failure is retried after 30 s, doubling each time; the sixth failed attempt, a non-retryable '
  'failure or gone marks it dead; gone for a push row also deletes its subscription, and for '
  'email or SMS suppresses the address (reason complaint when error_code is complaint, else bounce). '
  'suppressed with error_code quiet_hours is retried in 15 '
  'minutes. Reports for rows no longer claimed are ignored. Raises invalid_input, not_found. '
  'Implemented in N3 (#69).';
