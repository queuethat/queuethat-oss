-- 2P-SEC1 (#205): when an org requires MFA, owner/admin privileges need an aal2 session.
-- Enforcement is the central role helper, so every policy and RPC follows without edits. A member
-- below aal2 is capped at manager: the floor keeps running (call_next, transitions) while org
-- configuration, export and deletion stop.
-- redefines private.has_role from 20261025003620_support_grants.sql

alter table app.organizations add column require_mfa_for_admins boolean not null default false;
-- Not granted to authenticated for update: only api.set_require_mfa changes it.

create or replace function private.has_role(p_org_id uuid, p_location_id uuid, p_min_role app.member_role)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from app.memberships m
    join app.organizations o on o.id = m.org_id
    where m.user_id = (select auth.uid())
      and m.org_id = p_org_id
      and (case
             when o.require_mfa_for_admins and m.role > 'manager'
                  and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then 'manager'::app.member_role
             else m.role
           end) >= p_min_role
      and (m.location_ids is null or p_location_id is null or p_location_id = any (m.location_ids))
      and (o.status = 'active' or p_min_role = 'staff')
  ) or exists (
    select 1
    from private.support_grant(p_org_id) g
    join app.organizations o on o.id = g.org_id
    where g.id is not null
      and case g.scope when 'act' then p_min_role <= 'admin' else p_min_role = 'staff' end
      and (o.status = 'active' or p_min_role = 'staff')
  )
$$;
comment on function private.has_role(uuid, uuid, app.member_role) is
  'True when the caller is a member of the org with at least p_min_role. With a location, the '
  'membership must cover it (location_ids null = all). With p_location_id null, any membership '
  'in the org counts. A platform user with a live support grant (private.support_grant) passes '
  'staff-level checks with ''read'' and checks up to admin with ''act'', at every location; '
  'never owner. When the org is not active (suspended or pending_deletion), only staff-level '
  'checks pass; every manager-level or higher check fails. When the org requires MFA '
  '(require_mfa_for_admins), an owner or admin whose session is not aal2 counts as a manager. '
  'Staff-level checks also admit reads, so writes behind them are refused by '
  'private.write_blocked_reason. The only role check policies and api functions use.';

/**
 * Raises mfa_required when the caller has a verified factor but this session is not aal2. For
 * the most sensitive actions (export, guest erasure, org deletion), whatever the org setting.
 */
create function private.require_aal2_if_enrolled() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
     and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required';
  end if;
end $$;
comment on function private.require_aal2_if_enrolled() is
  'Raises mfa_required when the caller has a verified authenticator but the session is below aal2.';
revoke all on function private.require_aal2_if_enrolled() from public, anon;
grant execute on function private.require_aal2_if_enrolled() to authenticated;

create function api.set_require_mfa(p_org_id uuid, p_required boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_required is null then
    raise exception 'invalid_input';
  end if;
  -- Raw membership, not has_role: an owner below aal2 is capped at manager once MFA is required,
  -- and must be told to step up rather than be denied.
  if not exists (select 1 from app.memberships m where m.org_id = p_org_id and m.user_id = (select auth.uid())) then
    raise exception 'not_found';
  end if;
  if not exists (select 1 from app.memberships m
                 where m.org_id = p_org_id and m.user_id = (select auth.uid()) and m.role = 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required';
  end if;
  update app.organizations set require_mfa_for_admins = p_required where id = p_org_id;
end $$;
comment on function api.set_require_mfa(uuid, boolean) is
  'Owner only, and only from an aal2 session so the owner cannot lock themselves out: turns the '
  'org''s MFA requirement for owners and admins on or off. Raises not_found for a non-member, '
  'permission_denied (42501) for a member who is not the owner, mfa_required below aal2, '
  'invalid_input for null.';
revoke all on function api.set_require_mfa(uuid, boolean) from public, anon;
grant execute on function api.set_require_mfa(uuid, boolean) to authenticated;
