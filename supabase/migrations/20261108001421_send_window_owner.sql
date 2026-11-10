-- C5 (#1231) + Q1 envelope (#1240): the database is the single owner of the SMS send window.
-- * One predicate, private.send_window_open, decides whether a row may go out now. api.claim_outbox
--   applies it twice: to push back rows that fell outside the window (so a deferral costs no attempt)
--   and inside the claim itself, so no row can be handed to the dispatcher while the window is closed
--   (a row queued after the deferral pass, a claim whose lease expired). The dispatcher therefore
--   only ever sees rows that may be sent now, and packages/providers/src/policy.ts no longer
--   re-derives the window.
-- * The legal envelope lives in one row (private.send_window_bounds) so counsel can change it without a
--   migration. A location may narrow or shift its window inside it, never outside, enforced by trigger.
--   Envelope is 08:00-21:00 local (Riz, 2026-11-07); the platform default stays 08:00-20:00.

create table private.send_window_bounds (
  earliest time not null default '08:00',
  latest time not null default '21:00',
  singleton boolean primary key default true check (singleton),
  check (earliest < latest)
);
insert into private.send_window_bounds default values;
revoke all on private.send_window_bounds from public, anon, authenticated;
comment on table private.send_window_bounds is
  'The widest local-time window any location may use for non-urgent guest messages. One row; counsel edits it.';

alter table app.locations
  drop constraint if exists locations_send_window_start_check,
  drop constraint if exists locations_send_window_end_check;

-- Definer: the writer is a tenant role with no access to private.send_window_bounds.
create function private.enforce_send_window_bounds() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b private.send_window_bounds;
begin
  select * into b from private.send_window_bounds;
  if new.send_window_start < b.earliest or new.send_window_end > b.latest then
    raise exception 'send_window_out_of_bounds' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.enforce_send_window_bounds() from public, anon, authenticated;
create trigger locations_send_window_bounds
  before insert or update of send_window_start, send_window_end on app.locations
  for each row execute function private.enforce_send_window_bounds();

comment on column app.locations.send_window_start is
  'Earliest local time non-urgent guest messages go out. Never earlier than private.send_window_bounds.earliest.';
comment on column app.locations.send_window_end is
  'Local time from which non-urgent guest messages wait for the next day. Never later than private.send_window_bounds.latest.';

create function private.send_window_open(
  p_location_id uuid, p_template_key text, p_channel app.notification_channel, p_at timestamptz default now())
returns boolean language sql stable set search_path = '' as $$
  -- No location (account mail), web push (the guest's own device, actively waiting) and the urgent
  -- keys are never held. Everything else needs p_at inside the location's window; an unknown
  -- location has no window to wait for.
  select p_location_id is null
      or p_channel = 'push'
      or private.is_urgent_template(p_template_key)
      or coalesce(private.next_send_window(p_location_id, p_at) = p_at, true)
$$;
revoke all on function private.send_window_open(uuid, text, app.notification_channel, timestamptz) from public, anon, authenticated;
comment on function private.send_window_open(uuid, text, app.notification_channel, timestamptz) is
  'True when an outbox row may be sent at p_at: exempt rows (account mail, push, private.is_urgent_template) always, '
  'others only inside the location''s send window in its own time zone. The only owner of this rule.';

-- redefines api.claim_outbox from 20261107211348_sms_message_frame.sql
-- redefines api.claim_outbox from 20261107204030_quiet_hours_reply_exempt.sql
create or replace function api.claim_outbox(p_limit int, p_lease_seconds int) returns setof api.outbox_job
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200
     or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_input';
  end if;

  -- Send window (3-CG9, C5): a row that is outside its window waits for the next opening instead of
  -- being claimed, so a deferral costs no attempt and no dispatcher call. private.send_window_open owns
  -- which rows are exempt.
  update app.notifications n
  set next_attempt_at = w.opens, quiet_hours_deferred = true
  from (select x.id, private.next_send_window(coalesce(v.location_id, ap.location_id), now()) as opens
        from app.notifications x
        left join app.visits v on v.id = x.visit_id
        left join app.appointments ap on ap.id = x.appointment_id
        where x.status in ('queued', 'failed') and x.next_attempt_at <= now()
          and not private.send_window_open(coalesce(v.location_id, ap.location_id), x.template_key, x.channel, now())
        for update of x skip locked) w
  where n.id = w.id and w.opens > now();

  update app.notifications
  set status = 'dead', error_code = 'lease_expired', locked_until = null
  where status = 'claimed' and locked_until < now() and attempts + 1 >= private.outbox_max_attempts();

  return query
  with due as (
    select n.id
    from app.notifications n
    left join app.visits dv on dv.id = n.visit_id
    left join app.appointments dap on dap.id = n.appointment_id
    where ((n.status in ('queued', 'failed') and n.next_attempt_at <= now())
        or (n.status = 'claimed' and n.locked_until < now()))
      -- The window is checked again here: nothing outside it is ever claimed, whatever was queued
      -- after the deferral pass above.
      and private.send_window_open(coalesce(dv.location_id, dap.location_id), n.template_key, n.channel, now())
    order by n.next_attempt_at
    limit p_limit
    for update of n skip locked
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
