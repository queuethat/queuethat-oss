-- PLT4 (#410): platform tenant RPCs: directory, org detail, status, ownership transfer
-- (technical-design.md 3.6). Aggregates and member data only: guest names, contacts and
-- custom answers stay behind a support grant. Every change is idempotent (rule 4) and audited
-- in platform_audit; the organizations and memberships audit triggers add the org's own row.

create type api.platform_org_row as (
  id uuid,
  name text,
  -- The org's first location's public slug, for finding a tenant from a poster URL.
  slug text,
  status app.org_status,
  created_at timestamptz,
  owner_email text,
  last_activity_at timestamptz,
  visits_7d int,
  notifications_sent_7d int,
  notifications_failed_7d int,
  members int,
  locations int
);

create type api.platform_org_detail as (
  org api.platform_org_row,
  suspended_reason text,
  suspended_at timestamptz,
  -- [{user_id, email, role, created_at}]
  members jsonb,
  -- [{id, name, slug, tz, queues: [{id, name, manual_state, archived}]}]
  locations jsonb,
  -- [{id, location_id, kind, name, last_seen_at, app_version, revoked_at}]
  devices jsonb,
  -- Last 50 audit_log rows without before/after payloads: [{id, actor, role, action, table_name, row_id, at}]
  recent_audit jsonb,
  -- The live owner grant or break-glass, or null: {id, scope, reason, break_glass, expires_at}
  support_grant jsonb
);
grant usage on type api.platform_org_row, api.platform_org_detail to authenticated;

/** The directory row for one org, computed live. */
create function private.platform_org_row(p_org_id uuid) returns api.platform_org_row
language sql stable set search_path = '' as $$
  select o.id, o.name,
         (select l.slug from app.locations l where l.org_id = o.id order by l.created_at, l.id limit 1),
         o.status, o.created_at,
         (select u.email from app.memberships m join auth.users u on u.id = m.user_id
          where m.org_id = o.id and m.role = 'owner' order by m.created_at, m.user_id limit 1),
         (select max(v.joined_at) from app.visits v where v.org_id = o.id),
         (select count(*)::int from app.visits v where v.org_id = o.id and v.joined_at > now() - interval '7 days'),
         (select count(*)::int from app.notifications n
          where n.org_id = o.id and n.status = 'sent' and n.created_at > now() - interval '7 days'),
         (select count(*)::int from app.notifications n
          where n.org_id = o.id and n.status in ('failed', 'dead') and n.created_at > now() - interval '7 days'),
         (select count(*)::int from app.memberships m where m.org_id = o.id),
         (select count(*)::int from app.locations l where l.org_id = o.id)
  from app.organizations o
  where o.id = p_org_id
$$;

/** Queues p_template_key by email to one member, idempotent per (p_scope, user). */
create function private.enqueue_user_email(p_org_id uuid, p_user_id uuid, p_template_key text,
                                           p_vars jsonb, p_scope text)
returns void
language sql volatile set search_path = '' as $$
  insert into app.notifications (org_id, visit_id, channel, recipient_ref, template_key,
                                 template_version, category, vars, dedupe_key)
  select p_org_id, null, 'email', u.id, p_template_key, t.version, t.category,
         coalesce(p_vars, '{}'), concat_ws(':', p_scope, 'email', u.id)
  from auth.users u
  join app.organizations o on o.id = p_org_id
  cross join lateral private.resolve_template(p_org_id, null, p_template_key, 'email', o.default_locale) t
  where u.id = p_user_id and u.email is not null
  on conflict (dedupe_key) do nothing
$$;
comment on function private.enqueue_user_email(uuid, uuid, text, jsonb, text) is
  'Queues an account email (template p_template_key, variables p_vars) to one member with a '
  'sign-in email. Idempotent per (p_scope, user). Called by definer functions only.';

-- redefines private.enqueue_account_email from 20261025003800_account_emails.sql
-- Now one row per owner through enqueue_user_email.
create or replace function private.enqueue_account_email(p_org_id uuid, p_template_key text, p_vars jsonb, p_scope text)
returns void
language sql volatile set search_path = '' as $$
  select private.enqueue_user_email(p_org_id, m.user_id, p_template_key, p_vars, p_scope)
  from app.memberships m
  where m.org_id = p_org_id and m.role = 'owner'
$$;

alter table app.notification_templates drop constraint notification_templates_trigger_check;
alter table app.notification_templates add constraint notification_templates_trigger_check
  check (trigger in ('called', 'almost_up', 'support.break_glass', 'org.ownership_transferred'));

insert into app.notification_templates (trigger, channel, category, subject, body) values
  ('org.ownership_transferred', 'email', 'transactional', 'Ownership of {org} has changed',
   'Ownership of {org} was transferred to {new_owner} by platform support. Previous owners are '
   'now admins. Reason given: {reason}. If you did not ask for this, reply to this email.');

------------------------------------------------------------------------------------------------
-- RPCs
------------------------------------------------------------------------------------------------

create function api.platform_list_orgs(
  p_search text,
  p_status app.org_status default null,
  p_limit int default 50,
  p_after uuid default null
) returns setof api.platform_org_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text := nullif(btrim(p_search), '');
begin
  perform private.require_platform('support');
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid_input';
  end if;
  return query
  select (private.platform_org_row(o.id)).*
  from app.organizations o
  where (p_status is null or o.status = p_status)
    and (p_after is null or o.id > p_after)
    and (v_search is null
         or o.name ilike '%' || v_search || '%'
         or exists (select 1 from app.locations l where l.org_id = o.id and l.slug ilike '%' || v_search || '%')
         or exists (select 1 from app.memberships m join auth.users u on u.id = m.user_id
                    where m.org_id = o.id and m.role = 'owner' and u.email ilike '%' || v_search || '%'))
  order by o.id
  limit p_limit;
end $$;
comment on function api.platform_list_orgs(text, app.org_status, int, uuid) is
  'Support or operator with aal2: tenants ordered by id, optionally filtered by status and by a '
  'search over name, location slug and owner email. Page with p_after = the last id seen; every '
  'org appears exactly once across pages. Counts cover the last 7 days. No guest data. Raises '
  'permission_denied (42501) without a platform role and aal2, invalid_input for p_limit outside '
  '1-200.';

create function api.platform_get_org(p_org_id uuid) returns api.platform_org_detail
language plpgsql stable security definer set search_path = '' as $$
declare
  o app.organizations;
  result api.platform_org_detail;
begin
  perform private.require_platform('support');
  select * into o from app.organizations where id = p_org_id;
  if not found then
    raise exception 'not_found';
  end if;

  result.org := private.platform_org_row(o.id);
  result.suspended_reason := o.suspended_reason;
  result.suspended_at := o.suspended_at;
  result.members := coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role,
                                        'created_at', m.created_at) order by m.role desc, u.email)
    from app.memberships m join auth.users u on u.id = m.user_id
    where m.org_id = o.id), '[]');
  result.locations := coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id, 'name', l.name, 'slug', l.slug, 'tz', l.tz,
             'queues', coalesce((select jsonb_agg(jsonb_build_object(
                                   'id', q.id, 'name', q.name, 'manual_state', q.manual_state,
                                   'archived', q.archived_at is not null) order by q.sort_order, q.name)
                                 from app.queues q where q.location_id = l.id), '[]'))
           order by l.created_at)
    from app.locations l where l.org_id = o.id), '[]');
  result.devices := coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'location_id', d.location_id, 'kind', d.kind,
                                        'name', d.name, 'last_seen_at', d.last_seen_at,
                                        'app_version', d.app_version, 'revoked_at', d.revoked_at)
                     order by d.created_at)
    from app.devices d where d.org_id = o.id), '[]');
  result.recent_audit := coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'actor', a.actor, 'role', a.role, 'action', a.action,
                                        'table_name', a.table_name, 'row_id', a.row_id, 'at', a.at)
                     order by a.at desc, a.id desc)
    from (select * from app.audit_log where org_id = o.id order by at desc, id desc limit 50) a), '[]');
  result.support_grant := (
    select jsonb_build_object('id', g.id, 'scope', g.scope, 'reason', g.reason,
                              'break_glass', g.break_glass, 'expires_at', g.expires_at)
    from app.support_grants g
    where g.org_id = o.id and g.revoked_at is null and g.expires_at > now()
    order by g.break_glass, g.expires_at desc limit 1);
  return result;
