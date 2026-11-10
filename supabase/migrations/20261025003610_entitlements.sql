-- PLT6 (#412): entitlements, the one owner of "is this org allowed X" (technical-design.md 3.6,
-- interface rule 2). Phase 1 uses it for feature flags; 4-BILL3 plan limits read the same
-- resolver instead of adding a second mechanism.
--
-- Resolution order: the org's override, else its plan default (4-BILL1 adds that step inside
-- private.entitlement), else the global default, else null. Keys must exist in
-- entitlement_defaults, so a typo in an override or a check fails loudly instead of reading null.
--
-- Tenants never read these tables. Members get their orgs' resolved flags from
-- api.org_entitlements(); operators change overrides only through api.platform_set_entitlement,
-- which is audited.

------------------------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------------------------

create table app.entitlement_defaults (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value jsonb not null,
  description text not null
);

create table app.org_entitlements (
  org_id uuid not null references app.organizations (id) on delete cascade,
  key text not null references app.entitlement_defaults (key) on delete cascade,
  value jsonb not null,
  set_by uuid references auth.users (id) on delete set null,
  reason text not null check (length(trim(reason)) > 0),
  set_at timestamptz not null default now(),
  primary key (org_id, key)
);

create trigger forbid_org_change before update on app.org_entitlements
  for each row execute function private.forbid_org_change();

-- No seed defaults: phase 1 behaviour does not depend on any flag yet. Each feature that adds a
-- flag inserts its default in its own migration.

------------------------------------------------------------------------------------------------
-- Resolver
------------------------------------------------------------------------------------------------

create function private.entitlement(p_org_id uuid, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.value from app.org_entitlements o where o.org_id = p_org_id and o.key = p_key),
    -- 4-BILL1: the org's plan default goes here.
    (select d.value from app.entitlement_defaults d where d.key = p_key)
  )
$$;
comment on function private.entitlement(uuid, text) is
  'The org''s value for an entitlement key: its override, else its plan default, else the global '
  'default, else null for an unknown key. The only place entitlements are resolved.';

create function private.entitled(p_org_id uuid, p_key text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(private.entitlement(p_org_id, p_key) = 'true'::jsonb, false)
$$;
comment on function private.entitled(uuid, text) is
  'True only when the resolved entitlement is JSON true. Unknown keys and non-boolean values are '
  'false, so a missing default never switches a feature on.';

grant execute on function private.entitlement(uuid, text) to authenticated, service_role;
grant execute on function private.entitled(uuid, text) to authenticated, service_role;

------------------------------------------------------------------------------------------------
-- api.org_entitlements
------------------------------------------------------------------------------------------------

create function api.org_entitlements() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(o.id::text, (
           select coalesce(jsonb_object_agg(d.key, private.entitlement(o.id, d.key)), '{}'::jsonb)
           from app.entitlement_defaults d)), '{}'::jsonb)
  from app.organizations o
  where (select private.has_role(o.id, null, 'staff')) or (select private.is_device(o.id, null))
$$;
comment on function api.org_entitlements() is
  'Resolved entitlements for every org the caller belongs to (as a member or a paired device), '
  'as {"<org_id>": {"<key>": value}}. Every known key is present. Empty object for a caller with '
  'no org. Never shows another org''s values or override reasons.';

revoke all on function api.org_entitlements() from public, anon;
grant execute on function api.org_entitlements() to authenticated;

------------------------------------------------------------------------------------------------
-- api.platform_set_entitlement
------------------------------------------------------------------------------------------------

create function api.platform_set_entitlement(p_org_id uuid, p_key text, p_value jsonb, p_reason text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  previous jsonb;
begin
  perform private.require_platform('operator');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from app.organizations where id = p_org_id)
     or not exists (select 1 from app.entitlement_defaults where key = p_key) then
    raise exception 'not_found';
  end if;

  select value into previous from app.org_entitlements where org_id = p_org_id and key = p_key;

  if p_value is null then
    delete from app.org_entitlements where org_id = p_org_id and key = p_key;
  else
    insert into app.org_entitlements (org_id, key, value, set_by, reason)
    values (p_org_id, p_key, p_value, (select auth.uid()), p_reason)
    on conflict (org_id, key) do update
      set value = excluded.value, set_by = excluded.set_by, reason = excluded.reason, set_at = now();
  end if;

  perform private.platform_audit(
    case when p_value is null then 'entitlement.clear' else 'entitlement.set' end,
    p_org_id,
    jsonb_build_object('key', p_key, 'value', p_value, 'previous_value', previous),
    p_reason);
end $$;
comment on function api.platform_set_entitlement(uuid, text, jsonb, text) is
  'Operator only (aal2). Sets the org''s override for a known key, or clears it when p_value is '
  'null so the default applies again. Safe to repeat. Audited with the previous value. Raises '
  'permission_denied (42501), invalid_input (blank reason), not_found (unknown org or key).';

revoke all on function api.platform_set_entitlement(uuid, text, jsonb, text) from public, anon;
grant execute on function api.platform_set_entitlement(uuid, text, jsonb, text) to authenticated;

------------------------------------------------------------------------------------------------
-- Privileges and row-level security
------------------------------------------------------------------------------------------------

-- Written only by definer functions (overrides) and migrations (defaults).
revoke insert, update, delete, truncate on app.entitlement_defaults from authenticated, service_role;
revoke insert, update, delete, truncate on app.org_entitlements from authenticated, service_role;

alter table app.entitlement_defaults enable row level security;
alter table app.org_entitlements enable row level security;

create policy entitlement_defaults_select on app.entitlement_defaults for select to authenticated
  using ((select private.is_platform('support')));
create policy org_entitlements_select on app.org_entitlements for select to authenticated
  using ((select private.is_platform('support')));
