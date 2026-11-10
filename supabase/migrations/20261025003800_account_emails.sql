-- #443: account emails through the outbox. Messages to members (not guests) about their
-- account or org, starting with the break-glass notice to owners (PLT3, #409); PLT4 adds
-- ownership transfer. The dispatcher sends them like any other row.
--
--   * An account row is one with no visit (visit_id null, category transactional); recipient_ref
--     is the member's auth user id. No new enum value, so nothing here needs a second migration.
--   * claim_outbox resolves the member's sign-in email, reports consent (account mail is part of
--     the service) and suppression by that address, and the org's default locale. location_tz is
--     null, so quiet hours never hold these back.
--   * Only admins and owners see account rows; staff keep seeing visit notifications (N-12).

alter table app.notifications alter column visit_id drop not null;
alter table app.notifications add constraint notifications_account_has_no_visit
  check (visit_id is not null or category = 'transactional');
comment on column app.notifications.recipient_ref is
  'push_subscriptions.id or guest_contacts.id; auth.users.id for account mail. Never the raw address.';

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'support.break_glass'));

insert into app.notification_templates (trigger, channel, category, subject, body)
select 'support.break_glass', 'email', 'transactional',
       'Emergency support access to {org}',
       'A platform operator opened one hour of read-only emergency access to {org}, until {until}. '
       'Reason given: {reason}. It is recorded in your audit log, and you can end it now from '
       'settings by revoking support access.';

/**
 * Queues p_template_key by email to every owner of p_org_id who has a sign-in email.
 * Idempotent per (p_scope, owner).
 */
create function private.enqueue_account_email(p_org_id uuid, p_template_key text, p_vars jsonb, p_scope text)
returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_org_id, null, 'email', m.user_id, p_template_key, t.version, t.category,
         coalesce(p_vars, '{}'), concat_ws(':', p_scope, 'email', m.user_id)
  from app.memberships m
  join auth.users u on u.id = m.user_id and u.email is not null
  join app.organizations o on o.id = m.org_id
  cross join lateral private.resolve_template(p_org_id, null, p_template_key, 'email', o.default_locale) t
  where m.org_id = p_org_id and m.role = 'owner'
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_account_email(uuid, text, jsonb, text) is
  'Queues an account email (template p_template_key, variables p_vars) to every owner of the org '
  'with a sign-in email. Idempotent per (p_scope, owner). Called by definer functions only.';
revoke all on function private.enqueue_account_email(uuid, text, jsonb, text) from public, anon, authenticated;

-- claim_outbox: body from 20261025003000, extended for account rows.
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
              else
                (select jsonb_build_object('kind', 'address', 'value', gc.value)
                 from app.guest_contacts gc where gc.id = n.recipient_ref and gc.org_id = n.org_id)
         end,
         -- A push subscription is its own opt-in, and account mail is part of the service the
         -- member signed up for; other channels need the latest consent granted.
         n.channel = 'push' or n.visit_id is null
           or coalesce((select c.status = 'granted' and c.revoked_at is null
                        from app.consents c where c.id = n.consent_id), false),
         n.channel <> 'push' and exists (
           select 1 from app.suppressions sp
           where sp.org_id = n.org_id and sp.channel = n.channel
             and sp.value = case when n.visit_id is null
                                 then (select u.email from auth.users u where u.id = n.recipient_ref)
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
  'recipient (null once deleted), template, consent and suppression facts and the location time '
  'zone. Account mail (no visit) goes to the member''s sign-in email, counts as '
  'consented, and has no location time zone. Concurrent dispatchers never receive the same row. '
  'A row whose lease expires is due again and counts as an attempt; at the sixth it is marked '
  'dead. Raises invalid_input. Implemented in N3 (#69).';

create or replace function api.outbox_still_relevant(p_outbox_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select case
      -- Account mail is about something that already happened; it stays worth sending.
      when n.visit_id is null then true
      -- The call must still stand: not undone, and not superseded by a later call or recall.
      when n.template_key = 'called' then v.status = 'called' and e.undone_by_event_id is null
        and not exists (select 1 from app.visit_events l
                        where l.visit_id = v.id and l.id > n.event_id and l.type in ('call', 'recall'))
      when n.template_key = 'almost_up' then v.status = 'waiting'
      else v.status in ('expected', 'waiting', 'called', 'serving')
    end
    from app.notifications n
    left join app.visits v on v.id = n.visit_id
    left join app.visit_events e on e.id = n.event_id
    where n.id = p_outbox_id
  ), false);
end $$;
comment on function api.outbox_still_relevant(uuid) is
  'False when sending would be wrong now: almost_up once the guest is no longer waiting, called '
  'after the call was undone, superseded by a newer call or the guest moved on, anything for a '
  'finished visit or an unknown id. Account mail is always still relevant. Implemented in N2 (#68).';

-- platform_break_glass: body from 20261025003620, now also emails the owners.
create or replace function api.platform_break_glass(p_org_id uuid, p_reason text) returns app.support_grants
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result app.support_grants;
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id) then
    raise exception 'not_found';
  end if;

  select * into result from app.support_grants
  where org_id = p_org_id and break_glass and grantee = uid and revoked_at is null and expires_at > now();
  if found then
    return result;
  end if;

  insert into app.support_grants (org_id, granted_by, grantee, scope, reason, break_glass, expires_at)
  values (p_org_id, uid, uid, 'read', btrim(p_reason), true, now() + interval '1 hour')
  returning * into result;
  perform private.platform_audit('support.break_glass', p_org_id,
                                 jsonb_build_object('support_grant_id', result.id), result.reason);
  perform private.enqueue_account_email(
    p_org_id, 'support.break_glass',
    jsonb_build_object('org', (select o.name from app.organizations o where o.id = p_org_id),
                       'reason', result.reason,
                       'until', to_char(result.expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
    'break_glass:' || result.id);
  return result;
end $$;
comment on function api.platform_break_glass(uuid, text) is
  'Operator only (aal2): opens one hour of read-only access to the org for the caller, with a '
  'required reason, and returns the grant. Recorded in platform_audit and in the org''s own '
  'audit_log, emailed to every owner, and visible to the owner, who can end it with '
  'revoke_support_access; the operator cannot revoke or hide it. Calling again while it is live '
  'returns the same grant and sends nothing new. Raises permission_denied (42501) without '
  'operator and aal2, invalid_input for a blank reason, not_found for an unknown org.';

-- Account rows can carry operator reasons: admins and owners only.
drop policy notifications_select on app.notifications;
create policy notifications_select on app.notifications for select to authenticated
  using (case when visit_id is null then (select private.has_role(org_id, null, 'admin'))
              else (select private.has_role(org_id, null, 'staff')) end);
