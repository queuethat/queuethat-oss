-- #1342 (C9b): a sent incident notice also reaches the business's privacy/breach contact (epic #1267).
--
-- The contact (app.org_privacy, C7) is who the business named for exactly this and need not be an
-- owner. The outbox row's recipient_ref is the org id; private.notification_address resolves it to
-- app.org_privacy.email, so claim_outbox, suppression and retries are unchanged.
--
-- Interface alternatives: (a) a second recipient column on app.notifications and a branch in
-- claim_outbox; (b) a new recipient_ref meaning resolved inside notification_address. (b) won: the
-- address is looked up where every other recipient type is, and claim_outbox is untouched.
--
-- redefines private.notification_address from 20261102075216_contact_support.sql
-- redefines api.platform_send_notice from 20261109132212_incident_notices.sql

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
    when p_visit_id is null and exists (select 1 from auth.users u where u.id = p_recipient_ref) then (
      select u.email from auth.users u where u.id = p_recipient_ref)
    when p_recipient_ref = p_visit_id then (
      select case p_channel when 'email' then v.guest_email else v.guest_phone_e164 end
      from app.visits v where v.id = p_visit_id)
    else (select gc.value from app.guest_contacts gc where gc.id = p_recipient_ref and gc.org_id = p_org_id)
  end
$$;

/**
 * Queues p_template_key by email to the org's recorded privacy/breach contact, once per p_scope.
 * Does nothing without a contact, or when an owner already gets this mail at the same address.
 */
create function private.enqueue_breach_contact_email(p_org_id uuid, p_template_key text, p_vars jsonb, p_scope text)
returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_org_id, null, 'email', p_org_id, p_template_key, t.version, t.category,
         coalesce(p_vars, '{}'), concat_ws(':', p_scope, 'email', 'privacy_contact', p_org_id)
  from app.org_privacy p
  join app.organizations o on o.id = p.org_id
  cross join lateral private.resolve_template(p_org_id, null, p_template_key, 'email', o.default_locale) t
  where p.org_id = p_org_id
    and not exists (select 1 from app.memberships m join auth.users u on u.id = m.user_id
                    where m.org_id = p_org_id and m.role = 'owner'
                      and lower(btrim(u.email)) = lower(btrim(p.email)))
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_breach_contact_email(uuid, text, jsonb, text) is
  'Queues an account email to the org''s privacy/breach contact (app.org_privacy.email). Idempotent per '
  '(p_scope, org). Skipped when no contact is recorded or an owner has the same address. Definer functions only.';
revoke all on function private.enqueue_breach_contact_email(uuid, text, jsonb, text) from public, anon, authenticated;

create or replace function api.platform_send_notice(p_id uuid) returns api.incident_notice
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
    perform private.enqueue_breach_contact_email(v_org, 'incident_notice',
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
  'still exists and to its recorded privacy/breach contact, through the outbox, adds the notice to each '
  'business''s incident log and stops the incident''s 72-hour clock. Repeating it changes nothing. A draft '
  'is never sent: raises invalid_input, also when no scoped org exists. Raises not_found, '
  'permission_denied (42501) without operator and aal2.';
