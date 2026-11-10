-- #1138: signed-in staff and admins contact QueueThat support from inside the app, with context attached.
-- Interface choice (rule 7): (a) a mailto: link, rejected because it carries no org, page or version;
-- (b) a third-party widget, rejected because it adds a script, a cost and a data processor (PIPEDA review).
-- Chosen: one authenticated RPC (api.contact_support) that stores the request and queues two outbox emails.
-- Nothing here is reachable by anon (I-4): no allowlist line is marked anon, guest pages get no button.
--
-- Deviation from the ticket's signature: p_org_id is a parameter. A person can belong to several orgs and only
-- the client knows which one is open, but the database never trusts it: the caller must hold a membership in
-- that org, or the call raises not_found. User, role and org name always come from the session and the tables.

-- ------------------------------------------------------------------------------------------------
-- Where support mail goes
-- ------------------------------------------------------------------------------------------------

alter table app.platform_flags add column support_inbox text not null default 'support@queuethat.com'
  check (support_inbox ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(support_inbox) <= 254);
comment on column app.platform_flags.support_inbox is
  'The address that receives in-app support requests (api.contact_support). Self-hosters set their own.';

create function private.support_inbox() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select f.support_inbox from app.platform_flags f), 'support@queuethat.com')
$$;
comment on function private.support_inbox() is 'The inbox for in-app support requests; app.platform_flags.support_inbox.';
revoke all on function private.support_inbox() from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------
-- Requests
-- ------------------------------------------------------------------------------------------------

create table app.support_requests (
  id uuid primary key default gen_random_uuid(),
  -- The number people quote; shown as SR-000123 (api.contact_support returns the text).
  number bigint generated always as identity unique,
  org_id uuid not null references app.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  subject text not null check (length(subject) between 1 and 120),
  message text not null check (length(message) between 1 and 4000),
  -- Whitelisted and sanitised by api.contact_support; never client-supplied verbatim.
  context jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  check ((status = 'closed') = (closed_at is not null))
);
create index support_requests_org_idx on app.support_requests (org_id, created_at desc);
create index support_requests_user_idx on app.support_requests (user_id, created_at desc);

create trigger forbid_org_change before update on app.support_requests
  for each row execute function private.forbid_org_change();

alter table app.support_requests enable row level security;
-- Owners and admins read every request of their org; anyone else reads only their own. Written by the
-- RPCs alone, so there is no insert, update or delete policy.
create policy support_requests_select on app.support_requests for select to authenticated
  using ((select private.has_role(org_id, null, 'admin'))
         or (user_id = (select auth.uid()) and (select private.has_role(org_id, null, 'staff'))));
revoke all on app.support_requests from public, anon, authenticated;
grant select on app.support_requests to authenticated;
grant select, insert, update, delete on app.support_requests to service_role;

-- ------------------------------------------------------------------------------------------------
-- Emails: one to the support inbox, one confirmation to the requester
-- ------------------------------------------------------------------------------------------------