end $$;
comment on function api.platform_get_org(uuid) is
  'Support or operator with aal2: one tenant''s directory row plus members (with emails and '
  'roles), locations and queues, devices with last seen, the last 50 audit rows without their '
  'before/after payloads, and the live support grant. Contains no guest names, contacts or '
  'answers. Raises permission_denied (42501) without a platform role and aal2, not_found for an '
  'unknown org.';

create function api.platform_set_org_status(p_org_id uuid, p_status app.org_status, p_reason text)
returns api.platform_org_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  o app.organizations;
begin
  perform private.require_platform('operator');
  if p_status is null or p_status = 'pending_deletion' or length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    raise exception 'invalid_input';
  end if;
  select * into o from app.organizations where id = p_org_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  -- pending_deletion belongs to org deletion (2A); its status is not changed from here.
  if o.status = 'pending_deletion' then
    raise exception 'invalid_input';
  end if;

  if o.status <> p_status then
    update app.organizations set
      status = p_status,
      suspended_reason = case when p_status = 'suspended' then btrim(p_reason) end,
      suspended_at = case when p_status = 'suspended' then now() end,
      suspended_by = case when p_status = 'suspended' then (select auth.uid()) end
    where id = o.id;
    perform private.platform_audit(
      case p_status when 'suspended' then 'org.suspend' else 'org.unsuspend' end, o.id,
      jsonb_build_object('from', o.status, 'to', p_status), btrim(p_reason));
  end if;
  return private.platform_org_row(o.id);
