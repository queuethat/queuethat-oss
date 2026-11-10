-- Appointment emails (confirmation, reminders) carry a link to change or cancel the appointment.
-- The booking token is stored only as a hash and cannot be re-derived for mail (I-7), so each message
-- mints its own random manage token when it is claimed for sending: the table keeps its sha256, the
-- plaintext exists only in the dispatcher's claim result and the email. A manage token opens
-- api.get_appointment, guest_reschedule_appointment, guest_cancel_appointment and the reminders push
-- registration for that one appointment (they resolve through private.appointment_by_token) and nothing
-- else (payment and the visit status page still need the booking token). It dies when the
-- appointment ends, however often the appointment is moved.
-- Alternatives rejected: (1) re-deriving the booking token from the Vault secret for mail, which breaks I-7;
-- (2) storing the plaintext in the outbox vars, which leaves a live credential in the table.
-- redefines private.appointment_by_token from 20261030073002_guest_appointment_rpcs.sql
-- redefines api.claim_outbox from 20261102091902_joined_business_name.sql

create table app.appointment_manage_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  appointment_id uuid not null,
  notification_id uuid not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  foreign key (org_id, appointment_id) references app.appointments (org_id, id) on delete cascade
);
create index appointment_manage_tokens_appointment_idx on app.appointment_manage_tokens (appointment_id);
create index appointment_manage_tokens_notification_idx on app.appointment_manage_tokens (notification_id);
alter table app.appointment_manage_tokens enable row level security;
revoke all on app.appointment_manage_tokens from anon, authenticated;
create policy appointment_manage_tokens_none on app.appointment_manage_tokens for select to authenticated using (false);
comment on table app.appointment_manage_tokens is
  'sha256 of the one-off manage links mailed to guests. No policy and no grant: only definer functions read it.';

create function private.mint_manage_path(p_appointment_id uuid, p_notification_id uuid) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_token text := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
begin
  insert into app.appointment_manage_tokens (org_id, appointment_id, notification_id, token_hash)
  select a.org_id, a.id, p_notification_id, private.token_hash(v_token)
  from app.appointments a where a.id = p_appointment_id;
  return '/a/' || v_token;
end $$;
comment on function private.mint_manage_path(uuid, uuid) is
  'A new random /a/ path for an appointment email; stores only its hash. An earlier attempt of the same message keeps its token, since the provider may already have delivered it; the hourly purge removes them all once the appointment ends.';
revoke all on function private.mint_manage_path(uuid, uuid) from public, anon, authenticated;

create or replace function private.appointment_by_token(p_token text) returns app.appointments
language sql stable set search_path = '' as $$
  -- Two index lookups, not one OR: an OR with a subquery would scan every appointment per call, and
  -- this runs for anon on every guest request.
  select a.* from app.appointments a
  where a.id = (
      select x.id from (
        select b.id from app.appointments b where b.guest_token_hash = private.token_hash(p_token)
        union all
        select b.id from app.appointment_manage_tokens m
        join app.appointments b on b.id = m.appointment_id
        where m.token_hash = private.token_hash(p_token) and now() < b.ends_at
      ) x limit 1)
    and now() < case when a.status = 'cancelled'
                     then coalesce((select max(e.occurred_at) from app.appointment_events e
                                    where e.appointment_id = a.id and e.to_status = 'cancelled'), a.ends_at)
                     else a.ends_at end + interval '12 hours'
$$;

create function ops.purge_manage_tokens() returns int
language sql volatile set search_path = '' as $$
  with gone as (
    delete from app.appointment_manage_tokens m using app.appointments a
    where a.id = m.appointment_id and a.ends_at < now() returning 1)
  select count(*)::int from gone
$$;
comment on function ops.purge_manage_tokens() is 'Deletes manage tokens of appointments that have ended. Run hourly by pg_cron.';
revoke all on function ops.purge_manage_tokens() from public, anon, authenticated;
select cron.schedule('purge-manage-tokens', '23 * * * *', 'select ops.purge_manage_tokens()');

update app.notification_templates
set body = replace(body, E'\n\n[Not you', E'\n\n[Change or cancel your appointment: {manage_url}]' || E'\n[Did not book this? Cancel it here: {cancel_url}]' || E'\n\n[Not you'),
    version = version + 1
where org_id is null and queue_id is null and channel = 'email'
  and trigger in ('appointment_reminder', 'appointment_confirmed') and body like E'%\n\n[Not you%';

create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Quiet hours (3-CG9): a non-urgent row whose location is outside its send window waits for the
  -- next opening instead of being claimed, so a deferral costs no attempt and no dispatcher call.
  -- Urgent: called and help_reply. Push (the guest's own device, actively waiting) and account mail
  -- (no location) are exempt, matching policy.ts.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(l.id, now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        join app.locations l on l.id = coalesce(v.location_id, ap.location_id)
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and x.channel <> 'push' and x.template_key not in ('called', 'help_reply')
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
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, t.body, (case when n.category = 'marketing' then
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

notify pgrst, 'reload schema';
