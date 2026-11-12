-- Extension hooks: places where a deployment that runs extra code of its own (a hosted service)
-- plugs into tenant functions without redefining them. Each hook is a private function that does
-- nothing here; the tenant function calls it at one fixed point. A deployment replaces the hook's
-- body in its own migration and never touches the tenant function, so later changes to the tenant
-- function in this repository reach it unchanged.
--
-- Contract: a hook's name, arguments and return type never change. Adding a hook is fine; changing or
-- removing one is a breaking change and needs an issue first. Migrations in this repository never
-- redefine a hook after this one, because that would overwrite a deployment's body.
--
-- No grants and no security definer: every caller is a security definer function, so a hook runs as
-- the owner. A deployment may make its body security definer if it needs to.

-- 1. The hooks

create function private.ext_entitlement(p_org_id uuid, p_key text) returns jsonb
language sql stable set search_path = '' as $$
  select null::jsonb
$$;
revoke execute on function private.ext_entitlement(uuid, text) from public;
comment on function private.ext_entitlement(uuid, text) is
  'Extension hook: an entitlement value that ranks between the org''s own override '
  '(app.org_entitlements) and the deployment default (app.entitlement_defaults), for example one '
  'that comes from a plan. Null means no value at that rank. Returns null here.';

create function private.ext_is_blocked(p_org_id uuid, p_phone_e164 text, p_email text) returns boolean
language sql stable set search_path = '' as $$
  select false
$$;
revoke execute on function private.ext_is_blocked(uuid, text, text) from public;
comment on function private.ext_is_blocked(uuid, text, text) is
  'Extension hook: true when the deployment blocks this phone or email from joining any business '
  '(a deployment-wide blocklist, separate from a business''s own app.blocked_identities). Either '
  'contact may be null. It runs on the guest join path: an error it raises must not quote the '
  'phone or email (I-13). Returns false here.';

create function private.ext_support_grant(p_org_id uuid) returns app.support_grants
language sql stable set search_path = '' as $$
  select g.* from app.support_grants g where false
$$;
revoke execute on function private.ext_support_grant(uuid) from public;
comment on function private.ext_support_grant(uuid) is
  'Extension hook: the support grant in force for the current user on p_org_id, when the '
  'deployment lets someone who is not a member act on a business''s behalf. All-null for none. '
  'private.has_role uses it for non-members only, and ignores a grant for any other org. Returns '
  'all-null here.';

-- 2. The tenant functions call them

-- redefines private.entitlement from 20261110171733_drop_hosted_schema.sql
create or replace function private.entitlement(p_org_id uuid, p_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (select o.value from app.org_entitlements o where o.org_id = p_org_id and o.key = p_key),
    private.ext_entitlement(p_org_id, p_key),
    (select d.value from app.entitlement_defaults d where d.key = p_key)
  )
$function$;

-- redefines private.is_blocked from 20261110171733_drop_hosted_schema.sql
create or replace function private.is_blocked(p_org_id uuid, p_phone_e164 text, p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  -- A deployment-wide blocklist, if the deployment has one (private.ext_is_blocked).
  return coalesce(private.ext_is_blocked(p_org_id, p_phone_e164, p_email), false);
end $function$;

-- redefines private.support_grant from 20261110171733_drop_hosted_schema.sql
create or replace function private.support_grant(p_org_id uuid)
 RETURNS app.support_grants
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- Support access exists only where the deployment provides it (private.ext_support_grant).
  select g.* from private.ext_support_grant(p_org_id) g where g.org_id = p_org_id
$function$;

comment on function private.entitlement(uuid, text) is
  'The org''s value for an entitlement key: its override in app.org_entitlements, else the '
  'deployment''s value from private.ext_entitlement (none here), else the default in '
  'app.entitlement_defaults, else null for an unknown key. The only place entitlements are resolved.';
comment on function private.is_blocked(uuid, text, text) is
  'True when the deployment blocks this contact from joining (private.ext_is_blocked; nothing is '
  'blocked here). A business''s own block list is checked separately (app.blocked_identities).';
comment on function private.support_grant(uuid) is
  'The support grant in force for the current user on p_org_id, from private.ext_support_grant: '
  'all-null here, so private.has_role decides on membership alone.';
