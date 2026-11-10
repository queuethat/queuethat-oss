-- 4-RBAC1 (#373), part 2: assigning custom roles and reading one's own permissions.
--
-- Product default (listed on #398): admin-level permissions are not grantable to custom roles. Their
-- guards (webhooks, API keys, member management) also check the member's built-in role and
-- location scope in several helpers and policies; making a staff-based role pass them would widen
-- access in places this ticket does not test. settings.integrations stays in the catalogue for
-- built-in admins and can become grantable in a follow-up that migrates those helpers.
update private.permission_catalogue set grantable = false where permission = 'settings.integrations';

-- Why a new entry point (CLAUDE.md interface rule 1): api.set_member_role has a fixed signature and
-- is about the built-in ladder; a custom role is a separate, owner-only assignment.
create function api.set_member_custom_role(p_membership_id uuid, p_custom_role_id uuid, p_idempotency_key uuid)
returns api.membership_row
language plpgsql volatile security definer set search_path = '' as $$
declare
  m app.memberships;
  claim record;
begin
  select * into m from app.memberships where id = p_membership_id for update;
  if not found or not private.has_role(m.org_id, null, 'staff') then raise exception 'not_found'; end if;
  if not private.has_role(m.org_id, null, 'owner') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'invalid_input'; end if;
  if m.role <> 'staff' then raise exception 'forbidden_role'; end if;
  if p_custom_role_id is not null
     and not exists (select 1 from app.custom_roles r where r.id = p_custom_role_id and r.org_id = m.org_id) then
    raise exception 'not_found';
  end if;

  select * into claim from private.claim_idempotent(m.org_id, 'set_member_custom_role', p_idempotency_key);
  if claim.replay then
    return jsonb_populate_record(null::api.membership_row, claim.response);
  end if;
  update app.memberships set custom_role_id = p_custom_role_id where id = m.id returning * into m;
  perform private.save_idempotent('set_member_custom_role', p_idempotency_key, to_jsonb(private.membership_row(m)));
  return private.membership_row(m);
end $$;
comment on function api.set_member_custom_role(uuid, uuid, uuid) is
  'Gives a staff member a custom role, or removes it (null role). Owners only; the member must have the '
  'built-in role staff and the role must belong to the same org. The change is audited with actor, before '
  'and after. Raises not_found (also for another tenant or a role of another org), permission_denied, '
  'forbidden_role (member is not staff), invalid_input. Idempotent per key. Implemented by 4-RBAC1 (#373).';
revoke all on function api.set_member_custom_role(uuid, uuid, uuid) from public, anon;
grant execute on function api.set_member_custom_role(uuid, uuid, uuid) to authenticated, service_role;

-- Why a new entry point: clients render permissions and must not re-derive them from roles
-- (CLAUDE.md interface rule 2); no existing function answers per-permission questions.
create function api.my_permissions(p_org_id uuid, p_location_id uuid default null) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.permission order by c.permission), '{}')
  from private.permission_catalogue c
  where private.has_permission(p_org_id, p_location_id, c.permission)
$$;
comment on function api.my_permissions(uuid, uuid) is
  'The catalogue permissions the caller holds in the org, at the location when given (sorted). Empty for a '
  'non-member or another tenant. The console hides actions the caller lacks; the guards still enforce them. '
  'Implemented by 4-RBAC1 (#373).';
revoke all on function api.my_permissions(uuid, uuid) from public, anon;
grant execute on function api.my_permissions(uuid, uuid) to authenticated, service_role;
