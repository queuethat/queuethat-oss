-- 2P-APT10 (#166): appointment reminders ride the notifications outbox. A row is about a visit or
-- an appointment; account mail keeps visit_id and appointment_id both null. Every place that read
-- "no visit" as "account mail" now also checks appointment_id (claim_outbox, notification_address,
-- unsubscribe_outbox, outbox_still_relevant). Reminders reach web push, the staff-linked contact
-- when it consented, and the email typed at booking (transactional about that appointment, like an
-- email typed at join); a typed phone number is never texted. Expand-only.

alter table app.notifications
  add column appointment_id uuid,
  add column scheduled_for timestamptz,
  add constraint notifications_appointment_fk foreign key (org_id, appointment_id)
    references app.appointments (org_id, id),
  add constraint notifications_one_subject check (visit_id is null or appointment_id is null);
comment on column app.notifications.scheduled_for is 'When a scheduled message (a reminder) came due.';
grant select (appointment_id, scheduled_for) on app.notifications to authenticated;
create index notifications_appointment_idx on app.notifications (appointment_id) where appointment_id is not null;

alter table app.push_subscriptions
  alter column visit_id drop not null,
  add column appointment_id uuid,
  add constraint push_subscriptions_appointment_fk foreign key (org_id, appointment_id)
    references app.appointments (org_id, id) on delete cascade,
  add constraint push_subscriptions_one_subject check ((visit_id is null) <> (appointment_id is null)),
  add constraint push_subscriptions_appointment_endpoint_key unique (appointment_id, endpoint);

alter table app.locations
  add column reminder_offsets_minutes int[] not null default '{1440,60}'
    check (cardinality(reminder_offsets_minutes) <= 4
           and 5 <= all (reminder_offsets_minutes) and 20160 >= all (reminder_offsets_minutes));
comment on column app.locations.reminder_offsets_minutes is
  'Minutes before an appointment starts at which reminders go out (default 24 h and 1 h).';

create index appointments_booked_start_idx on app.appointments (starts_at) where status = 'booked';

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed'));

insert into app.notification_templates (trigger, channel, subject, body) values
  ('appointment_reminder',  'push',    null, 'Reminder: your {{service}} appointment at {{location_name}} is {{appointment_time}}.'),
  ('appointment_reminder',  'email',   'Appointment reminder', 'Reminder: your {{service}} appointment at {{location_name}} is {{appointment_time}}.' || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('appointment_reminder',  'sms',     null, 'Reminder: your {{service}} appointment at {{location_name}} is {{appointment_time}}.'),
  ('appointment_reminder',  'console', null, 'Reminder: your {{service}} appointment at {{location_name}} is {{appointment_time}}.'),
  ('appointment_confirmed', 'push',    null, 'Booked: {{service}} at {{location_name}}, {{appointment_time}}.'),
  ('appointment_confirmed', 'email',   'Appointment confirmed', 'Booked: {{service}} at {{location_name}}, {{appointment_time}}.' || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('appointment_confirmed', 'sms',     null, 'Booked: {{service}} at {{location_name}}, {{appointment_time}}.'),
  ('appointment_confirmed', 'console', null, 'Booked: {{service}} at {{location_name}}, {{appointment_time}}.');

-- Mirrors QUIET_HOURS in packages/providers/src/policy.ts (non-urgent mail waits from 20:00 to 08:00 local).
create function private.quiet_hours_end(p_at timestamptz, p_tz text) returns timestamptz
language sql stable set search_path = '' as $$
  select case
    when extract(hour from p_at at time zone p_tz) >= 20
      then (date_trunc('day', p_at at time zone p_tz) + interval '1 day 8 hours') at time zone p_tz
    when extract(hour from p_at at time zone p_tz) < 8
      then (date_trunc('day', p_at at time zone p_tz) + interval '8 hours') at time zone p_tz
    else p_at end
$$;
comment on function private.quiet_hours_end(timestamptz, text) is
  'When a non-urgent message held at p_at in zone p_tz may go out: p_at itself outside quiet hours, else the next 08:00.';
revoke all on function private.quiet_hours_end(timestamptz, text) from public, anon, authenticated;

create function ops.enqueue_appointment_reminders() returns int
language plpgsql volatile set search_path = '' as $$
declare
  v_count int;
begin
  -- An offset is due for 15 minutes after its moment, so a missed tick is caught up; the dedupe key
  -- (which carries the start time, so a reschedule gets new keys) makes every later tick a no-op.
  insert into app.notifications (org_id, appointment_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key, scheduled_for)
  select r.org_id, r.id, r.channel, r.ref, 'appointment_reminder', t.version, t.category,
         jsonb_build_object('appointment_time', to_char(r.starts_at at time zone r.tz, 'FMDay FMDD FMMonth, HH24:MI'),
                            'service', r.service_name, 'location_name', r.location_name,
                            'starts_epoch', floor(extract(epoch from r.starts_at))::bigint),
         format('appt:%s:%s:%s:%s:%s', r.id, r.offset_minutes, r.channel,
                floor(extract(epoch from r.starts_at))::bigint, r.ref),
         r.starts_at - make_interval(mins => r.offset_minutes)
  from (
    select d.*, x.channel, x.ref
    from (
      select a.*, l.tz, l.name as location_name, s.name as service_name, o.offset_minutes
      from app.appointments a
      join app.locations l on l.id = a.location_id
      join app.services s on s.id = a.service_id
      cross join lateral unnest(l.reminder_offsets_minutes) o (offset_minutes)
      where a.status = 'booked' and a.starts_at > now() and a.starts_at <= now() + interval '15 days'
        and a.starts_at - make_interval(mins => o.offset_minutes) <= now()
        and a.starts_at - make_interval(mins => o.offset_minutes) > now() - interval '15 minutes'
    ) d
    cross join lateral (
      select 'push'::app.notification_channel as channel, ps.id as ref
      from app.push_subscriptions ps where ps.appointment_id = d.id
      union all
      -- A contact staff linked at booking: only while its latest transactional consent stands.
      select case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel, gc.id
      from app.guest_contacts gc
      where gc.id = d.contact_id and gc.org_id = d.org_id
        and coalesce((select c.status = 'granted' and c.revoked_at is null from app.consents c
                      where c.contact_id = gc.id and c.channel = case gc.channel when 'email' then 'email' else 'sms' end::app.notification_channel
                        and c.purpose = 'transactional'
                      order by c.captured_at desc limit 1), false)
      union all
      -- The email typed at booking; a typed phone number never consents to SMS.
      select 'email'::app.notification_channel, d.id
      where d.contact_id is null and d.guest_email is not null
    ) x
  ) r
  cross join lateral private.resolve_template(r.org_id, r.queue_id, 'appointment_reminder', r.channel, r.locale) t
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
comment on function ops.enqueue_appointment_reminders() is
  'Queues the reminders now due for booked appointments: one row per offset in the location''s '
  'reminder_offsets_minutes and recipient (web push, the linked contact if it consented, the email typed '
  'at booking). Repeats and reschedules never double up. Run every 5 minutes by pg_cron; returns how many rows were queued.';
revoke all on function ops.enqueue_appointment_reminders() from public, anon, authenticated;
select cron.schedule('enqueue-appointment-reminders', '*/5 * * * *', 'select ops.enqueue_appointment_reminders()');

create function api.guest_register_appointment_push(
  p_token text, p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.appointments;
  v_p256dh text := rtrim(p_p256dh, '=');
  v_auth text := rtrim(p_auth, '=');
begin
  a := private.appointment_by_token(p_token);
  if a.id is null then raise exception 'not_found'; end if;
  if not private.is_push_endpoint(p_endpoint)
     or v_p256dh !~ '^[A-Za-z0-9_-]{87}$' or v_auth !~ '^[A-Za-z0-9_-]{22}$'
     or v_p256dh is null or v_auth is null then
    raise exception 'invalid_input';
  end if;

  -- One browser, one subject: the same subscription (endpoint and keys) leaves every other appointment
  -- and visit, so a shared phone stops getting the previous guest's messages.
  delete from app.push_subscriptions s
  where s.endpoint = p_endpoint and s.p256dh = v_p256dh and s.auth = v_auth and s.appointment_id is distinct from a.id;

  insert into app.push_subscriptions (org_id, appointment_id, endpoint, p256dh, auth)
  values (a.org_id, a.id, p_endpoint, v_p256dh, v_auth)
  on conflict (appointment_id, endpoint) do nothing;
  if found then
    delete from app.push_subscriptions s
    where s.appointment_id = a.id and s.id not in (
      select k.id from app.push_subscriptions k where k.appointment_id = a.id
      order by k.created_at desc, k.id desc limit 5);
  end if;
end $$;
comment on function api.guest_register_appointment_push(text, text, text, text) is
  'Stores a Web Push subscription for the token''s appointment; its reminders go to it until the push '
  'service reports it gone. The same subscription (endpoint and keys) is removed from every other '
  'appointment and visit. Repeating it changes nothing; an appointment keeps its five newest. Raises '
  'not_found as get_appointment does, invalid_input for an endpoint that is not https on a known push '
  'service or keys that are not base64url of the right length.';
revoke all on function api.guest_register_appointment_push(text, text, text, text) from public;
grant execute on function api.guest_register_appointment_push(text, text, text, text) to anon, authenticated, service_role;

-- redefines api.claim_outbox from 20261025004600_mail_abuse_limits.sql
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
         coalesce(v.locale, ap.locale, o.default_locale), t.subject, t.body, n.vars,
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

-- redefines private.notification_address from 20261025004600_mail_abuse_limits.sql
create or replace function private.notification_address(
  p_channel app.notification_channel,
  p_visit_id uuid,
  p_recipient_ref uuid,
  p_org_id uuid
) returns text
language sql stable set search_path = '' as $$
  select case
    when p_channel = 'push' then null
    -- What the guest typed when booking: the appointment itself is the recipient.
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.appointments a where a.id = p_recipient_ref) then (
      select case p_channel when 'email' then a.guest_email else a.guest_phone_e164 end
      from app.appointments a where a.id = p_recipient_ref and a.org_id = p_org_id)
    when p_visit_id is null and exists (select 1 from auth.users u where u.id = p_recipient_ref) then (
      select u.email from auth.users u where u.id = p_recipient_ref)
    when p_recipient_ref = p_visit_id then (
      select case p_channel when 'email' then v.guest_email else v.guest_phone_e164 end
      from app.visits v where v.id = p_visit_id)
    else (select gc.value from app.guest_contacts gc where gc.id = p_recipient_ref and gc.org_id = p_org_id)
  end
$$;

-- redefines api.unsubscribe_outbox from 20261025005000_unsubscribe.sql
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
  v_address := private.notification_address(n.channel, n.visit_id, n.recipient_ref, n.org_id);
  if v_address is null then
    return;
  end if;
  insert into app.suppressions (org_id, channel, value, reason)
  values (n.org_id, n.channel,
          case when n.channel = 'email' then private.canonical_email(v_address) else v_address end, 'stop')
  on conflict (org_id, channel, value) do nothing;
end $$;

-- redefines api.outbox_still_relevant from 20261030080001_inbound_messages.sql
create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- An appointment message goes only while the booking stands at the time it was queued for,
      -- and a reminder that quiet hours would hold back past the start is dropped, not sent late.
      when n.appointment_id is not null then
        ap.status = 'booked' and ap.starts_at > now()
        and floor(extract(epoch from ap.starts_at))::bigint = (n.vars ->> 'starts_epoch')::bigint
        and (n.channel = 'push' or n.template_key <> 'appointment_reminder'
             or private.quiet_hours_end(now(), l.tz) < ap.starts_at)
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- A reply to the guest's own HELP is not an alert: no preference or visit state applies.
      when n.template_key = 'help' then true
      -- The guest turned this alert off after it was queued.
      when not n.template_key = any (private.visit_alert_triggers(n.visit_id)) then false
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when n.template_key in ('almost_up', 'position_changed', 'eta_changed') then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.appointments ap on ap.id = n.appointment_id
    left join app.locations l on l.id = ap.location_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;

