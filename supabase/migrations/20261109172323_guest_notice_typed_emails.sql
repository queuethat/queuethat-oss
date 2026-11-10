-- #1355 (C10b): a guest breach notice also reaches guests whose only email was typed at join or booking
-- (epic #1267, follow-up to C10 #1276).
--
-- Online and kiosk joins keep the typed email on app.visits.guest_email and bookings on
-- app.appointments.guest_email, with no guest_contacts row. C10's audience only read contacts, so those
-- guests were silently left out. The audience is now one set of (recipient, address) rows: contacts,
-- appointments and visits in the window (optionally at one location), one row per canonical address,
-- a contact preferred over an appointment over a visit. The count and the send read the same function.
--
-- Interface alternatives: (a) a second enqueue pass for typed emails inside send_guest_notice;
-- (b) one audience function the count and the send share, with private.notification_address resolving a
-- visit id as recipient_ref. (b) won: the count a notice shows can't disagree with who it reaches.
-- No api.* signature changes. The stop link, suppression and the 5000 caps are unchanged and apply to
-- these addresses like any other. The cross-org per-address daily cap does NOT apply (account-style rows
-- carry no recipient_hash); the brake on a typed address is that a notice is owner-approved, one message per
-- address per notice. Accepted: guests can add addresses to the audience but never change the text.
--
-- redefines private.notification_address from 20261109153017_incident_notice_breach_contact.sql
-- redefines private.guest_notice_row from 20261109161923_guest_incident_notice.sql
-- redefines api.send_guest_notice from 20261109161923_guest_incident_notice.sql

create or replace function private.notification_address(
  p_channel app.notification_channel,
  p_visit_id uuid,
  p_recipient_ref uuid,
  p_org_id uuid
) returns text
language sql stable set search_path = '' as $$
  select case
    when p_channel = 'push' then null
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.support_requests r where r.id = p_recipient_ref and r.org_id = p_org_id) then
      private.support_inbox()
    -- The org's privacy/breach contact: the org itself is the recipient, and only its own row counts.
    when p_visit_id is null and p_channel = 'email' and p_recipient_ref = p_org_id
         and exists (select 1 from app.org_privacy p where p.org_id = p_org_id) then (
      select p.email from app.org_privacy p where p.org_id = p_org_id)
    -- What the guest typed when booking: the appointment itself is the recipient.
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.appointments a where a.id = p_recipient_ref) then (
      select case p_channel when 'email' then a.guest_email else a.guest_phone_e164 end
      from app.appointments a where a.id = p_recipient_ref and a.org_id = p_org_id)
    -- What the guest typed when joining: the visit itself is the recipient (a guest notice has no visit
    -- of its own to attach to, because a visit's state would decide whether it is still worth sending).
    when p_visit_id is null and p_channel = 'email'
         and exists (select 1 from app.visits v where v.id = p_recipient_ref and v.org_id = p_org_id) then (
      select v.guest_email from app.visits v where v.id = p_recipient_ref and v.org_id = p_org_id)
    when p_visit_id is null and exists (select 1 from auth.users u where u.id = p_recipient_ref) then (
      select u.email from auth.users u where u.id = p_recipient_ref)
    when p_recipient_ref = p_visit_id then (
      select case p_channel when 'email' then v.guest_email else v.guest_phone_e164 end
      from app.visits v where v.id = p_visit_id)
    else (select gc.value from app.guest_contacts gc where gc.id = p_recipient_ref and gc.org_id = p_org_id)
  end
$$;

/** The distinct addresses a notice would reach, as (outbox recipient, address), one per canonical address. */
create function private.guest_notice_recipients(n app.guest_notices) returns table (recipient_ref uuid, address text)
language sql stable set search_path = '' as $$
  select distinct on (private.canonical_email(r.address)) r.ref, r.address
  from (
    select gc.id as ref, gc.value as address, 1 as prio
    from app.guest_contacts gc
    where gc.org_id = n.org_id and gc.channel = 'email'
      and (exists (select 1 from app.visits v
                   where v.org_id = n.org_id and v.guest_id = gc.guest_id
                     and v.joined_at >= n.window_from and v.joined_at < n.window_to
                     and (n.location_id is null or v.location_id = n.location_id))
           or exists (select 1 from app.appointments a
                      where a.org_id = n.org_id and a.guest_id = gc.guest_id
                        and a.starts_at >= n.window_from and a.starts_at < n.window_to
                        and (n.location_id is null or a.location_id = n.location_id)))
    union all
    select a.id, a.guest_email, 2
    from app.appointments a
    where a.org_id = n.org_id and a.guest_email is not null and btrim(a.guest_email) <> ''
      and a.starts_at >= n.window_from and a.starts_at < n.window_to
      and (n.location_id is null or a.location_id = n.location_id)
    union all
    select v.id, v.guest_email, 3
    from app.visits v
    where v.org_id = n.org_id and v.guest_email is not null and btrim(v.guest_email) <> ''
      and v.joined_at >= n.window_from and v.joined_at < n.window_to
      and (n.location_id is null or v.location_id = n.location_id)
  ) r
  order by private.canonical_email(r.address), r.prio, r.ref
$$;
revoke all on function private.guest_notice_recipients(app.guest_notices) from public, anon, authenticated;
comment on function private.guest_notice_recipients(app.guest_notices) is
  'Who a guest notice reaches: the business''s own guests in its window (and location), by email contact or '
  'the address typed at booking or join, one row per canonical address. Definer functions only; never returned to clients.';

create or replace function private.guest_notice_row(n app.guest_notices) returns api.guest_notice
language sql stable security definer set search_path = '' as $$
  select n.id, n.log_id, n.subject, n.body, n.window_from, n.window_to, n.location_id, n.status,
         n.approved_at, n.sent_at,
         -- A sent notice keeps the count it went to; an open one shows who it would reach now.
         case when n.status = 'sent' then n.recipient_count
              else (select count(*)::int from private.guest_notice_recipients(n)) end,
         n.updated_at
$$;

create or replace function api.send_guest_notice(p_id uuid) returns api.guest_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.guest_notices;
  o app.organizations;
  v_count int;
  v_recent int;
begin
  select * into n from app.guest_notices where id = p_id for update;
  if not found or not private.has_role(n.org_id, null, 'owner') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();
  if n.status = 'sent' then
    return private.guest_notice_row(n);
  end if;
  -- Only an approved notice goes out: a draft is never sent, however it is asked.
  if n.status <> 'approved' then
    raise exception 'invalid_input';
  end if;
  select * into o from app.organizations where id = n.org_id;
  -- One send per business at a time, so two notices sent together can't both see an empty 24-hour window.
  perform pg_advisory_xact_lock(hashtextextended('guest_notice:' || n.org_id::text, 0));
  select count(*)::int into v_count from private.guest_notice_recipients(n);
  select coalesce(sum(recipient_count), 0)::int into v_recent from app.guest_notices
  where org_id = n.org_id and status = 'sent' and sent_at > now() - interval '24 hours';
  if v_count = 0 then
    raise exception 'invalid_input' using detail = 'no_recipients';
  end if;
  if v_count > 5000 or v_recent + v_count > 5000 then
    raise exception 'rate_limited' using detail = 'guest_notice_cap';
  end if;
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select n.org_id, null, 'email', a.recipient_ref, 'guest_incident_notice', t.version, t.category,
         jsonb_build_object('org', o.name, 'notice_subject', n.subject, 'notice_body', n.body),
         'guest_notice:' || n.id || ':' || a.recipient_ref
  from private.guest_notice_recipients(n) a
  cross join lateral private.resolve_template(n.org_id, null, 'guest_incident_notice', 'email', o.default_locale) t
  on conflict (dedupe_key) do nothing;
  update app.guest_notices
  set status = 'sent', sent_by = (select auth.uid()), sent_at = now(), recipient_count = v_count
  where id = n.id returning * into n;
  return private.guest_notice_row(n);
end $$;

drop function private.guest_notice_audience(app.guest_notices);

comment on function api.send_guest_notice(uuid) is
  'Owner: sends an approved guest notice by email through the outbox to the business''s own guests in its '
  'window (and location), once; repeating it changes nothing. Reaches guests by email contact and by the '
  'address typed at join or booking, one message per address. Capped at 5000 recipients per notice and per '
  'business per 24 hours (rate_limited, DETAIL guest_notice_cap). A draft is never sent: raises invalid_input, '
  'also for an empty audience (DETAIL no_recipients). The audit log records who, when and how many; no '
  'address is returned. Raises not_found for a non-owner or another business''s notice.';
