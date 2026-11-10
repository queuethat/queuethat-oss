-- C10 (#1276): the guest breach-notification helper (epic #1267, forms-privacy-design.md 8).
--
-- The business is the accountable party for its guests' data. After an incident it drafts a message
-- to the guests it holds contact data for, approves it, and sends it. Never automatic.
--
--   * One row per notice (app.guest_notices), tied to an entry of the business's incident log. Admins
--     draft; only an owner approves and sends. Editing an approved notice returns it to draft.
--   * The audience is derived inside the database from the business's own guests: email contacts of
--     guests who visited or booked in the window the owner names (optionally at one location). The
--     client gets a count, never an address (I-13). Nothing guest-supplied reaches the message: the
--     text is the owner's, plus the business name.
--   * Sent through the outbox (I-11) as transactional email on the platform channel. Suppressions and
--     retries are the outbox's. A send is capped (5000 recipients per notice, 5000 per business per
--     24 hours) and recorded: who, when, how many, in the audit log.
--
-- Interface alternatives: (a) a free-form recipient list the client uploads; (b) the audience defined by
-- a window and location over the business's own guests, resolved in SQL. (b) won: a client-supplied list
-- would let any value become a recipient. SMS is left out: unconsented texts to a guest list are a
-- carrier-compliance risk on the shared sender (product call, listed on #1267).
--
-- redefines notification_templates_trigger_check from 20261109132212_incident_notices.sql
-- redefines api.unsubscribe_outbox from 20261030220307_marketing_unsubscribe.sql

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation', 'appointment_expired', 'reply_confirm_number',
                     'sms_paused', 'sms_paused_operator', 'sms_warning_operator', 'sms_digest_operator',
                     'incident_notice', 'incident_reported_operator', 'guest_incident_notice'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('guest_incident_notice', 'email', 'transactional', '{{notice_subject}}',
   '{{notice_body}}' || E'\n\nThis message was sent by {{org}}.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

create table app.guest_notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  log_id uuid not null references app.org_incident_log (id),
  subject text not null check (length(btrim(subject)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 4000),
  -- Guests who visited or booked in [window_from, window_to], at one location or all of them.
  window_from timestamptz not null,
  window_to timestamptz not null check (window_to > window_from),
  location_id uuid,
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent')),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  sent_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz,
  recipient_count int check (recipient_count >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, location_id) references app.locations (org_id, id),
  check ((status = 'sent') = (sent_at is not null and recipient_count is not null))
);
create unique index guest_notices_open_idx on app.guest_notices (log_id) where status <> 'sent';
create index guest_notices_org_idx on app.guest_notices (org_id, created_at desc);
comment on table app.guest_notices is
  'A business''s message to its own guests about an incident (C10). Drafted by admins, approved and sent by '
  'an owner through api.*_guest_notice; the audience is never stored, only counted. Admins and owners read it.';
create trigger forbid_org_change before update on app.guest_notices
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.guest_notices
  for each row execute function private.touch_updated_at();
create trigger audit_row after insert or update or delete on app.guest_notices
  for each row execute function private.audit_row();
alter table app.guest_notices enable row level security;
create policy guest_notices_select on app.guest_notices for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));
revoke all on app.guest_notices from anon, authenticated;
grant select on app.guest_notices to authenticated;
grant all on app.guest_notices to service_role;

/** The distinct email contacts a notice would reach: the business's own guests in the notice's window. */
create function private.guest_notice_audience(n app.guest_notices) returns table (contact_id uuid)
language sql stable set search_path = '' as $$
  select distinct gc.id
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
$$;
revoke all on function private.guest_notice_audience(app.guest_notices) from public, anon, authenticated;

create type api.guest_notice as (
  id uuid, log_id uuid, subject text, body text, window_from timestamptz, window_to timestamptz,
  location_id uuid, status text, approved_at timestamptz, sent_at timestamptz,
  recipient_count int, updated_at timestamptz);
grant usage on type api.guest_notice to authenticated;

create function private.guest_notice_row(n app.guest_notices) returns api.guest_notice
language sql stable security definer set search_path = '' as $$
  select n.id, n.log_id, n.subject, n.body, n.window_from, n.window_to, n.location_id, n.status,
         n.approved_at, n.sent_at,
         -- A sent notice keeps the count it went to; an open one shows who it would reach now.
         case when n.status = 'sent' then n.recipient_count
              else (select count(*)::int from private.guest_notice_audience(n)) end,
         n.updated_at
$$;
revoke all on function private.guest_notice_row(app.guest_notices) from public, anon, authenticated;

create function api.save_guest_notice(
  p_log_id uuid,
  p_subject text,
  p_body text,
  p_window_from timestamptz,
  p_window_to timestamptz,
  p_location_id uuid default null
) returns api.guest_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.org_incident_log;
  n app.guest_notices;
