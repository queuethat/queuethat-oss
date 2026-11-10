-- C9 (#1275): tenant breach notices and the tenant incident log (epic #1267, forms-privacy-design.md 8).
--
--   * Platform side: an operator drafts a notice for an incident from a template, edits it, a human
--     approves it, and only an explicit send queues it. Sending emails every owner of each scoped org
--     through the outbox (I-11, account mail), starts nothing on its own and stops the incident's
--     72-hour clock. Editing an approved notice returns it to draft.
--   * Tenant side: app.org_incident_log is the business's own record (kept at least 24 months, never
--     deleted by anyone but the org purge). A sent notice prefills one row per org (title, kind, when,
--     data categories and the notice text); admins add what they did, who was affected and any regulator
--     report. The banner shows rows whose notice is not yet acknowledged; acknowledging is tracked.
--   * api.report_incident files a suspected incident from the tenant: a platform incident with the
--     72-hour clock running, a log row for the business, and an email to every platform operator.
--
-- Interface alternatives: (a) one tenant RPC per field edit and a separate banner table; (b) one log
-- table that also carries the notice and its acknowledgment, read by RLS and changed only by RPCs. (b)
-- won: the banner, the export and the acknowledgment read the same row. Tenant reads are plain RLS
-- selects like app.org_privacy; every write is an RPC.
--
-- redefines notification_templates_trigger_check from 20261107235014_sms_operator_warnings.sql

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
                     'incident_notice', 'incident_reported_operator'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('incident_notice', 'email', 'transactional', '{{notice_subject}}',
   '{{notice_body}}' || E'\n\nBusiness: {{org}}' ||
   E'\n\n[Read it and confirm you have in your admin console: {app_url}/admin/privacy]'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]'),
  ('incident_reported_operator', 'email', 'transactional', 'Suspected incident reported by {{org}}',
   '{{org}} ({{org_id}}) reported a suspected incident ({{kind}}): {{title}}. It is in the incident register '
   'and its 72-hour clock is running.' || E'\n\n[Open the register: {app_url}/platform/incidents]'
   || E'\n\n[Not you, or no longer want these? Stop these emails: {unsubscribe_url}]');

------------------------------------------------------------------------------------------------
-- Platform notices (operator only)
------------------------------------------------------------------------------------------------

create table app.incident_notices (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references app.platform_incidents (id) on delete cascade,
  subject text not null check (length(btrim(subject)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 4000),
  status text not null default 'draft' check (status in ('draft', 'approved', 'sent')),
  drafted_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'draft') = (approved_at is null) or status = 'sent'),
  check ((status = 'sent') = (sent_at is not null))
);
-- One notice in progress per incident; sent ones stay as the history (a follow-up starts a new draft).
create unique index incident_notices_open_idx on app.incident_notices (incident_id) where status <> 'sent';
revoke all on app.incident_notices from anon, authenticated, service_role;
grant select on app.incident_notices to authenticated;
alter table app.incident_notices enable row level security;
create policy incident_notices_select on app.incident_notices for select to authenticated
  using ((select private.is_platform('operator')));

------------------------------------------------------------------------------------------------
-- The tenant's incident log
------------------------------------------------------------------------------------------------

create table app.org_incident_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  source text not null check (source in ('platform_notice', 'reported', 'manual')),
  -- The platform incident and notice this row came from. No foreign keys: the platform record
  -- outlives a purged tenant and the log must not depend on it.
  incident_id uuid,
  notice_id uuid,
  kind text not null check (kind in (
    'unauthorized_access', 'data_exposure', 'credential_compromise', 'misdirected_message',
    'lost_device', 'vendor_incident', 'other')),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  data_categories text[] not null default '{}' check (data_categories <@ array[
    'contact', 'visit_history', 'form_answers', 'sensitive_answers', 'payment', 'credentials', 'other']),
  detected_at timestamptz not null,
  people_affected int check (people_affected >= 0),
  actions_taken text check (length(actions_taken) <= 4000),
  regulator_notified text check (length(regulator_notified) <= 500),
  notice_subject text,
  notice_body text,
  notice_sent_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, notice_id),
  check (source <> 'platform_notice' or (notice_id is not null and notice_body is not null))
);
create index org_incident_log_org_idx on app.org_incident_log (org_id, detected_at desc);
comment on table app.org_incident_log is
  'The business''s own incident record, kept at least 24 months: no role can delete a row (only the org '
  'purge cascades). Rows from a platform notice carry its text and the acknowledgment; everything else '
  'is changed through api.update_incident_log_entry. Admins and owners read it.';
create trigger forbid_org_change before update on app.org_incident_log
  for each row execute function private.forbid_org_change();
create trigger touch_updated_at before update on app.org_incident_log
  for each row execute function private.touch_updated_at();
