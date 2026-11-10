-- 2P-PRV9 (#196): the owner's read path for a pending org deletion.
--
-- A pending org fails every private.has_role check by design (lockout), so RLS shows the owner
-- neither the org row nor the purge date. The danger zone and the admin banner need that date to
-- offer "Cancel deletion", so this one membership-checked read returns it. Interface rule 1: no
-- existing function can carry it (request_org_deletion needs the slug and is a no-op only by luck).

create function api.get_org_deletion(p_org_id uuid) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_at timestamptz;
begin
  if not exists (
       select 1 from app.memberships m where m.user_id = (select auth.uid()) and m.org_id = p_org_id and m.role = 'owner') then
    raise exception 'not_found';
  end if;
  select o.deletion_scheduled_for into v_at
  from app.organizations o where o.id = p_org_id and o.status = 'pending_deletion';
  return v_at;
end $$;
comment on function api.get_org_deletion(uuid) is
  'When the purge of a pending org is due, or null when no deletion is pending; owner only, and '
  'it still answers while the org is locked. Raises not_found for an org the caller does not own. '
  'Implemented in 2P-PRV9 (#196).';
revoke all on function api.get_org_deletion(uuid) from public, anon;
grant execute on function api.get_org_deletion(uuid) to authenticated;