begin
  select * into l from app.org_incident_log where id = p_log_id;
  if not found or not private.has_role(l.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();
  if p_subject is null or p_body is null or p_window_from is null or p_window_to is null
     or p_window_to <= p_window_from then
    raise exception 'invalid_input';
  end if;
  select * into n from app.guest_notices where log_id = l.id and status <> 'sent' for update;
  if found then
    update app.guest_notices
    set subject = btrim(p_subject), body = btrim(p_body), window_from = p_window_from,
        window_to = p_window_to, location_id = p_location_id, status = 'draft',
        approved_by = null, approved_at = null
    where id = n.id returning * into n;
  else
    insert into app.guest_notices (org_id, log_id, subject, body, window_from, window_to, location_id, created_by)
    values (l.org_id, l.id, btrim(p_subject), btrim(p_body), p_window_from, p_window_to, p_location_id,
            (select auth.uid()))
    returning * into n;
  end if;
  return private.guest_notice_row(n);
end $$;
comment on function api.save_guest_notice(uuid, text, text, timestamptz, timestamptz, uuid) is
  'Admin or owner: creates or replaces the open guest notice for an incident log entry (subject, text, '
  'the window and optional location that define who is told). An approved notice goes back to draft. '
  'Sends nothing. Raises not_found for an unknown entry or another business''s, invalid_input for empty '
  'text or an empty window, a location of another business fails with a foreign key error.';

create function api.approve_guest_notice(p_id uuid) returns api.guest_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.guest_notices;
begin
  select * into n from app.guest_notices where id = p_id for update;
  if not found or not private.has_role(n.org_id, null, 'owner') then
    raise exception 'not_found';
  end if;
  perform private.require_aal2_if_enrolled();
  if n.status = 'draft' then
    update app.guest_notices set status = 'approved', approved_by = (select auth.uid()), approved_at = now()
    where id = n.id returning * into n;
  end if;
  return private.guest_notice_row(n);
end $$;
comment on function api.approve_guest_notice(uuid) is
  'Owner: approves a draft guest notice. Approving an approved or sent notice changes nothing. Does not '
  'send. Raises not_found for an unknown notice or one of another business, or for a non-owner.';

create function api.send_guest_notice(p_id uuid) returns api.guest_notice
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
  select count(*)::int into v_count from private.guest_notice_audience(n);
  -- One send per business at a time, so two notices sent together can't both see an empty 24-hour window.
  perform pg_advisory_xact_lock(hashtextextended('guest_notice:' || n.org_id::text, 0));
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
  select n.org_id, null, 'email', a.contact_id, 'guest_incident_notice', t.version, t.category,
         jsonb_build_object('org', o.name, 'notice_subject', n.subject, 'notice_body', n.body),
         'guest_notice:' || n.id || ':' || a.contact_id
  from private.guest_notice_audience(n) a
  cross join lateral private.resolve_template(n.org_id, null, 'guest_incident_notice', 'email', o.default_locale) t
  on conflict (dedupe_key) do nothing;
  update app.guest_notices
  set status = 'sent', sent_by = (select auth.uid()), sent_at = now(), recipient_count = v_count
  where id = n.id returning * into n;
  return private.guest_notice_row(n);
end $$;
comment on function api.send_guest_notice(uuid) is
  'Owner: sends an approved guest notice by email through the outbox to the business''s own guests in its '
  'window, once; repeating it changes nothing. Capped at 5000 recipients per notice and per business per '
  '24 hours (rate_limited, DETAIL guest_notice_cap). A draft is never sent: raises invalid_input, also '
  'for an empty audience (DETAIL no_recipients). The audit log records who, when and how many; no '
  'address is returned. Raises not_found for a non-owner or another business''s notice.';

create function api.list_guest_notices(p_log_id uuid) returns setof api.guest_notice
language plpgsql stable security definer set search_path = '' as $$
declare
  l app.org_incident_log;
begin
  select * into l from app.org_incident_log where id = p_log_id;
  if not found or not private.has_role(l.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  return query select (private.guest_notice_row(n)).* from app.guest_notices n
  where n.log_id = l.id order by n.created_at desc;
end $$;
comment on function api.list_guest_notices(uuid) is
  'Admin or owner: the guest notices for one incident log entry, newest first, with how many guests each '
  'reaches (open) or reached (sent). No addresses. Raises not_found for an unknown entry or another business''s.';

revoke all on function api.save_guest_notice(uuid, text, text, timestamptz, timestamptz, uuid),
  api.approve_guest_notice(uuid), api.send_guest_notice(uuid), api.list_guest_notices(uuid) from public, anon;
grant execute on function api.save_guest_notice(uuid, text, text, timestamptz, timestamptz, uuid),
  api.approve_guest_notice(uuid), api.send_guest_notice(uuid), api.list_guest_notices(uuid) to authenticated;

-- The stop link in a guest notice must work: unlike account mail to a member, its recipient is a guest,
-- so a stop suppresses that address for this business like any other guest mail.
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
  if n.channel = 'push'
     or (n.visit_id is null and n.appointment_id is null and n.template_key <> 'guest_incident_notice') then
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
  '(transactional mail continues); any other guest row, including a guest incident notice, suppresses the '
  'org''s address on that channel (and its +tag and Gmail-dot variants), from the next claim on. '
  'Idempotent. A push or account-mail row changes nothing. Raises not_found. Service role only: the '
  'unsubscribe Edge Function calls it after checking the link''s signature.';