revoke all on app.org_incident_log from anon, authenticated, service_role;
grant select on app.org_incident_log to authenticated;
grant all on app.org_incident_log to service_role;
alter table app.org_incident_log enable row level security;
create policy org_incident_log_select on app.org_incident_log for select to authenticated
  using ((select private.has_role(org_id, null, 'admin')));

------------------------------------------------------------------------------------------------
-- API: platform
------------------------------------------------------------------------------------------------

create type api.incident_notice as (
  id uuid,
  incident_id uuid,
  subject text,
  body text,
  status text,
  approved_at timestamptz,
  sent_at timestamptz,
  -- Orgs the notice went to, and how many have acknowledged it (both 0 until it is sent).
  org_count int,
  acknowledged_count int,
  updated_at timestamptz
);
grant usage on type api.incident_notice to authenticated;

create function private.incident_notice_row(n app.incident_notices) returns api.incident_notice
language sql stable set search_path = '' as $$
  select n.id, n.incident_id, n.subject, n.body, n.status, n.approved_at, n.sent_at,
    (select count(*)::int from app.org_incident_log l where l.notice_id = n.id),
    (select count(*)::int from app.org_incident_log l where l.notice_id = n.id and l.acknowledged_at is not null),
    n.updated_at
$$;
revoke all on function private.incident_notice_row(app.incident_notices) from public, anon, authenticated;

create function api.platform_save_notice(
  p_incident_id uuid, p_subject text default null, p_body text default null
) returns api.incident_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  i app.platform_incidents;
  n app.incident_notices;
begin
  perform private.require_platform('operator');
  select * into i from app.platform_incidents where id = p_incident_id;
  if not found then
    raise exception 'not_found';
  end if;
  select * into n from app.incident_notices where incident_id = p_incident_id and status <> 'sent' for update;
  if not found then
    begin
      insert into app.incident_notices (incident_id, subject, body, drafted_by)
      values (i.id,
        'Security incident that may affect your business',
        'We are writing to tell you about a security incident that may affect your business.' ||
        E'\n\nWhat happened: ' || coalesce(nullif(btrim(i.description), ''), i.title) ||
        E'\n\nWhen we detected it: ' || to_char(i.detected_at at time zone 'UTC', 'FMMonth FMDD, YYYY HH24:MI') || ' UTC' ||
        E'\n\nWhat was involved: ' || case when cardinality(i.data_categories) = 0 then 'still being confirmed'
          else array_to_string(i.data_categories, ', ') end ||
        E'\n\nWhat we have done: ' || coalesce(nullif(btrim(i.containment), ''),
          'we are investigating and will update you') ||
        E'\n\nWhat you can do: open Privacy in your admin console, read this notice and confirm you have. '
        'If guests'' personal information may be involved, you may have duties to tell those guests or a '
        'regulator, and your privacy officer should decide. This is information, not legal advice.' ||
        E'\n\nQuestions: support@queuethat.com',
        (select auth.uid()))
      returning * into n;
    exception when check_violation then
      raise exception 'invalid_input';
    end;
  end if;
  begin
    update app.incident_notices set
      subject = coalesce(nullif(btrim(p_subject), ''), subject),
      body = coalesce(nullif(btrim(p_body), ''), body),
      -- any change after approval needs approving again
      status = 'draft', approved_by = null, approved_at = null, updated_at = now()
    where id = n.id returning * into n;
  exception when check_violation then
    raise exception 'invalid_input';
  end;
  perform private.platform_audit('incident.notice_save', null,
    jsonb_build_object('incident_id', i.id, 'notice_id', n.id), null);
  return private.incident_notice_row(n);
end $$;
comment on function api.platform_save_notice(uuid, text, text) is
  'Operator with aal2: returns the incident''s open notice, creating a draft from the template (what '
  'happened, when, data involved, containment, what the business can do) when there is none; given '
  'subject or body replace the text (null keeps it). Always leaves the notice a draft, so an edit '
  'needs approving again. Nothing is sent. Raises not_found for an unknown incident, invalid_input '
  'for a blank or over-long text, permission_denied (42501) without operator and aal2.';

create function api.platform_approve_notice(p_id uuid) returns api.incident_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.incident_notices;
begin
  perform private.require_platform('operator');
  update app.incident_notices set status = 'approved', approved_by = (select auth.uid()),
    approved_at = now(), updated_at = now()
  where id = p_id and status = 'draft' returning * into n;
  if not found then
    select * into n from app.incident_notices where id = p_id;
    if not found then
      raise exception 'not_found';
    end if;
    return private.incident_notice_row(n);
  end if;
  perform private.platform_audit('incident.notice_approve', null,
    jsonb_build_object('incident_id', n.incident_id, 'notice_id', n.id), null);
  return private.incident_notice_row(n);
