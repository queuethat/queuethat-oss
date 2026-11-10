-- #497: two api.create_organization calls with the same location name could both pick the
-- same free slug, and the second failed with a unique violation. The location insert now
-- retries with a fresh slug when it loses that race. Signature, return type and documented
-- errors are unchanged.

-- redefines api.create_organization from 20261025000200_tenancy.sql
create or replace function api.create_organization(p_name text, p_location_name text, p_tz text)
returns api.org_bootstrap
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  result api.org_bootstrap;
  attempt int := 0;
  lost_to text;
begin
  if uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- Paired displays and kiosks are auth users too; they must never become owners of anything.
  if exists (select 1 from app.devices d where d.auth_user_id = uid)
     or coalesce((select auth.jwt()) -> 'app_metadata' ->> 'kind', '') in ('display', 'kiosk') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'invalid_timezone';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 or length(btrim(coalesce(p_location_name, ''))) = 0 then
    raise exception 'invalid_input';
  end if;

  insert into app.organizations (name, created_by) values (btrim(p_name), uid)
  returning id into result.org_id;

  -- unique_location_slug only sees committed rows, so a concurrent signup can take the same slug
  -- first. Retry with a fresh one; each retry adds a random suffix, so a few attempts suffice.
  loop
    begin
      insert into app.locations (org_id, name, slug, tz)
      values (result.org_id, btrim(p_location_name), private.unique_location_slug(p_location_name),
              p_tz)
      returning id into result.location_id;
      exit;
    exception when unique_violation then
      get stacked diagnostics lost_to = constraint_name;
      attempt := attempt + 1;
      if lost_to <> 'locations_slug_key' or attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into app.memberships (org_id, user_id, role) values (result.org_id, uid, 'owner');

  return result;
end $$;
comment on function api.create_organization(text, text, text) is
  'Creates an organization, its first location and the caller''s owner membership in one '
  'transaction, and returns their ids. The location slug is derived from the location name and '
  'made unique, even when concurrent calls use the same name. Raises not_authenticated (42501) '
  'without a session, permission_denied (42501) for a paired display or kiosk, invalid_timezone '
  'when p_tz is not an IANA zone name, invalid_input for blank names.';
