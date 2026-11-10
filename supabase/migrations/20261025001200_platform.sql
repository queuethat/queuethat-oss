-- PLT1 (#407): platform core for the SaaS operator console (technical-design.md 3.6).
-- Platform roles, org status, the append-only platform audit, and the one guard every
-- api.platform_* function calls first.
--
--   * Operators and support staff are ordinary auth users with an app.platform_roles row. No RPC
--     or UI grants a platform role: rows are written with the service role by
--     `pnpm platform:grant`, and every change is audited by trigger, whoever makes it.
--   * Platform access needs an MFA session (aal2), so a phished password alone never reaches
--     tenant controls. private.require_platform enforces both; a structural test
--     (supabase/tests/platform/guard.test.sql) fails CI for any api.platform_* without it.
--   * A platform role grants no tenant data. The RLS matrix's `platform` actor is denied on every
--     tenant table; support access arrives later through owner-granted support grants (PLT3).

------------------------------------------------------------------------------------------------
-- Types
------------------------------------------------------------------------------------------------

-- Declaration order is the ladder: operator >= support.
create type app.platform_role as enum ('support', 'operator');
create type app.org_status as enum ('active', 'suspended', 'pending_deletion');
grant usage on type app.platform_role, app.org_status to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Platform roles
------------------------------------------------------------------------------------------------

create table app.platform_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role app.platform_role not null,
  -- null when granted with the service role (the CLI), which has no user identity.
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now()
);

------------------------------------------------------------------------------------------------
-- Platform audit: one row per operator action, append-only for every role
------------------------------------------------------------------------------------------------

create table app.platform_audit (
  id bigint generated always as identity primary key,
  -- No foreign keys: the record outlives the operator's account and the org it is about.
  actor_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  org_id uuid,
  target jsonb not null default '{}',
  reason text,
  at timestamptz not null default now()
);
create index platform_audit_at_idx on app.platform_audit (at desc);
create index platform_audit_org_idx on app.platform_audit (org_id, at desc) where org_id is not null;

create function private.forbid_platform_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'platform_audit is append-only' using errcode = '42501';
end $$;

-- Triggers also stop the table owner, which privileges alone would not.
create trigger forbid_change before update or delete on app.platform_audit
  for each row execute function private.forbid_platform_audit_change();
create trigger forbid_truncate before truncate on app.platform_audit
  for each statement execute function private.forbid_platform_audit_change();

/**
 * Appends one platform_audit row naming the caller. Not SECURITY DEFINER and not granted to
 * any API role: only definer functions (api.platform_* and the trigger below) call it.
 */
create function private.platform_audit(p_action text, p_org_id uuid, p_target jsonb, p_reason text)
returns void
language sql volatile set search_path = '' as $$
  insert into app.platform_audit (actor_id, action, org_id, target, reason)
  values ((select auth.uid()), p_action, p_org_id, coalesce(p_target, '{}'), p_reason)
$$;
comment on function private.platform_audit(text, uuid, jsonb, text) is
  'Appends a platform_audit row with the caller as actor. Called only by definer functions.';

create function private.audit_platform_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.platform_audit(
    case tg_op when 'INSERT' then 'platform_role.grant'
               when 'UPDATE' then 'platform_role.change'
               else 'platform_role.revoke' end,
    null,
    jsonb_build_object(
      'user_id', coalesce(new.user_id, old.user_id),
      'role', new.role,
      'previous_role', old.role,
      -- The API role that made the change ('service_role' for the CLI), or the database login.
      'via', coalesce((select auth.jwt()) ->> 'role', session_user)
    ),
    null);
  return null;
end $$;
comment on function private.audit_platform_role() is
  'AFTER trigger on platform_roles: every grant, change and revoke lands in platform_audit, '
  'whichever role made it.';

create trigger audit_platform_role after insert or update or delete on app.platform_roles
  for each row execute function private.audit_platform_role();

------------------------------------------------------------------------------------------------
-- Organization status
------------------------------------------------------------------------------------------------

alter table app.organizations
  add column status app.org_status not null default 'active',
  add column suspended_reason text,
  add column suspended_at timestamptz,
  add column suspended_by uuid references auth.users (id) on delete set null;

-- Only platform definer functions (PLT2) change status. UPDATE becomes a column grant, so the
-- status columns, and any column added later until it is granted here, are not updatable by
-- API roles. Enforcing status in has_role / is_device / the accepting predicate is PLT2.
revoke update on app.organizations from authenticated, service_role;
grant update (name, logo_path, default_locale, legal_name, postal_address, support_contact)
  on app.organizations to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- Guard
------------------------------------------------------------------------------------------------

create function private.is_platform(p_min app.platform_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
     and exists (
       select 1 from app.platform_roles r
       where r.user_id = (select auth.uid()) and r.role >= p_min
     )
$$;
comment on function private.is_platform(app.platform_role) is
  'True when the caller holds p_min or a higher platform role and the session is aal2 (MFA). '
  'For policies; functions call private.require_platform instead.';

create function private.require_platform(p_min app.platform_role) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not private.is_platform(p_min) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
end $$;
comment on function private.require_platform(app.platform_role) is
  'Raises permission_denied (42501) unless the caller holds p_min or higher AND the session is '
  'aal2. Every api.platform_* function calls it first.';

grant execute on function private.is_platform(app.platform_role) to authenticated, service_role;
grant execute on function private.require_platform(app.platform_role) to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- api.platform_whoami
------------------------------------------------------------------------------------------------

create function api.platform_whoami() returns app.platform_role
language sql stable set search_path = '' as $$
  select r.role from app.platform_roles r where r.user_id = (select auth.uid())
$$;
comment on function api.platform_whoami() is
  'The caller''s platform role, or null when they have none. Never raises and needs no MFA '
  'session, so the console can send an aal1 operator to MFA enrolment. Holding a role grants '
  'nothing by itself: every other api.platform_* function also requires aal2.';

revoke all on function api.platform_whoami() from public, anon;
grant execute on function api.platform_whoami() to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

-- platform_roles: written only with the service role (pnpm platform:grant). platform_audit:
-- written only by definer functions; no API role can insert, change or remove a row.
revoke insert, update, delete, truncate on app.platform_roles from authenticated;
revoke insert, update, delete, truncate on app.platform_audit from authenticated, service_role;

alter table app.platform_roles enable row level security;
alter table app.platform_audit enable row level security;

create policy platform_roles_select on app.platform_roles for select to authenticated
  using (user_id = (select auth.uid()));

create policy platform_audit_select on app.platform_audit for select to authenticated
  using ((select private.is_platform('operator')));