-- redefines notification_templates_trigger_check from 20261101235009_payment_failed_email.sql
alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'position_changed', 'eta_changed', 'broadcast', 'removed',
                     'served', 'help', 'support.break_glass', 'org.ownership_transferred',
                     'appointment_reminder', 'appointment_confirmed', 'joined', 'no_show_warning', 'event_cancelled',
                     'slot_offer', 'reply_confirmed', 'reply_left', 'reply_commands', 'reply_multiple',
                     'reply_join', 'reply_join_closed', 'usage_alert', 'broadcast_marketing', 'report_summary',
                     'credit_low', 'receipt', 'reply_verify', 'payment_failed', 'payment_grace_ending',
                     'support_request', 'support_confirmation'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('support_request', 'email', 'transactional', '[{{reference}}] {{org}}: {{subject}}',
   '{{message}}' || E'\n\n--\nReference: {{reference}}\nFrom: {{user_email}} ({{role}})\n'
   'Organization: {{org}} ({{org_id}}), plan {{plan}}'
   || E'\n[Page: {{route}}]\n[App version: {{app_version}}]\n[Browser: {{browser}}]\n[Viewport: {{viewport}}]'
   || E'\n[Online: {{online}}]\n[Last error: {{last_error_id}}]'
   || E'\n[Tenant page: {{app_url}}/platform/orgs/{{org_id}}]'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('support_confirmation', 'email', 'transactional', 'We got your message to QueueThat support ({{reference}})',
   'Thanks for contacting QueueThat support. We received "{{subject}}" about {{org}} and will reply to this '
   'email address. Your reference is {{reference}}; please quote it if you write to us again.'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

-- redefines private.notification_address from 20261030100001_appointment_reminders.sql
-- A support request is the recipient of its own mail to the support inbox (the staff member typed no address).
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

-- ------------------------------------------------------------------------------------------------
-- api.contact_support
-- ------------------------------------------------------------------------------------------------

/** The page path without query string or fragment; null when it is not a plain app path. */
create function private.support_route(p_route text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := split_part(split_part(coalesce(p_route, ''), '#', 1), '?', 1);
begin
  if v !~ '^/[A-Za-z0-9_./~-]{0,199}$' then return null; end if;
  -- Guest pages carry secrets in the path; this feature never runs there, so refuse them outright.
  if v ~ '^/(q|v|b|a|u|w|o|pay|display|kiosk)(/|$)' then return null; end if;
  -- A long opaque segment could be a token: keep the page, drop the segment.
  return regexp_replace(v, '/[A-Za-z0-9_-]{40,}(?=/|$)', '/:redacted', 'g');
end $$;
comment on function private.support_route(text) is
  'Sanitises a page path for a support request: no query string, fragment or long opaque segment; null for '
  'anything that is not a plain app path or that is a guest page.';

create function api.contact_support(p_org_id uuid, p_subject text, p_message text, p_context jsonb default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_role app.member_role;
  v_subject text := btrim(coalesce(p_subject, ''), E' \t\r\n');
  v_message text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_in jsonb := coalesce(p_context, '{}');
  v_context jsonb;
  v_viewport jsonb;
  v_w int;
  v_h int;
  v_browser text;
  v_version text;
  v_error text;
  v_org text;
  v_email text;
  r app.support_requests;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Only a member of the org, whatever its status. A stranger and a missing org look the same.
  select m.role into v_role from app.memberships m where m.org_id = p_org_id and m.user_id = uid;
  if not found then
    raise exception 'not_found';
  end if;

  if length(v_subject) not between 1 and 120 or v_subject ~ '[[:cntrl:]]'
     or length(v_message) not between 1 and 4000
     or regexp_replace(v_message, '[' || E'\n\r\t' || ']', '', 'g') ~ '[[:cntrl:]]'
     or jsonb_typeof(v_in) <> 'object' or length(v_in::text) > 4000 then
    raise exception 'invalid_input';
  end if;

  -- One person at a time, so the duplicate check and the rate limit cannot race.
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || uid, 0));

  -- The same words again within a minute is a double click: same reference, nothing new sent.
  select * into r from app.support_requests x
  where x.user_id = uid and x.org_id = p_org_id and x.subject = v_subject and x.message = v_message
    and x.created_at > now() - interval '60 seconds'
  order by x.created_at desc limit 1;
  if found then
    return 'SR-' || lpad(r.number::text, 6, '0');
  end if;

  if (select count(*) from app.support_requests x
      where x.user_id = uid and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;

  -- Whitelist: nothing else in p_context is kept (no storage, tokens, query strings or guest data).
  v_viewport := v_in -> 'viewport';
  if jsonb_typeof(v_viewport) = 'object'
     and jsonb_typeof(v_viewport -> 'w') = 'number' and jsonb_typeof(v_viewport -> 'h') = 'number' then
    v_w := least(greatest(round((v_viewport ->> 'w')::numeric), 0), 20000);
    v_h := least(greatest(round((v_viewport ->> 'h')::numeric), 0), 20000);
  end if;
  v_browser := case when jsonb_typeof(v_in -> 'browser') = 'string'
                    and (v_in ->> 'browser') !~ '[[:cntrl:]]' then left(v_in ->> 'browser', 200) end;
  v_version := case when jsonb_typeof(v_in -> 'app_version') = 'string'
                    and (v_in ->> 'app_version') ~ '^[A-Za-z0-9._-]{1,40}$' then v_in ->> 'app_version' end;
  v_error := case when jsonb_typeof(v_in -> 'last_error_id') = 'string'
                  and (v_in ->> 'last_error_id') ~ '^[A-Za-z0-9_-]{1,64}$' then v_in ->> 'last_error_id' end;

  select o.name into v_org from app.organizations o where o.id = p_org_id;
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'route', case when jsonb_typeof(v_in -> 'route') = 'string' then private.support_route(v_in ->> 'route') end,
    'app_version', v_version,
    'browser', v_browser,
    'viewport', case when v_w > 0 and v_h > 0 then jsonb_build_object('w', v_w, 'h', v_h) end,
    'online', case when jsonb_typeof(v_in -> 'online') = 'boolean' then v_in -> 'online' end,
    'last_error_id', v_error,
    'org_name', v_org,
    'role', v_role,
    'plan', private.org_plan(p_org_id)));

  insert into app.support_requests (org_id, user_id, subject, message, context)
  values (p_org_id, uid, v_subject, v_message, v_context)
  returning * into r;

  select u.email into v_email from auth.users u where u.id = uid;

  -- To the support inbox (private.notification_address resolves the recipient from the request), I-11.
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                 category, vars, dedupe_key)
  select p_org_id, null, 'email', r.id, 'support_request', t.version, t.category,
         jsonb_strip_nulls(jsonb_build_object(
           'reference', 'SR-' || lpad(r.number::text, 6, '0'),
           'org', v_org, 'org_id', p_org_id, 'plan', v_context ->> 'plan', 'role', v_role,
           'user_email', v_email, 'subject', v_subject, 'message', v_message,
           'route', v_context ->> 'route', 'app_version', v_version, 'browser', v_browser,
           'viewport', case when v_w > 0 and v_h > 0 then v_w || 'x' || v_h end,
           'online', v_context ->> 'online', 'last_error_id', v_error)),
         'support_request:' || r.id
  from app.organizations o
  cross join lateral private.resolve_template(p_org_id, null, 'support_request', 'email', o.default_locale) t
  where o.id = p_org_id;

  -- To the requester, with the reference and no copy of the message.
  perform private.enqueue_user_email(
    p_org_id, uid, 'support_confirmation',
    jsonb_build_object('reference', 'SR-' || lpad(r.number::text, 6, '0'), 'subject', v_subject, 'org', v_org),
    'support_confirmation:' || r.id);

  return 'SR-' || lpad(r.number::text, 6, '0');