end $$;
comment on function api.platform_set_org_status(uuid, app.org_status, text) is
  'Operator with aal2: suspends (''suspended'') or restores (''active'') a tenant with a required '
  'reason and returns its row. Setting the current status again returns the row and writes '
  'nothing. Enforcement is in the role helpers and the accepting predicate (PLT2). Audited in '
  'platform_audit and the org''s audit_log. Raises permission_denied (42501) without operator '
  'and aal2, invalid_input for a blank reason, a null status, ''pending_deletion'' or an org '
  'pending deletion, not_found for an unknown org.';

create function api.platform_transfer_ownership(p_org_id uuid, p_new_owner_email text, p_reason text)
returns api.platform_org_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  o app.organizations;
  v_new uuid;
  v_new_email text;
  v_old uuid[];
  r uuid;
  v_vars jsonb;
begin
  perform private.require_platform('operator');
  if length(btrim(coalesce(p_reason, ''))) not between 1 and 500
     or length(btrim(coalesce(p_new_owner_email, ''))) = 0 then
    raise exception 'invalid_input';
  end if;
  select * into o from app.organizations where id = p_org_id for update;
  if not found then
    raise exception 'not_found';
  end if;
  select m.user_id, u.email into v_new, v_new_email
  from app.memberships m join auth.users u on u.id = m.user_id
  where m.org_id = o.id and lower(u.email) = lower(btrim(p_new_owner_email));
  if v_new is null then
    raise exception 'not_a_member';
  end if;

  select coalesce(array_agg(m.user_id), '{}') into v_old
  from app.memberships m where m.org_id = o.id and m.role = 'owner' and m.user_id <> v_new;
  -- Already the only owner: nothing to do.
  if cardinality(v_old) = 0
     and exists (select 1 from app.memberships where org_id = o.id and user_id = v_new and role = 'owner') then
    return private.platform_org_row(o.id);
  end if;

  update app.memberships set role = 'admin' where org_id = o.id and user_id = any (v_old);
  update app.memberships set role = 'owner' where org_id = o.id and user_id = v_new;

  perform private.platform_audit('org.transfer_ownership', o.id,
    jsonb_build_object('new_owner', v_new, 'previous_owners', to_jsonb(v_old)), btrim(p_reason));
  v_vars := jsonb_build_object('org', o.name, 'new_owner', v_new_email, 'reason', btrim(p_reason));
  foreach r in array v_old || v_new loop
    perform private.enqueue_user_email(o.id, r, 'org.ownership_transferred', v_vars,
                                       'transfer:' || o.id || ':' || v_new || ':' || extract(epoch from now())::bigint);
  end loop;
  return private.platform_org_row(o.id);
end $$;
comment on function api.platform_transfer_ownership(uuid, text, text) is
  'Operator with aal2: makes the member with p_new_owner_email the org''s only owner; previous '
  'owners become admins. Both sides are emailed, and the change is audited in platform_audit and '
  'the org''s audit_log. Transferring to the current only owner returns the row and changes '
  'nothing. Raises permission_denied (42501) without operator and aal2, invalid_input for a blank '
  'email or reason, not_found for an unknown org, not_a_member when that email is not a member.';

revoke all on function private.platform_org_row(uuid) from public, anon, authenticated;
revoke all on function private.enqueue_user_email(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function api.platform_list_orgs(text, app.org_status, int, uuid) from public, anon;
revoke all on function api.platform_get_org(uuid) from public, anon;
revoke all on function api.platform_set_org_status(uuid, app.org_status, text) from public, anon;
revoke all on function api.platform_transfer_ownership(uuid, text, text) from public, anon;
grant execute on function api.platform_list_orgs(text, app.org_status, int, uuid) to authenticated;
grant execute on function api.platform_get_org(uuid) to authenticated;
grant execute on function api.platform_set_org_status(uuid, app.org_status, text) to authenticated;
grant execute on function api.platform_transfer_ownership(uuid, text, text) to authenticated;