end $$;
comment on function api.platform_approve_notice(uuid) is
  'Operator with aal2: marks a draft notice approved by the caller. Approving an approved or sent '
  'notice changes nothing. Does not send. Raises not_found, permission_denied (42501) without '
  'operator and aal2.';

create function api.platform_send_notice(p_id uuid) returns api.incident_notice
language plpgsql volatile security definer set search_path = '' as $$
declare
  n app.incident_notices;
  i app.platform_incidents;
  v_org uuid;
  v_name text;
  v_sent int := 0;
begin
  perform private.require_platform('operator');
  select * into n from app.incident_notices where id = p_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  if n.status = 'sent' then
    return private.incident_notice_row(n);
  end if;
  -- Only an approved notice goes out: a draft is never sent, however it is asked.
  if n.status <> 'approved' then
    raise exception 'invalid_input';
  end if;
  select * into i from app.platform_incidents where id = n.incident_id for update;
  for v_org, v_name in
    select o.id, o.name from app.organizations o where o.id = any (i.org_ids) order by o.id
  loop
    insert into app.org_incident_log (org_id, source, incident_id, notice_id, kind, title, data_categories,
                                      detected_at, notice_subject, notice_body, notice_sent_at)
    values (v_org, 'platform_notice', i.id, n.id, i.kind, n.subject, i.data_categories, i.detected_at,
            n.subject, n.body, now())
    on conflict (org_id, notice_id) do nothing;
    perform private.enqueue_account_email(v_org, 'incident_notice',
      jsonb_build_object('org', v_name, 'notice_subject', n.subject, 'notice_body', n.body),
      'incident_notice:' || n.id || ':' || v_org);
    v_sent := v_sent + 1;
  end loop;
  if v_sent = 0 then
    raise exception 'invalid_input';
  end if;
  update app.incident_notices set status = 'sent', sent_at = now(), updated_at = now()
  where id = n.id returning * into n;
  if i.notified_at is null then
    update app.platform_incidents set notified_at = now(), updated_at = now() where id = i.id;
    perform private.incident_event(i.id, 'notified', format('Notice sent to %s businesses', v_sent));
  end if;
  perform private.platform_audit('incident.notice_send', null,
    jsonb_build_object('incident_id', i.id, 'notice_id', n.id, 'orgs', v_sent), null);
  return private.incident_notice_row(n);
end $$;
comment on function api.platform_send_notice(uuid) is
  'Operator with aal2: sends an approved notice by email to the owners of every scoped org that '
  'still exists, through the outbox, adds the notice to each business''s incident log and stops the '
  'incident''s 72-hour clock. Repeating it changes nothing. A draft is never sent: raises '
  'invalid_input, also when no scoped org exists. Raises not_found, permission_denied (42501) '
  'without operator and aal2.';

create function api.platform_list_notices(p_incident_id uuid) returns setof api.incident_notice
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform('operator');
  return query
  select (private.incident_notice_row(n)).* from app.incident_notices n
  where n.incident_id = p_incident_id order by n.created_at desc, n.id;
end $$;
comment on function api.platform_list_notices(uuid) is
  'Operator with aal2: the incident''s notices, newest first, with how many businesses were told and '
  'how many acknowledged. Raises permission_denied (42501) without operator and aal2.';

------------------------------------------------------------------------------------------------
-- API: the business
------------------------------------------------------------------------------------------------

