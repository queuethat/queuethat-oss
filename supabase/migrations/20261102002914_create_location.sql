-- #1080: api.create_location, the admin "add a location" action.
-- New entry point (interface rule 1). Alternatives: (a) a direct insert into app.locations under RLS
-- (what the wizard does for queues): rejected because the slug is printed on posters and unique, so
-- every client would re-derive it (private.unique_location_slug) and handle the race for it; (b) extend
-- api.create_organization with an existing-org mode: rejected because it would mix two verbs and change
-- a fixed signature. The plan limit and Stripe quantity sync stay in the existing location triggers.

create type api.created_location as (location_id uuid, slug text);

create function api.create_location(p_org_id uuid, p_name text, p_tz text, p_slug text default null)
returns api.created_location
language plpgsql volatile security definer set search_path = '' as $$
declare
  result api.created_location;
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text := nullif(btrim(coalesce(p_slug, '')), '');
  attempt int := 0;
  lost_to text;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- A stranger to the org and a missing org look the same; a member below admin learns why.
  if not private.has_role(p_org_id, null, 'staff') then
    raise exception 'not_found';
  end if;
  if not private.has_role(p_org_id, null, 'admin') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 120 then
    raise exception 'invalid_input';
  end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'invalid_timezone';
  end if;
  if v_slug is not null then
    if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 64 then
      raise exception 'invalid_input';
    end if;
    if exists (select 1 from app.locations where slug = v_slug)
       or exists (select 1 from app.slug_redirects where old_slug = v_slug) then
      raise exception 'slug_taken';
    end if;
  end if;

  -- unique_location_slug only sees committed rows, so a concurrent call can take the slug first.
  loop
    begin
      insert into app.locations (org_id, name, slug, tz)
      values (p_org_id, v_name, coalesce(v_slug, private.unique_location_slug(v_name)), p_tz)
      returning id, slug into result.location_id, result.slug;
      exit;
    exception when unique_violation then
      get stacked diagnostics lost_to = constraint_name;
      attempt := attempt + 1;
      if lost_to <> 'locations_slug_key' then raise; end if;
      if v_slug is not null then raise exception 'slug_taken'; end if;
      if attempt >= 5 then raise; end if;
    end;
  end loop;
  return result;
end $$;
comment on function api.create_location(uuid, text, text, text) is
  'Adds a location to the org and returns its id and slug. Callable by owners and admins. The slug '
  'is p_slug when given (lowercase letters, digits and single hyphens, at most 64) or derived from '
  'the name and made unique. The free plan''s location limit applies and the subscription quantity '
  'follows the location count. Raises not_authenticated and permission_denied (42501), not_found '
  'for an org the caller is not in, invalid_input for a blank or long name or malformed slug, '
  'invalid_timezone, slug_taken, plan_limit_reached.';
revoke all on function api.create_location(uuid, text, text, text) from public, anon;
grant execute on function api.create_location(uuid, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