end $$;
comment on function api.contact_support(uuid, text, text, jsonb) is
  'Any member of the org (staff and up, any org status, including suspended): files a support request and '
  'returns its reference (SR-000123). Stores the subject (1-120 chars, one line) and message (1-4000), and '
  'a whitelisted context: page path without query string or fragment, app version, browser, viewport, online '
  'state and last client error id from p_context, plus org name, role and plan from the database. Nothing else '
  'in p_context is kept and no guest data is read. Queues an email to the support inbox and a confirmation to '
  'the requester through the outbox. The same words again within 60 s return the same reference and send '
  'nothing; more than 5 requests per person per hour raise rate_limited. Raises not_authenticated (42501), '
  'not_found for an org the caller is not a member of (including a revoked membership), invalid_input, '
  'rate_limited.';
revoke all on function api.contact_support(uuid, text, text, jsonb) from public, anon;
grant execute on function api.contact_support(uuid, text, text, jsonb) to authenticated, service_role;
revoke all on function private.support_route(text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------
-- Platform console: list and close
-- ------------------------------------------------------------------------------------------------

create type api.platform_support_request as (
  id uuid,
  reference text,
  user_id uuid,
  user_email text,
  subject text,
  message text,
  context jsonb,
  status text,
  created_at timestamptz,
  closed_at timestamptz
);
grant usage on type api.platform_support_request to authenticated;

create function api.platform_list_support_requests(p_org_id uuid, p_status text default null)
returns setof api.platform_support_request
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('support');
  if p_status is not null and p_status not in ('open', 'closed') then
    raise exception 'invalid_input';
  end if;
  return query
  select r.id, 'SR-' || lpad(r.number::text, 6, '0'), r.user_id, u.email::text, r.subject, r.message, r.context,
         r.status, r.created_at, r.closed_at
  from app.support_requests r
  left join auth.users u on u.id = r.user_id
  where r.org_id = p_org_id and (p_status is null or r.status = p_status)
  order by r.created_at desc
  limit 100;
end $$;
comment on function api.platform_list_support_requests(uuid, text) is
  'Support or operator with aal2: the org''s latest 100 support requests, newest first, optionally only open '
  'or closed. Staff-written text and the whitelisted context; never guest data. Raises permission_denied '
  '(42501) without a platform role and aal2, invalid_input for another status.';
revoke all on function api.platform_list_support_requests(uuid, text) from public, anon;
grant execute on function api.platform_list_support_requests(uuid, text) to authenticated;

create function api.platform_set_support_request_status(p_request_id uuid, p_status text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r app.support_requests;
begin
  perform private.require_platform('support');
  if p_status is null or p_status not in ('open', 'closed') then
    raise exception 'invalid_input';
  end if;
  select * into r from app.support_requests where id = p_request_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- Closing a closed request, or reopening an open one, changes nothing and is not audited twice.
  if r.status = p_status then
    return;
  end if;
  update app.support_requests set
    status = p_status,
    closed_at = case when p_status = 'closed' then now() end,
    closed_by = case when p_status = 'closed' then (select auth.uid()) end
  where id = r.id;
  perform private.platform_audit(
    case p_status when 'closed' then 'support_request.close' else 'support_request.reopen' end,
    r.org_id, jsonb_build_object('support_request_id', r.id, 'reference', 'SR-' || lpad(r.number::text, 6, '0')), null);
end $$;
comment on function api.platform_set_support_request_status(uuid, text) is
  'Support or operator with aal2: closes or reopens a support request. Repeating the current status changes '
  'nothing. Recorded in platform_audit. Raises permission_denied (42501) without a platform role and aal2, '
  'invalid_input for a status other than open or closed, not_found for an unknown request.';
revoke all on function api.platform_set_support_request_status(uuid, text) from public, anon;
grant execute on function api.platform_set_support_request_status(uuid, text) to authenticated;

notify pgrst, 'reload schema';