create function api.acknowledge_incident_notice(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.org_incident_log;
begin
  select * into l from app.org_incident_log where id = p_id and source = 'platform_notice';
  if not found or not private.has_role(l.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  if l.acknowledged_at is null then
    update app.org_incident_log set acknowledged_at = now(), acknowledged_by = (select auth.uid())
    where id = l.id;
    perform private.incident_event(l.incident_id, 'note',
      'Acknowledged by ' || (select o.name from app.organizations o where o.id = l.org_id));
  end if;
end $$;
comment on function api.acknowledge_incident_notice(uuid) is
  'Admin or owner of the business: records that the notice was read, once (who and when); repeating it '
  'changes nothing and adds a note to the platform incident. Raises not_found for an unknown entry, one '
  'that is not a platform notice, or another business''s.';

create function api.update_incident_log_entry(
  p_id uuid,
  p_description text default null,
  p_people_affected int default null,
  p_actions_taken text default null,
  p_regulator_notified text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l app.org_incident_log;
begin
  select * into l from app.org_incident_log where id = p_id;
  if not found or not private.has_role(l.org_id, null, 'admin') then
    raise exception 'not_found';
  end if;
  begin
    update app.org_incident_log set
      description = coalesce(nullif(btrim(p_description), ''), description),
      people_affected = coalesce(p_people_affected, people_affected),
      actions_taken = coalesce(nullif(btrim(p_actions_taken), ''), actions_taken),
      regulator_notified = coalesce(nullif(btrim(p_regulator_notified), ''), regulator_notified)
    where id = l.id;
  exception when check_violation then
    raise exception 'invalid_input';
  end;
end $$;
comment on function api.update_incident_log_entry(uuid, text, int, text, text) is
  'Admin or owner of the business: sets what happened, how many people were affected, what the business '
  'did and any regulator report on one log entry (null keeps a field). The notice text, title, kind '
  'and dates cannot change. Raises not_found for an unknown or another business''s entry, '
  'invalid_input for a negative count or an over-long text.';

create function api.report_incident(
  p_org_id uuid,
  p_kind text,
  p_title text,
  p_description text default null,
  p_detected_at timestamptz default null,
  p_data_categories text[] default '{}',
  p_notify_platform boolean default true,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_at timestamptz := coalesce(p_detected_at, now());
  v_cats text[] := coalesce((select array_agg(distinct c) from unnest(p_data_categories) c), '{}');
  v_name text;
  v_inc app.platform_incidents;
  v_id uuid;
begin
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'invalid_input';
  end if;
  if p_notify_platform then
    if p_idempotency_key is not null then
      select * into v_inc from app.platform_incidents where created_by = v_uid and idempotency_key = p_idempotency_key;
      if found then
        return (select l.id from app.org_incident_log l where l.incident_id = v_inc.id and l.org_id = p_org_id);
      end if;
    end if;
    -- A business cannot flood the register.
    if (select count(*) from app.org_incident_log l
        where l.org_id = p_org_id and l.source = 'reported' and l.created_at > now() - interval '24 hours') >= 5 then
      raise exception 'rate_limited';
    end if;
  end if;
  begin
    if p_notify_platform then
      insert into app.platform_incidents (kind, title, description, detected_at, org_ids, data_categories,
                                          created_by, idempotency_key)
      values (p_kind, v_title, nullif(btrim(p_description), ''), v_at, array[p_org_id], v_cats, v_uid, p_idempotency_key)
      returning * into v_inc;
      perform private.incident_event(v_inc.id, 'created', v_title);
    end if;
    insert into app.org_incident_log (org_id, source, incident_id, kind, title, description, data_categories,
                                      detected_at, created_by)
    values (p_org_id, case when p_notify_platform then 'reported' else 'manual' end, v_inc.id, p_kind, v_title,
            nullif(btrim(p_description), ''), v_cats, v_at, v_uid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input';
  end;
  if p_notify_platform then
    select o.name into v_name from app.organizations o where o.id = p_org_id;
    perform private.platform_audit('incident.report', p_org_id, jsonb_build_object('incident_id', v_inc.id), null);
    insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key, template_version,
                                   category, vars, dedupe_key)
    select p_org_id, null, 'email', r.user_id, 'incident_reported_operator', t.version, t.category,
           jsonb_build_object('org', v_name, 'org_id', p_org_id, 'kind', p_kind, 'title', v_title),
           'incident_reported_operator:' || v_inc.id || ':' || r.user_id
    from app.platform_roles r
    join auth.users u on u.id = r.user_id and u.email is not null
    cross join lateral private.resolve_template(p_org_id, null, 'incident_reported_operator', 'email', 'en') t
    where r.role = 'operator'
    on conflict (dedupe_key) do nothing;
  end if;
  return v_id;
end $$;
comment on function api.report_incident(uuid, text, text, text, timestamptz, text[], boolean, uuid) is
  'Admin or owner of the business: adds an entry to its incident log and, unless p_notify_platform is '
  'false, files a suspected platform incident for the business (the 72-hour clock starts at detection, '
  'default now) and emails the platform operators. Repeating p_idempotency_key returns the same entry. '
  'At most 5 reports per business per 24 hours (rate_limited). Raises invalid_input for a bad kind, '
  'category, blank title or a detection time in the future, permission_denied (42501) for anyone who '
  'is not an admin of p_org_id. Returns the log entry id.';

revoke all on function api.platform_save_notice(uuid, text, text), api.platform_approve_notice(uuid),
  api.platform_send_notice(uuid), api.platform_list_notices(uuid), api.acknowledge_incident_notice(uuid),
  api.update_incident_log_entry(uuid, text, int, text, text),
  api.report_incident(uuid, text, text, text, timestamptz, text[], boolean, uuid) from public, anon;
grant execute on function api.platform_save_notice(uuid, text, text), api.platform_approve_notice(uuid),
  api.platform_send_notice(uuid), api.platform_list_notices(uuid), api.acknowledge_incident_notice(uuid),
  api.update_incident_log_entry(uuid, text, int, text, text),
  api.report_incident(uuid, text, text, text, timestamptz, text[], boolean, uuid) to authenticated;

notify pgrst, 'reload schema';
